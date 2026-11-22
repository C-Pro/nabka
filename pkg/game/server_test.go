package game

import (
	"context"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/fasthttp/websocket"
	"github.com/vmihailenco/msgpack/v5"
)

// helper to start a test server
func startTestServer(t *testing.T, inactivityTimeout time.Duration) (*Server, string) {
	t.Helper()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to listen: %v", err)
	}

	cfg := ServerConfig{
		InactivityTimeout:   inactivityTimeout,
		WriteTimeout:        time.Second,
		SendBufferSize:      256,
		RegistrationTimeout: 2 * time.Second,
		AllowAllOrigins:     true,
	}

	srv := NewServer(cfg)
	if err := srv.ServeListener(ln); err != nil {
		t.Fatalf("failed to serve: %v", err)
	}

	t.Cleanup(func() {
		_ = srv.Shutdown()
	})

	wsURL := fmt.Sprintf("ws://%s/ws", ln.Addr().String())
	return srv, wsURL
}

// helper to connect a websocket client
func connectWS(t *testing.T, rawURL string) *websocket.Conn {
	t.Helper()
	dialer := websocket.Dialer{
		HandshakeTimeout: 2 * time.Second,
	}
	conn, resp, err := dialer.Dial(rawURL, nil)
	if err != nil {
		if resp != nil {
			t.Fatalf("dial error: %v, status: %d", err, resp.StatusCode)
		}
		t.Fatalf("dial error: %v", err)
	}
	return conn
}

// readNextMsg reads and decodes the next msgpack message as a map
func readNextMsg(t *testing.T, conn *websocket.Conn, timeout time.Duration) (map[string]any, error) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	msgType, payload, err := conn.ReadMessage()
	if err != nil {
		return nil, err
	}
	if msgType != websocket.BinaryMessage {
		return nil, fmt.Errorf("expected binary message, got %d", msgType)
	}

	var m map[string]any
	if err := msgpack.Unmarshal(payload, &m); err != nil {
		return nil, fmt.Errorf("msgpack unmarshal error: %w", err)
	}
	return m, nil
}

// readNextMsgSkipPolice skips periodic/baseline police_state broadcasts for non-police protocol tests.
func readNextMsgSkipPolice(t *testing.T, conn *websocket.Conn, timeout time.Duration) (map[string]any, error) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		rem := time.Until(deadline)
		if rem <= 0 {
			rem = time.Millisecond
		}
		msg, err := readNextMsg(t, conn, rem)
		if err != nil {
			return nil, err
		}
		if msg["type"] == TypePoliceState {
			continue
		}
		return msg, nil
	}
}

func sendMsgPack(t *testing.T, conn *websocket.Conn, v any) error {
	t.Helper()
	b, err := msgpack.Marshal(v)
	if err != nil {
		return err
	}
	_ = conn.SetWriteDeadline(time.Now().Add(time.Second))
	return conn.WriteMessage(websocket.BinaryMessage, b)
}

func TestJoinAndRegistrationQueryParam(t *testing.T) {
	_, baseURL := startTestServer(t, 5*time.Second)

	// User 1 connects as "alice"
	u1 := baseURL + "?username=alice"
	conn1 := connectWS(t, u1)
	defer conn1.Close()

	// Alice should receive join message for herself
	msg1, err := readNextMsgSkipPolice(t, conn1, 2*time.Second)
	if err != nil {
		t.Fatalf("alice failed to read join: %v", err)
	}
	if msg1["type"] != "join" || msg1["user"] != "alice" {
		t.Fatalf("unexpected join message: %+v", msg1)
	}

	// User 2 connects as "bob"
	u2 := baseURL + "?username=bob"
	conn2 := connectWS(t, u2)
	defer conn2.Close()

	// Bob should receive his own join message
	msgBob, err := readNextMsgSkipPolice(t, conn2, 2*time.Second)
	if err != nil {
		t.Fatalf("bob failed to read join: %v", err)
	}
	if msgBob["type"] != "join" || msgBob["user"] != "bob" {
		t.Fatalf("unexpected bob join message: %+v", msgBob)
	}

	// Alice should also receive Bob's join message
	msgAliceSawBob, err := readNextMsgSkipPolice(t, conn1, 2*time.Second)
	if err != nil {
		t.Fatalf("alice failed to read bob join: %v", err)
	}
	if msgAliceSawBob["type"] != "join" || msgAliceSawBob["user"] != "bob" {
		t.Fatalf("unexpected message seen by alice: %+v", msgAliceSawBob)
	}
}

func TestDuplicateUsernameRejected(t *testing.T) {
	_, baseURL := startTestServer(t, 5*time.Second)

	// User 1 connects as "vasya"
	u1 := baseURL + "?username=vasya"
	conn1 := connectWS(t, u1)
	defer conn1.Close()

	_, err := readNextMsg(t, conn1, time.Second)
	if err != nil {
		t.Fatalf("vasya 1 failed to join: %v", err)
	}

	// User 2 attempts to connect as "vasya" via query param
	dialer := websocket.Dialer{HandshakeTimeout: time.Second}
	conn2, _, err := dialer.Dial(u1, nil)
	if err == nil {
		// Connected, but socket must be immediately closed by server due to duplicate
		_ = conn2.SetReadDeadline(time.Now().Add(time.Second))
		_, _, readErr := conn2.ReadMessage()
		if readErr == nil {
			t.Fatal("expected duplicate connection to be closed, but was able to read")
		}
		conn2.Close()
	}

	// User 3 attempts to connect without query param and register as "vasya"
	conn3 := connectWS(t, baseURL)
	defer conn3.Close()

	err = sendMsgPack(t, conn3, map[string]any{
		"type":     "register",
		"username": "vasya",
	})
	if err != nil {
		t.Fatalf("failed to send register: %v", err)
	}

	// Socket must be closed by server due to duplicate
	_ = conn3.SetReadDeadline(time.Now().Add(time.Second))
	_, _, readErr := conn3.ReadMessage()
	if readErr == nil {
		t.Fatal("expected duplicate register message to trigger socket close")
	}
}

func TestInactivityTimeout(t *testing.T) {
	// Inactivity timeout set to 150ms for testing
	timeout := 150 * time.Millisecond
	_, baseURL := startTestServer(t, timeout)

	// Observer client
	observerConn := connectWS(t, baseURL+"?username=observer")
	defer observerConn.Close()

	// Read observer join
	_, _ = readNextMsgSkipPolice(t, observerConn, time.Second)

	// Inactive client
	inactiveConn := connectWS(t, baseURL+"?username=sleepy")
	defer inactiveConn.Close()

	// Read sleepy self-join to retrieve session token
	sleepyJoin, err := readNextMsgSkipPolice(t, inactiveConn, time.Second)
	if err != nil {
		t.Fatalf("failed to receive sleepy self-join: %v", err)
	}
	sleepyToken, _ := sleepyJoin["token"].(string)

	// Read sleepy join on observer
	_, _ = readNextMsgSkipPolice(t, observerConn, time.Second)

	// Run a background keepalive for observer so only sleepy times out
	stopKeepalive := make(chan struct{})
	defer close(stopKeepalive)
	go func() {
		ticker := time.NewTicker(40 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stopKeepalive:
				return
			case <-ticker.C:
				_ = sendMsgPack(t, observerConn, map[string]any{
					"type": "chat",
					"text": "observer ping",
				})
			}
		}
	}()

	// Read messages until we see sleepy leave
	var leaveMsg map[string]any
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		msg, err := readNextMsgSkipPolice(t, observerConn, time.Second)
		if err != nil {
			t.Fatalf("failed to receive leave message: %v", err)
		}
		if msg["type"] == "leave" && msg["user"] == "sleepy" {
			leaveMsg = msg
			break
		}
	}
	if leaveMsg == nil {
		t.Fatal("did not receive leave message for sleepy before deadline")
	}
	if leaveMsg["type"] != "leave" {
		t.Fatalf("expected type leave, got %v", leaveMsg["type"])
	}
	if leaveMsg["user"] != "sleepy" {
		t.Fatalf("expected user sleepy, got %v", leaveMsg["user"])
	}
	if leaveMsg["reason"] != "kicked for 30s inactivity" {
		t.Fatalf("expected reason 'kicked for 30s inactivity', got %q", leaveMsg["reason"])
	}

	// Verify sleepy can reconnect with session token
	reconnectConn := connectWS(t, fmt.Sprintf("%s?username=sleepy&token=%s", baseURL, sleepyToken))
	defer reconnectConn.Close()

	joinMsg, err := readNextMsg(t, reconnectConn, time.Second)
	if err != nil {
		t.Fatalf("reconnected sleepy failed to receive join: %v", err)
	}
	if joinMsg["type"] != "join" || joinMsg["user"] != "sleepy" {
		t.Fatalf("unexpected reconnect join: %+v", joinMsg)
	}
}

func TestPingKeepalive(t *testing.T) {
	timeout := 150 * time.Millisecond
	_, baseURL := startTestServer(t, timeout)

	conn := connectWS(t, baseURL+"?username=pinger")
	defer conn.Close()

	joinMsg, err := readNextMsgSkipPolice(t, conn, time.Second)
	if err != nil || joinMsg["type"] != "join" {
		t.Fatalf("expected join, got %v (err %v)", joinMsg, err)
	}

	for i := 0; i < 7; i++ {
		time.Sleep(50 * time.Millisecond)
		if err := sendMsgPack(t, conn, map[string]any{"type": "ping"}); err != nil {
			t.Fatalf("failed to send ping: %v", err)
		}
		pongMsg, err := readNextMsgSkipPolice(t, conn, time.Second)
		if err != nil {
			t.Fatalf("failed to receive pong on ping %d: %v", i, err)
		}
		if pongMsg["type"] != "pong" {
			t.Fatalf("expected type pong, got %+v", pongMsg)
		}
	}
}

func TestNormalDisconnect(t *testing.T) {
	_, baseURL := startTestServer(t, 5*time.Second)

	observer := connectWS(t, baseURL+"?username=observer")
	defer observer.Close()
	_, _ = readNextMsgSkipPolice(t, observer, time.Second)

	leaver := connectWS(t, baseURL+"?username=quitter")
	_, _ = readNextMsgSkipPolice(t, observer, time.Second)

	// Close quitter socket cleanly
	leaver.Close()

	leaveMsg, err := readNextMsgSkipPolice(t, observer, 2*time.Second)
	if err != nil {
		t.Fatalf("failed to receive leave: %v", err)
	}
	if leaveMsg["type"] != "leave" || leaveMsg["user"] != "quitter" {
		t.Fatalf("unexpected leave msg: %+v", leaveMsg)
	}
	if leaveMsg["reason"] != "left" {
		t.Fatalf("expected reason 'left', got %q", leaveMsg["reason"])
	}
}

func TestPedestrianMovement(t *testing.T) {
	_, baseURL := startTestServer(t, 5*time.Second)

	p1 := connectWS(t, baseURL+"?username=vasya")
	defer p1.Close()
	_, _ = readNextMsgSkipPolice(t, p1, time.Second)

	p2 := connectWS(t, baseURL+"?username=kolya")
	defer p2.Close()
	_, _ = readNextMsgSkipPolice(t, p2, time.Second)
	// p1 reads p2 join
	_, _ = readNextMsgSkipPolice(t, p1, time.Second)

	// Vasya sends pedestrian movement
	// {"type":"move","mode":"pedestrian","x":0.5,"y":0.0,"z":18.2,"vx":0.0,"vz":8.2,"yaw":3.14,"anim":"run"}
	move := map[string]any{
		"type": "move",
		"mode": "pedestrian",
		"x":    0.5,
		"y":    0.0,
		"z":    18.2,
		"vx":   0.0,
		"vz":   8.2,
		"yaw":  3.14,
		"anim": "run",
	}
	if err := sendMsgPack(t, p1, move); err != nil {
		t.Fatalf("failed to send move: %v", err)
	}

	// Kolya receives movement
	received, err := readNextMsgSkipPolice(t, p2, time.Second)
	if err != nil {
		t.Fatalf("kolya failed to receive move: %v", err)
	}

	if received["username"] != "vasya" {
		t.Fatalf("expected username vasya, got %v", received["username"])
	}
	if received["type"] != "move" || received["mode"] != "pedestrian" {
		t.Fatalf("unexpected type/mode: %+v", received)
	}
	if received["anim"] != "run" {
		t.Fatalf("expected anim run, got %v", received["anim"])
	}

	// Vasya should NOT receive his own movement
	deadline := time.Now().Add(60 * time.Millisecond)
	for time.Now().Before(deadline) {
		msg, err := readNextMsg(t, p1, time.Until(deadline))
		if err != nil {
			break
		}
		if msg["type"] != TypePoliceState {
			t.Fatalf("vasya should not receive his own movement update, got: %+v", msg)
		}
	}
}

func TestDrivingMovement(t *testing.T) {
	_, baseURL := startTestServer(t, 5*time.Second)

	driver := connectWS(t, baseURL+"?username=vasya")
	defer driver.Close()
	_, _ = readNextMsgSkipPolice(t, driver, time.Second)

	spectator := connectWS(t, baseURL+"?username=spectator")
	defer spectator.Close()
	_, _ = readNextMsgSkipPolice(t, spectator, time.Second)
	_, _ = readNextMsgSkipPolice(t, driver, time.Second)

	// Driving message:
	// {"type":"move","mode":"driving","car_id":"car_0","x":19.5,"y":0.02,"z":14.0,"speed":22.4,"yaw":1.57,"drift":true,"lights":true}
	drive := map[string]any{
		"type":   "move",
		"mode":   "driving",
		"car_id": "car_0",
		"x":      19.5,
		"y":      0.02,
		"z":      14.0,
		"speed":  22.4,
		"yaw":    1.57,
		"drift":  true,
		"lights": true,
	}
	if err := sendMsgPack(t, driver, drive); err != nil {
		t.Fatalf("failed to send driving move: %v", err)
	}

	received, err := readNextMsgSkipPolice(t, spectator, time.Second)
	if err != nil {
		t.Fatalf("spectator failed to read driving move: %v", err)
	}

	if received["username"] != "vasya" {
		t.Fatalf("expected username vasya, got %v", received["username"])
	}
	if received["mode"] != "driving" || received["car_id"] != "car_0" {
		t.Fatalf("unexpected driving data: %+v", received)
	}
	if received["drift"] != true || received["lights"] != true {
		t.Fatalf("expected drift and lights true: %+v", received)
	}
}

func TestChatMessage(t *testing.T) {
	_, baseURL := startTestServer(t, 5*time.Second)

	p1 := connectWS(t, baseURL+"?username=vasya")
	defer p1.Close()
	_, _ = readNextMsgSkipPolice(t, p1, time.Second)

	p2 := connectWS(t, baseURL+"?username=kolya")
	defer p2.Close()
	_, _ = readNextMsgSkipPolice(t, p2, time.Second)
	_, _ = readNextMsgSkipPolice(t, p1, time.Second)

	// Vasya sends chat
	// {"type":"chat","text":"Го дрифтить у фонтана!"}
	chat := map[string]any{
		"type": "chat",
		"text": "Го дрифтить у фонтана!",
	}
	if err := sendMsgPack(t, p1, chat); err != nil {
		t.Fatalf("failed to send chat: %v", err)
	}

	// Kolya receives chat
	msgKolya, err := readNextMsgSkipPolice(t, p2, time.Second)
	if err != nil {
		t.Fatalf("kolya failed to read chat: %v", err)
	}
	if msgKolya["type"] != "chat" || msgKolya["username"] != "vasya" || msgKolya["from"] != "vasya" {
		t.Fatalf("unexpected chat message for kolya: %+v", msgKolya)
	}
	if msgKolya["text"] != "Го дрифтить у фонтана!" {
		t.Fatalf("unexpected text: %v", msgKolya["text"])
	}

	// Vasya ALSO receives his own chat (for display in chat and speech bubbles)
	msgVasya, err := readNextMsgSkipPolice(t, p1, time.Second)
	if err != nil {
		t.Fatalf("vasya failed to read chat: %v", err)
	}
	if msgVasya["type"] != "chat" || msgVasya["username"] != "vasya" || msgVasya["from"] != "vasya" {
		t.Fatalf("unexpected chat message for vasya: %+v", msgVasya)
	}
}

func TestDisallowSpoofedUsername(t *testing.T) {
	_, baseURL := startTestServer(t, 5*time.Second)

	alice := connectWS(t, baseURL+"?username=alice")
	defer alice.Close()
	_, _ = readNextMsgSkipPolice(t, alice, time.Second)

	bob := connectWS(t, baseURL+"?username=bob")
	defer bob.Close()
	_, _ = readNextMsgSkipPolice(t, bob, time.Second)
	_, _ = readNextMsgSkipPolice(t, alice, time.Second)

	// Alice maliciously tries to send chat claiming to be "admin" or "bob"
	spoofedChat := map[string]any{
		"type":     "chat",
		"username": "admin",
		"text":     "I am admin",
	}
	if err := sendMsgPack(t, alice, spoofedChat); err != nil {
		t.Fatalf("failed to send spoofed chat: %v", err)
	}

	// Bob must receive chat with verified username and from = "alice"
	received, err := readNextMsgSkipPolice(t, bob, time.Second)
	if err != nil {
		t.Fatalf("bob failed to receive chat: %v", err)
	}
	if received["username"] != "alice" || received["from"] != "alice" {
		t.Fatalf("server permitted username spoofing! received: %+v", received)
	}
}

func TestConcurrentHighFrequencyMovement(t *testing.T) {
	_, baseURL := startTestServer(t, 10*time.Second)

	const numClients = 5
	const numMessages = 20 // 20 updates per client

	conns := make([]*websocket.Conn, numClients)
	usernames := make([]string, numClients)
	for i := 0; i < numClients; i++ {
		usernames[i] = fmt.Sprintf("player_%d", i)
		conns[i] = connectWS(t, baseURL+"?username="+url.QueryEscape(usernames[i]))
		defer conns[i].Close()
	}

	// Each client expects to receive movements from all OTHER clients:
	// expected per client = (numClients - 1) * numMessages
	expectedPerClient := (numClients - 1) * numMessages

	var readWg sync.WaitGroup
	var receivedMovements [numClients]int64
	var mu sync.Mutex

	// Synchronize join confirmation for every client before sending moves
	joinsConfirmed := make([]chan struct{}, numClients)
	for i := 0; i < numClients; i++ {
		joinsConfirmed[i] = make(chan struct{})
	}

	for i := 0; i < numClients; i++ {
		readWg.Add(1)
		go func(idx int) {
			defer readWg.Done()
			c := conns[idx]
			selfName := usernames[idx]

			// Set a single generous read deadline for the test
			_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))

			for {
				msgType, payload, err := c.ReadMessage()
				if err != nil {
					return
				}
				if msgType != websocket.BinaryMessage {
					continue
				}
				var m map[string]any
				if err := msgpack.Unmarshal(payload, &m); err != nil {
					continue
				}

				if m["type"] == "join" {
					if m["user"] == selfName {
						select {
						case <-joinsConfirmed[idx]:
						default:
							close(joinsConfirmed[idx])
						}
					}
					continue
				}

				if m["type"] == "move" {
					// Verify sender exclusion: client must NEVER receive its own movement
					sender := m["username"].(string)
					if sender == selfName {
						t.Errorf("client %s received its own movement update!", selfName)
					}
					mu.Lock()
					receivedMovements[idx]++
					mu.Unlock()
				}
			}
		}(i)
	}

	// Wait for every client to receive its own join
	for i := 0; i < numClients; i++ {
		select {
		case <-joinsConfirmed[i]:
		case <-time.After(2 * time.Second):
			t.Fatalf("client %d (%s) timed out waiting for join confirmation", i, usernames[i])
		}
	}

	// Concurrently send movement updates
	var sendWg sync.WaitGroup
	for i := 0; i < numClients; i++ {
		sendWg.Add(1)
		go func(idx int) {
			defer sendWg.Done()
			c := conns[idx]
			for m := 0; m < numMessages; m++ {
				move := map[string]any{
					"type": "move",
					"mode": "pedestrian",
					"x":    float64(idx) + float64(m)*0.1,
					"y":    0.0,
					"z":    10.0,
					"vx":   1.0,
					"vz":   0.0,
					"yaw":  1.57,
					"anim": "run",
				}
				if err := sendMsgPack(t, c, move); err != nil {
					t.Errorf("failed to send move from player %d: %v", idx, err)
				}
				time.Sleep(500 * time.Microsecond)
			}
		}(i)
	}

	sendWg.Wait()

	// Wait for readers to collect all movements
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		allDone := true
		for i := 0; i < numClients; i++ {
			if receivedMovements[i] < int64(expectedPerClient) {
				allDone = false
				break
			}
		}
		mu.Unlock()
		if allDone {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Close all connections to unblock reader goroutines cleanly
	for i := 0; i < numClients; i++ {
		_ = conns[i].Close()
	}
	readWg.Wait()

	// Assertions
	mu.Lock()
	defer mu.Unlock()
	for i := 0; i < numClients; i++ {
		if receivedMovements[i] != int64(expectedPerClient) {
			t.Fatalf("client %d (%s) expected %d movements, got %d",
				i, usernames[i], expectedPerClient, receivedMovements[i])
		}
	}
}

func TestMalformedMessageHandling(t *testing.T) {
	_, baseURL := startTestServer(t, 5*time.Second)

	client := connectWS(t, baseURL+"?username=tester")
	defer client.Close()
	_, _ = readNextMsgSkipPolice(t, client, time.Second)

	// Send invalid msgpack data
	_ = client.SetWriteDeadline(time.Now().Add(time.Second))
	_ = client.WriteMessage(websocket.BinaryMessage, []byte{0xc1, 0x99, 0xff}) // invalid msgpack

	// Client should receive an error message back
	errResp, err := readNextMsgSkipPolice(t, client, time.Second)
	if err != nil {
		t.Fatalf("expected error message from server, got err: %v", err)
	}
	if errResp["type"] != "error" {
		t.Fatalf("expected error type, got %+v", errResp)
	}

	// Connection should still remain alive after recoverable malformed message
	chat := map[string]any{
		"type": "chat",
		"text": "still alive!",
	}
	if err := sendMsgPack(t, client, chat); err != nil {
		t.Fatalf("failed to send chat after malformed msg: %v", err)
	}
	chatEcho, err := readNextMsgSkipPolice(t, client, time.Second)
	if err != nil {
		t.Fatalf("failed to read chat echo: %v", err)
	}
	if chatEcho["text"] != "still alive!" {
		t.Fatalf("unexpected echo text: %+v", chatEcho)
	}
}

func TestSlowConsumerEviction(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	hub := NewHub(ctx)
	defer hub.Stop()
	hub.SetSimAutoTick(false)

	// Client with tight buffer (join + police_state baseline = 2 slots)
	c1 := &Client{
		Username: "fast",
		send:     make(chan []byte, 16),
	}
	c2 := &Client{
		Username: "slow",
		send:     make(chan []byte, 2),
	}

	if !hub.Register(c1) {
		t.Fatal("failed to register c1")
	}
	if !hub.Register(c2) {
		t.Fatal("failed to register c2")
	}

	readNonPoliceFromChan := func(ch <-chan []byte) []byte {
		for {
			b := <-ch
			var m map[string]any
			if err := msgpack.Unmarshal(b, &m); err == nil && m["type"] == TypePoliceState {
				continue
			}
			return b
		}
	}

	// Drain join messages from c1
	readNonPoliceFromChan(c1.send) // c1 join
	readNonPoliceFromChan(c1.send) // c2 join

	// Give c2 a driving move before it gets evicted
	hub.BroadcastDrivingMove(c2, &OutboundDrivingMoveMsg{
		Username: "slow",
		Type:     TypeMove,
		Mode:     ModeDriving,
		CarID:    "car_1",
		X:        10,
		Y:        0,
		Z:        10,
	}, []byte("car_move"))

	// Drain messages
	readNonPoliceFromChan(c1.send) // car_move

	// Now broadcast message from c1 to trigger eviction of c2
	hub.Broadcast(c1, false, []byte("message 1"))

	// c1 should receive its own broadcast, followed by a leave event for c2 with reason "slow consumer"
	readNonPoliceFromChan(c1.send) // message 1
	leaveData := readNonPoliceFromChan(c1.send)

	var leaveMsg map[string]any
	if err := msgpack.Unmarshal(leaveData, &leaveMsg); err != nil {
		t.Fatalf("failed to decode leave msg: %v", err)
	}

	if leaveMsg["type"] != "leave" || leaveMsg["user"] != "slow" || leaveMsg["reason"] != "slow consumer" {
		t.Fatalf("unexpected leave msg for slow consumer: %+v", leaveMsg)
	}

	// Verify world state cleanup: car_1 must be parked and user "slow" must be deleted
	snap := hub.Snapshot()
	if _, userExists := snap.Users["slow"]; userExists {
		t.Fatalf("expected user 'slow' to be cleaned up after slow consumer eviction")
	}
	if car1, carExists := snap.Cars["car_1"]; !carExists || car1.Driver != "" {
		t.Fatalf("expected car_1 to be parked with empty driver, got %+v", car1)
	}
}

func TestStaticFileServing_DefaultEmbedded(t *testing.T) {
	srv, _ := startTestServer(t, 30*time.Second)
	addr := srv.Addr().String()
	baseURL := fmt.Sprintf("http://%s", addr)

	client := &http.Client{Timeout: 3 * time.Second}

	// 1. GET / serves index.html
	resp, err := client.Get(baseURL + "/")
	if err != nil {
		t.Fatalf("GET / failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK for /, got %d", resp.StatusCode)
	}
	contentType := resp.Header.Get("Content-Type")
	if !strings.Contains(contentType, "text/html") {
		t.Fatalf("expected Content-Type text/html, got %q", contentType)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("failed to read body: %v", err)
	}
	if !strings.Contains(string(body), "<!DOCTYPE html>") {
		t.Fatalf("body does not contain DOCTYPE html")
	}
	if !strings.Contains(string(body), "<title>Набка</title>") {
		t.Fatalf("body does not contain expected title")
	}

	// 2. GET /index.html directly
	resp2, err := client.Get(baseURL + "/index.html")
	if err != nil {
		t.Fatalf("GET /index.html failed: %v", err)
	}
	defer resp2.Body.Close()

	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK for /index.html, got %d", resp2.StatusCode)
	}

	// 3. HEAD /
	respHead, err := client.Head(baseURL + "/")
	if err != nil {
		t.Fatalf("HEAD / failed: %v", err)
	}
	defer respHead.Body.Close()

	if respHead.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK for HEAD /, got %d", respHead.StatusCode)
	}
	headBody, _ := io.ReadAll(respHead.Body)
	if len(headBody) != 0 {
		t.Fatalf("expected empty body for HEAD /, got %d bytes", len(headBody))
	}

	// 4. GET nonexistent file
	resp404, err := client.Get(baseURL + "/nonexistent-file.xyz")
	if err != nil {
		t.Fatalf("GET nonexistent failed: %v", err)
	}
	defer resp404.Body.Close()
	if resp404.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for nonexistent, got %d", resp404.StatusCode)
	}

	// 5. Byte Range request
	req, err := http.NewRequest("GET", baseURL+"/index.html", nil)
	if err != nil {
		t.Fatalf("failed to create range request: %v", err)
	}
	req.Header.Set("Range", "bytes=0-14")
	respRange, err := client.Do(req)
	if err != nil {
		t.Fatalf("Range request failed: %v", err)
	}
	defer respRange.Body.Close()
	if respRange.StatusCode != http.StatusPartialContent {
		t.Fatalf("expected 206 Partial Content, got %d", respRange.StatusCode)
	}
	rangeBytes, err := io.ReadAll(respRange.Body)
	if err != nil {
		t.Fatalf("failed to read range body: %v", err)
	}
	if string(rangeBytes) != "<!DOCTYPE html>" {
		t.Fatalf("expected '<!DOCTYPE html>', got %q", string(rangeBytes))
	}
}

func TestStaticFileServing_CustomAndDisabled(t *testing.T) {
	// 1. Custom StaticFS
	t.Run("CustomFS", func(t *testing.T) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("failed to listen: %v", err)
		}

		mockFS := fstest.MapFS{
			"index.html": &fstest.MapFile{
				Data: []byte("<h1>Custom Nabka</h1>"),
			},
			"js/app.js": &fstest.MapFile{
				Data: []byte("console.log('custom');"),
			},
		}

		cfg := ServerConfig{
			Addr:          ln.Addr().String(),
			StaticFS:      mockFS,
			DisableStatic: false,
		}
		srv := NewServer(cfg)
		if err := srv.ServeListener(ln); err != nil {
			t.Fatalf("failed to serve: %v", err)
		}
		defer func() { _ = srv.Shutdown() }()

		baseURL := fmt.Sprintf("http://%s", ln.Addr().String())
		client := &http.Client{Timeout: 3 * time.Second}

		resp, err := client.Get(baseURL + "/")
		if err != nil {
			t.Fatalf("GET / failed: %v", err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if string(body) != "<h1>Custom Nabka</h1>" {
			t.Fatalf("expected custom html, got %q", string(body))
		}

		respJS, err := client.Get(baseURL + "/js/app.js")
		if err != nil {
			t.Fatalf("GET /js/app.js failed: %v", err)
		}
		defer respJS.Body.Close()
		bodyJS, _ := io.ReadAll(respJS.Body)
		if string(bodyJS) != "console.log('custom');" {
			t.Fatalf("expected custom js, got %q", string(bodyJS))
		}
	})

	// 2. Disabled Static
	t.Run("DisabledStatic", func(t *testing.T) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("failed to listen: %v", err)
		}

		cfg := ServerConfig{
			Addr:          ln.Addr().String(),
			DisableStatic: true,
		}
		srv := NewServer(cfg)
		if err := srv.ServeListener(ln); err != nil {
			t.Fatalf("failed to serve: %v", err)
		}
		defer func() { _ = srv.Shutdown() }()

		baseURL := fmt.Sprintf("http://%s", ln.Addr().String())
		client := &http.Client{Timeout: 3 * time.Second}

		resp, err := client.Get(baseURL + "/")
		if err != nil {
			t.Fatalf("GET / failed: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("expected 404 when static is disabled, got %d", resp.StatusCode)
		}
	})
}

func TestNewlyJoinedClientReceivesCarAndUserPositions(t *testing.T) {
	srv, wsURL := startTestServer(t, 30*time.Second)

	// 1. Alice connects
	aliceConn := connectWS(t, wsURL+"?username=alice")
	defer aliceConn.Close()

	joinAlice, err := readNextMsgSkipPolice(t, aliceConn, 2*time.Second)
	if err != nil {
		t.Fatalf("failed reading alice join: %v", err)
	}
	if joinAlice["type"] != TypeJoin || joinAlice["user"] != "alice" {
		t.Fatalf("unexpected join for alice: %+v", joinAlice)
	}

	// 2. Alice drives car_0
	xCar, yCar, zCar := 42.5, 0.02, 99.0
	speedCar, yawCar := 15.0, 1.57
	driftCar, lightsCar := true, true
	carID := "car_0"

	drivePayload, _ := msgpack.Marshal(InboundDrivingMoveMsg{
		Type:   TypeMove,
		Mode:   ModeDriving,
		CarID:  &carID,
		X:      &xCar,
		Y:      &yCar,
		Z:      &zCar,
		Speed:  &speedCar,
		Yaw:    &yawCar,
		Drift:  &driftCar,
		Lights: &lightsCar,
	})
	if err := aliceConn.WriteMessage(websocket.BinaryMessage, drivePayload); err != nil {
		t.Fatalf("alice failed sending driving move: %v", err)
	}

	// Wait briefly for Hub to process
	time.Sleep(20 * time.Millisecond)

	// Check hub snapshot
	snap1 := srv.Hub().Snapshot()
	car0, exists := snap1.Cars["car_0"]
	if !exists {
		t.Fatalf("expected car_0 in snapshot")
	}
	if car0.X != xCar || car0.Z != zCar || car0.Driver != "alice" {
		t.Fatalf("unexpected car_0 state: %+v", car0)
	}

	// 3. Alice parks car_0 and walks
	xPed, yPed, zPed := 40.0, 0.0, 98.0
	vxPed, vzPed := 0.0, 1.2
	yawPed := 3.14
	animPed := AnimWalk

	pedPayload, _ := msgpack.Marshal(InboundPedestrianMoveMsg{
		Type: TypeMove,
		Mode: ModePedestrian,
		X:    &xPed,
		Y:    &yPed,
		Z:    &zPed,
		VX:   &vxPed,
		VZ:   &vzPed,
		Yaw:  &yawPed,
		Anim: &animPed,
	})
	if err := aliceConn.WriteMessage(websocket.BinaryMessage, pedPayload); err != nil {
		t.Fatalf("alice failed sending pedestrian move: %v", err)
	}

	time.Sleep(20 * time.Millisecond)

	// Alice receives authoritative confirmation of car_0 transition to parked
	aliceParkedMsg, err := readNextMsgSkipPolice(t, aliceConn, 2*time.Second)
	if err != nil {
		t.Fatalf("alice failed reading parked car msg: %v", err)
	}
	if aliceParkedMsg["type"] != TypeMove || aliceParkedMsg["mode"] != ModeDriving || aliceParkedMsg["car_id"] != "car_0" {
		t.Fatalf("expected parked car_0 message for alice, got: %+v", aliceParkedMsg)
	}
	if aliceParkedMsg["username"] != "" || aliceParkedMsg["speed"] != float64(0) {
		t.Fatalf("expected parked car_0 with empty driver and 0 speed, got: %+v", aliceParkedMsg)
	}

	snap2 := srv.Hub().Snapshot()
	car0Parked := snap2.Cars["car_0"]
	if car0Parked.Driver != "" {
		t.Fatalf("expected car_0 driver to be empty after alice exited, got %q", car0Parked.Driver)
	}
	if car0Parked.X != xCar || car0Parked.Z != zCar {
		t.Fatalf("expected car_0 to remain parked at (%.2f, %.2f), got (%.2f, %.2f)", xCar, zCar, car0Parked.X, car0Parked.Z)
	}
	aliceUser, userExists := snap2.Users["alice"]
	if !userExists || aliceUser.Mode != ModePedestrian || aliceUser.X != xPed {
		t.Fatalf("unexpected alice user state: %+v", aliceUser)
	}

	// 4. Bob joins now! Bob should immediately receive:
	// a) Bob's own join message
	// b) car_0's parked position
	// c) alice's pedestrian position
	bobConn := connectWS(t, wsURL+"?username=bob")
	defer bobConn.Close()

	// Alice sees bob join
	aliceSawBob, err := readNextMsgSkipPolice(t, aliceConn, 2*time.Second)
	if err != nil {
		t.Fatalf("alice failed reading bob join: %v", err)
	}
	if aliceSawBob["type"] != TypeJoin || aliceSawBob["user"] != "bob" {
		t.Fatalf("unexpected join saw by alice: %+v", aliceSawBob)
	}

	// Bob receives messages
	msg1, err := readNextMsgSkipPolice(t, bobConn, 2*time.Second)
	if err != nil {
		t.Fatalf("bob failed reading msg1: %v", err)
	}
	if msg1["type"] != TypeJoin || msg1["user"] != "bob" {
		t.Fatalf("expected bob join as first message, got: %+v", msg1)
	}

	// Collect remaining sync messages
	receivedCar0 := false
	receivedAlice := false

	for i := 0; i < 2; i++ {
		syncMsg, err := readNextMsgSkipPolice(t, bobConn, 2*time.Second)
		if err != nil {
			t.Fatalf("bob failed reading sync msg %d: %v", i, err)
		}
		if syncMsg["type"] == TypeMove {
			if syncMsg["mode"] == ModeDriving && syncMsg["car_id"] == "car_0" {
				receivedCar0 = true
				if syncMsg["x"] != xCar || syncMsg["z"] != zCar {
					t.Fatalf("bob received incorrect car_0 coordinates: %+v", syncMsg)
				}
				if syncMsg["username"] != "" {
					t.Fatalf("expected parked car to have empty driver, got %v", syncMsg["username"])
				}
			} else if syncMsg["mode"] == ModePedestrian && syncMsg["username"] == "alice" {
				receivedAlice = true
				if syncMsg["x"] != xPed || syncMsg["z"] != zPed || syncMsg["anim"] != AnimWalk {
					t.Fatalf("bob received incorrect alice pedestrian state: %+v", syncMsg)
				}
			}
		}
	}

	if !receivedCar0 {
		t.Fatalf("bob did not receive last seen position of car_0")
	}
	if !receivedAlice {
		t.Fatalf("bob did not receive last seen position of alice")
	}

	// 5. Alice disconnects
	_ = aliceConn.Close()

	// Bob sees alice leave
	leaveAlice, err := readNextMsgSkipPolice(t, bobConn, 2*time.Second)
	if err != nil {
		t.Fatalf("bob failed reading alice leave: %v", err)
	}
	if leaveAlice["type"] != TypeLeave || leaveAlice["user"] != "alice" {
		t.Fatalf("unexpected leave msg for alice: %+v", leaveAlice)
	}

	// 6. Charlie joins after Alice disconnected
	// Charlie should receive:
	// a) Charlie's own join
	// b) car_0's parked position (persisted!)
	// c) NO message for alice (since alice left)
	charlieConn := connectWS(t, wsURL+"?username=charlie")
	defer charlieConn.Close()

	charlieMsg1, err := readNextMsgSkipPolice(t, charlieConn, 2*time.Second)
	if err != nil {
		t.Fatalf("charlie failed reading msg1: %v", err)
	}
	if charlieMsg1["type"] != TypeJoin || charlieMsg1["user"] != "charlie" {
		t.Fatalf("expected charlie join, got: %+v", charlieMsg1)
	}

	charlieCarMsg, err := readNextMsgSkipPolice(t, charlieConn, 2*time.Second)
	if err != nil {
		t.Fatalf("charlie failed reading car msg: %v", err)
	}
	if charlieCarMsg["type"] != TypeMove || charlieCarMsg["mode"] != ModeDriving || charlieCarMsg["car_id"] != "car_0" {
		t.Fatalf("expected car_0 driving move for charlie, got: %+v", charlieCarMsg)
	}
	if charlieCarMsg["x"] != xCar || charlieCarMsg["z"] != zCar {
		t.Fatalf("charlie received incorrect car_0 coordinates: %+v", charlieCarMsg)
	}
}

func TestEmbeddedModularStaticAssetsHTTP(t *testing.T) {
	// Close this test's HTTP keep-alives before server shutdown.
	transport := &http.Transport{DisableKeepAlives: true}
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	t.Cleanup(transport.CloseIdleConnections)
	_, wsURL := startTestServer(t, 5*time.Second)
	httpBase := strings.TrimSuffix(strings.Replace(wsURL, "ws://", "http://", 1), "/ws")

	paths := []struct {
		path        string
		wantContain string
	}{
		{"/", `<script type="module" src="js/main.js"`},
		{"/css/main.css", ".hud-glass"},
		{"/css/tailwind.css", "tailwindcss"},
		{"/js/main.js", "loadGameData"},
		{"/js/msgpack.js", "MsgPackCodec"},
		{"/js/physics.js", "PhysicsEngine"},
		{"/js/vehicle-motion.js", "VehicleSnapshotBuffer"},
		{"/data/world_map.json", "landmarks"},
		{"/data/npc_dialogues.json", "Дэн с Зелёнки"},
		{"/favicon.svg", `<svg xmlns="http://www.w3.org/2000/svg"`},
		{"/sw.js", `self.registration.unregister`},
		{"/api/version", `"version"`},
	}

	for _, tc := range paths {
		resp, err := client.Get(httpBase + tc.path)
		if err != nil {
			t.Fatalf("GET %s failed: %v", tc.path, err)
		}
		body, err := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if err != nil {
			t.Fatalf("reading body for %s failed: %v", tc.path, err)
		}
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s status = %d, want 200", tc.path, resp.StatusCode)
		}
		if !strings.Contains(string(body), tc.wantContain) {
			t.Fatalf("GET %s body did not contain %q", tc.path, tc.wantContain)
		}

		// Verify anti-caching headers
		cacheCtrl := resp.Header.Get("Cache-Control")
		if !strings.Contains(cacheCtrl, "no-store") || !strings.Contains(cacheCtrl, "no-cache") {
			t.Fatalf("GET %s expected Cache-Control with no-cache and no-store, got %q", tc.path, cacheCtrl)
		}
		if lastMod := resp.Header.Get("Last-Modified"); lastMod != "" {
			t.Fatalf("GET %s expected Last-Modified to be stripped, got %q", tc.path, lastMod)
		}
		if etag := resp.Header.Get("ETag"); etag != "" {
			t.Fatalf("GET %s expected ETag to be stripped, got %q", tc.path, etag)
		}
	}

	// Test favicon.ico specifically for 200 OK and binary content
	respIco, err := client.Get(httpBase + "/favicon.ico")
	if err != nil {
		t.Fatalf("GET /favicon.ico failed: %v", err)
	}
	defer respIco.Body.Close()
	if respIco.StatusCode != http.StatusOK {
		t.Fatalf("GET /favicon.ico status = %d, want 200", respIco.StatusCode)
	}
	if ct := respIco.Header.Get("Content-Type"); ct != "image/x-icon" {
		t.Fatalf("GET /favicon.ico Content-Type = %q, want image/x-icon", ct)
	}

	// Test audio mp3 files for 200 OK and audio/mpeg Content-Type
	for _, audioPath := range []string{
		"/audio/nabka_ambience.mp3",
		"/audio/ch1.mp3",
		"/audio/roadster_start.mp3",
		"/audio/roadster_idle.mp3",
		"/audio/roadster_driving.mp3",
		"/audio/drift1.mp3",
		"/audio/cannon.mp3",
	} {
		respAudio, err := client.Get(httpBase + audioPath)
		if err != nil {
			t.Fatalf("GET %s failed: %v", audioPath, err)
		}
		if respAudio.StatusCode != http.StatusOK {
			_ = respAudio.Body.Close()
			t.Fatalf("GET %s status = %d, want 200", audioPath, respAudio.StatusCode)
		}
		if ct := respAudio.Header.Get("Content-Type"); ct != "audio/mpeg" {
			_ = respAudio.Body.Close()
			t.Fatalf("GET %s Content-Type = %q, want audio/mpeg", audioPath, ct)
		}
		_ = respAudio.Body.Close()
	}

	resp404, err := client.Get(httpBase + "/js/does-not-exist.js")
	if err != nil {
		t.Fatalf("GET missing path failed: %v", err)
	}
	_ = resp404.Body.Close()
	if resp404.StatusCode != http.StatusNotFound {
		t.Fatalf("GET missing path status = %d, want 404", resp404.StatusCode)
	}
}

func TestHub_VehicleOccupancyAndValidation(t *testing.T) {
	srv, wsURL := startTestServer(t, 30*time.Second)
	srv.Hub().SetSimAutoTick(false)

	aliceConn := connectWS(t, wsURL+"?username=alice")
	defer aliceConn.Close()
	_, _ = readNextMsgSkipPolice(t, aliceConn, 2*time.Second)

	bobConn := connectWS(t, wsURL+"?username=bob")
	defer bobConn.Close()
	_, _ = readNextMsgSkipPolice(t, bobConn, 2*time.Second)
	_, _ = readNextMsgSkipPolice(t, aliceConn, 2*time.Second)

	// 1. Alice drives car_0
	car0ID := "car_0"
	x, y, z := 10.0, 0.02, 20.0
	speed, yaw := 12.0, 1.57
	drift, lights := false, true
	drivePayload, _ := msgpack.Marshal(InboundDrivingMoveMsg{
		Type:   TypeMove,
		Mode:   ModeDriving,
		CarID:  &car0ID,
		X:      &x,
		Y:      &y,
		Z:      &z,
		Speed:  &speed,
		Yaw:    &yaw,
		Drift:  &drift,
		Lights: &lights,
	})
	if err := aliceConn.WriteMessage(websocket.BinaryMessage, drivePayload); err != nil {
		t.Fatalf("alice failed driving car_0: %v", err)
	}
	time.Sleep(20 * time.Millisecond)

	// Bob receives Alice's initial driving move
	bobSawAliceDrive, err := readNextMsgSkipPolice(t, bobConn, 2*time.Second)
	if err != nil {
		t.Fatalf("bob failed reading alice drive move: %v", err)
	}
	if bobSawAliceDrive["type"] != TypeMove || bobSawAliceDrive["username"] != "alice" {
		t.Fatalf("unexpected msg for bob: %+v", bobSawAliceDrive)
	}

	snap := srv.Hub().Snapshot()
	if snap.Cars["car_0"].Driver != "alice" {
		t.Fatalf("expected alice to be driving car_0, got: %q", snap.Cars["car_0"].Driver)
	}

	// 2. Bob attempts to hijack car_0 while Alice is driving it
	bobX, bobZ := 50.0, 50.0
	bobDrivePayload, _ := msgpack.Marshal(InboundDrivingMoveMsg{
		Type:   TypeMove,
		Mode:   ModeDriving,
		CarID:  &car0ID,
		X:      &bobX,
		Y:      &y,
		Z:      &bobZ,
		Speed:  &speed,
		Yaw:    &yaw,
		Drift:  &drift,
		Lights: &lights,
	})
	if err := bobConn.WriteMessage(websocket.BinaryMessage, bobDrivePayload); err != nil {
		t.Fatalf("bob failed sending hijack move: %v", err)
	}
	time.Sleep(20 * time.Millisecond)

	// Bob receives authoritative driving update rejecting his hijack and showing alice as driver
	bobRejectionMsg, err := readNextMsgSkipPolice(t, bobConn, 2*time.Second)
	if err != nil {
		t.Fatalf("bob failed reading rejection msg: %v", err)
	}
	if bobRejectionMsg["type"] != TypeMove || bobRejectionMsg["mode"] != ModeDriving || bobRejectionMsg["username"] != "alice" {
		t.Fatalf("expected rejection with alice as driver, got: %+v", bobRejectionMsg)
	}

	snapAfterHijack := srv.Hub().Snapshot()
	if snapAfterHijack.Cars["car_0"].Driver != "alice" {
		t.Fatalf("car_0 should still be driven by alice, but got: %q", snapAfterHijack.Cars["car_0"].Driver)
	}
	if snapAfterHijack.Cars["car_0"].X != 10.0 {
		t.Fatalf("car_0 coordinates should not be overwritten by rejected driver, got x: %v", snapAfterHijack.Cars["car_0"].X)
	}

	// 3. Alice attempts to drive an unallowed/invalid car ID
	invalidCarID := "car_invalid_999"
	invalidPayload, _ := msgpack.Marshal(InboundDrivingMoveMsg{
		Type:   TypeMove,
		Mode:   ModeDriving,
		CarID:  &invalidCarID,
		X:      &x,
		Y:      &y,
		Z:      &z,
		Speed:  &speed,
		Yaw:    &yaw,
		Drift:  &drift,
		Lights: &lights,
	})
	if err := aliceConn.WriteMessage(websocket.BinaryMessage, invalidPayload); err != nil {
		t.Fatalf("alice failed sending invalid car move: %v", err)
	}
	time.Sleep(20 * time.Millisecond)

	snapAfterInvalid := srv.Hub().Snapshot()
	if _, exists := snapAfterInvalid.Cars[invalidCarID]; exists {
		t.Fatalf("invalid car ID should not exist in tracked cars map")
	}

	// 4. Alice exits car_0 (switches to pedestrian)
	pedX, pedY, pedZ := 12.0, 0.0, 20.0
	vx, vz := 0.0, 0.0
	anim := AnimIdle
	pedPayload, _ := msgpack.Marshal(InboundPedestrianMoveMsg{
		Type: TypeMove,
		Mode: ModePedestrian,
		X:    &pedX,
		Y:    &pedY,
		Z:    &pedZ,
		VX:   &vx,
		VZ:   &vz,
		Yaw:  &yaw,
		Anim: &anim,
	})
	if err := aliceConn.WriteMessage(websocket.BinaryMessage, pedPayload); err != nil {
		t.Fatalf("alice failed sending ped move: %v", err)
	}
	time.Sleep(20 * time.Millisecond)

	// Alice and Bob receive parked car broadcast
	aliceParked, err := readNextMsgSkipPolice(t, aliceConn, 2*time.Second)
	if err != nil {
		t.Fatalf("alice failed reading parked msg: %v", err)
	}
	if aliceParked["username"] != "" || aliceParked["speed"] != float64(0) {
		t.Fatalf("expected parked car to have empty driver, got: %+v", aliceParked)
	}

	// Bob also received pedestrian move from Alice and parked car broadcast
	// Drain or assert bob's queue
	sawParkedOnBob := false
	for i := 0; i < 2; i++ {
		msg, err := readNextMsgSkipPolice(t, bobConn, 2*time.Second)
		if err == nil && msg["type"] == TypeMove && msg["mode"] == ModeDriving && msg["car_id"] == "car_0" && msg["username"] == "" {
			sawParkedOnBob = true
		}
	}
	if !sawParkedOnBob {
		t.Fatalf("bob did not receive parked car broadcast")
	}

	snapAfterExit := srv.Hub().Snapshot()
	if snapAfterExit.Cars["car_0"].Driver != "" {
		t.Fatalf("car_0 should be parked with empty driver, got %q", snapAfterExit.Cars["car_0"].Driver)
	}

	// 5. Bob now legally enters car_0
	if err := bobConn.WriteMessage(websocket.BinaryMessage, bobDrivePayload); err != nil {
		t.Fatalf("bob failed driving car_0: %v", err)
	}
	time.Sleep(20 * time.Millisecond)

	snapBobDrives := srv.Hub().Snapshot()
	if snapBobDrives.Cars["car_0"].Driver != "bob" {
		t.Fatalf("expected bob to drive car_0, got: %q", snapBobDrives.Cars["car_0"].Driver)
	}
}

func TestHub_SnapshotCancellationSafe(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	h := NewHub(ctx)

	// Cancel context to stop hub actor
	cancel()
	h.Stop()

	// Calling Snapshot after stop/cancellation must return immediately without deadlocking
	snap := h.Snapshot()
	if snap.Cars == nil || snap.Users == nil {
		t.Fatalf("expected non-nil maps from cancelled snapshot")
	}
}

func TestCannonFire_ValidationAndBroadcast(t *testing.T) {
	_, wsURL := startTestServer(t, 5*time.Second)

	aliceConn := connectWS(t, wsURL+"?username=alice")
	defer aliceConn.Close()
	_, _ = readNextMsgSkipPolice(t, aliceConn, 2*time.Second) // join

	bobConn := connectWS(t, wsURL+"?username=bob")
	defer bobConn.Close()
	_, _ = readNextMsgSkipPolice(t, bobConn, 2*time.Second)   // join
	_, _ = readNextMsgSkipPolice(t, aliceConn, 2*time.Second) // bob's join

	fireMsg, _ := msgpack.Marshal(map[string]any{"type": TypeCannonFire})

	// 1. Try to fire before position is established
	if err := aliceConn.WriteMessage(websocket.BinaryMessage, fireMsg); err != nil {
		t.Fatalf("write error: %v", err)
	}
	errReply, err := readNextMsgSkipPolice(t, aliceConn, 2*time.Second)
	if err != nil || errReply["type"] != TypeError || !strings.Contains(fmt.Sprint(errReply["message"]), "position not established") {
		t.Fatalf("expected position not established error, got: %+v (err: %v)", errReply, err)
	}

	// 2. Set position far away from fortress (x: 0, z: 0)
	farMove, _ := msgpack.Marshal(map[string]any{
		"type": "move",
		"mode": ModePedestrian,
		"x":    0.0,
		"y":    0.0,
		"z":    0.0,
		"yaw":  0.0,
		"anim": AnimIdle,
	})
	_ = aliceConn.WriteMessage(websocket.BinaryMessage, farMove)
	_, _ = readNextMsgSkipPolice(t, bobConn, 2*time.Second) // alice move

	_ = aliceConn.WriteMessage(websocket.BinaryMessage, fireMsg)
	errReply, err = readNextMsgSkipPolice(t, aliceConn, 2*time.Second)
	if err != nil || errReply["type"] != TypeError || !strings.Contains(fmt.Sprint(errReply["message"]), "too far") {
		t.Fatalf("expected too far error, got: %+v (err: %v)", errReply, err)
	}

	// 3. Move near fortress (127.87, -124.43)
	nearMove, _ := msgpack.Marshal(map[string]any{
		"type": "move",
		"mode": ModePedestrian,
		"x":    127.87,
		"y":    0.0,
		"z":    -124.43,
		"yaw":  0.0,
		"anim": AnimIdle,
	})
	_ = aliceConn.WriteMessage(websocket.BinaryMessage, nearMove)
	_, _ = readNextMsgSkipPolice(t, bobConn, 2*time.Second) // alice move

	// 4. Valid cannon fire!
	_ = aliceConn.WriteMessage(websocket.BinaryMessage, fireMsg)

	// Alice receives confirmed shot
	aliceShot, err := readNextMsgSkipPolice(t, aliceConn, 2*time.Second)
	if err != nil || aliceShot["type"] != TypeCannonShot || aliceShot["user"] != "alice" || aliceShot["reason"] != "fortress" {
		t.Fatalf("expected confirmed cannon shot for alice, got: %+v (err: %v)", aliceShot, err)
	}

	// Bob also receives cannon shot
	bobShot, err := readNextMsgSkipPolice(t, bobConn, 2*time.Second)
	if err != nil || bobShot["type"] != TypeCannonShot || bobShot["user"] != "alice" || bobShot["reason"] != "fortress" {
		t.Fatalf("expected confirmed cannon shot for bob, got: %+v (err: %v)", bobShot, err)
	}

	// 5. Immediate second shot -> cooldown error
	_ = aliceConn.WriteMessage(websocket.BinaryMessage, fireMsg)
	errReply, err = readNextMsgSkipPolice(t, aliceConn, 2*time.Second)
	if err != nil || errReply["type"] != TypeError || !strings.Contains(fmt.Sprint(errReply["message"]), "cooling down") {
		t.Fatalf("expected cooldown error, got: %+v (err: %v)", errReply, err)
	}
}

func TestCannonShot_ServerReserved(t *testing.T) {
	_, wsURL := startTestServer(t, 5*time.Second)

	aliceConn := connectWS(t, wsURL+"?username=alice")
	defer aliceConn.Close()
	_, _ = readNextMsgSkipPolice(t, aliceConn, 2*time.Second) // join

	reservedMsg, _ := msgpack.Marshal(map[string]any{
		"type":   TypeCannonShot,
		"user":   "alice",
		"reason": "fortress",
	})
	_ = aliceConn.WriteMessage(websocket.BinaryMessage, reservedMsg)

	errReply, err := readNextMsgSkipPolice(t, aliceConn, 2*time.Second)
	if err != nil || errReply["type"] != TypeError || !strings.Contains(fmt.Sprint(errReply["message"]), "server reserved") {
		t.Fatalf("expected server reserved error, got: %+v (err: %v)", errReply, err)
	}
}

func TestNoonCannonBroadcast(t *testing.T) {
	srv, wsURL := startTestServer(t, 5*time.Second)

	aliceConn := connectWS(t, wsURL+"?username=alice")
	defer aliceConn.Close()
	_, _ = readNextMsgSkipPolice(t, aliceConn, 2*time.Second) // join

	bobConn := connectWS(t, wsURL+"?username=bob")
	defer bobConn.Close()
	_, _ = readNextMsgSkipPolice(t, bobConn, 2*time.Second)   // join
	_, _ = readNextMsgSkipPolice(t, aliceConn, 2*time.Second) // bob's join

	srv.Hub().TriggerNoonCannon()

	aliceMsg, err := readNextMsgSkipPolice(t, aliceConn, 2*time.Second)
	if err != nil || aliceMsg["type"] != TypeCannonShot || aliceMsg["reason"] != "noon" {
		t.Fatalf("expected noon cannon shot for alice, got: %+v (err: %v)", aliceMsg, err)
	}

	bobMsg, err := readNextMsgSkipPolice(t, bobConn, 2*time.Second)
	if err != nil || bobMsg["type"] != TypeCannonShot || bobMsg["reason"] != "noon" {
		t.Fatalf("expected noon cannon shot for bob, got: %+v (err: %v)", bobMsg, err)
	}
}

func TestNoonCannonSchedulingEligibility(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	hub := NewHub(ctx)
	defer hub.Stop()

	// 1. Before noon: 2026-10-24 11:59:50 Vladivostok = 2026-10-24 01:59:50 UTC
	simTime := time.Date(2026, 10, 24, 1, 59, 50, 0, time.UTC)
	hub.SetNowFunc(func() time.Time { return simTime })

	if hub.TickNoon() {
		t.Fatal("expected TickNoon to return false before noon")
	}

	// 2. Exact noon: 2026-10-24 12:00:00 Vladivostok = 2026-10-24 02:00:00 UTC
	simTime = time.Date(2026, 10, 24, 2, 0, 0, 0, time.UTC)
	if !hub.TickNoon() {
		t.Fatal("expected TickNoon to fire at 12:00 Vladivostok")
	}

	// 3. Duplicate check for same date (12:00:10): must return false
	simTime = time.Date(2026, 10, 24, 2, 0, 10, 0, time.UTC)
	if hub.TickNoon() {
		t.Fatal("expected duplicate tick for same date to be suppressed")
	}

	// 4. Next day after grace period (> 60s): 2026-10-25 12:01:05 Vladivostok = 2026-10-25 02:01:05 UTC
	simTime = time.Date(2026, 10, 25, 2, 1, 5, 0, time.UTC)
	if hub.TickNoon() {
		t.Fatal("expected tick outside grace window to be suppressed")
	}

	// 5. Next day within grace period: 2026-10-26 12:00:30 Vladivostok = 2026-10-26 02:00:30 UTC
	simTime = time.Date(2026, 10, 26, 2, 0, 30, 0, time.UTC)
	if !hub.TickNoon() {
		t.Fatal("expected tick within 60s grace window to fire")
	}
}

func asInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case int64:
		return n, true
	case int32:
		return int64(n), true
	case int16:
		return int64(n), true
	case int8:
		return int64(n), true
	case int:
		return int64(n), true
	case uint64:
		return int64(n), true
	case uint32:
		return int64(n), true
	case uint16:
		return int64(n), true
	case uint8:
		return int64(n), true
	case float64:
		return int64(n), true
	default:
		return 0, false
	}
}

func readMsgOfType(t *testing.T, conn *websocket.Conn, wantType string, timeout time.Duration) (map[string]any, error) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		rem := time.Until(deadline)
		if rem <= 0 {
			return nil, fmt.Errorf("timed out waiting for message type %q", wantType)
		}
		msg, err := readNextMsg(t, conn, rem)
		if err != nil {
			return nil, err
		}
		if msg["type"] == wantType {
			return msg, nil
		}
	}
}

func TestPoliceMessages_ServerReserved(t *testing.T) {
	srv, wsURL := startTestServer(t, 5*time.Second)
	srv.Hub().SetSimAutoTick(false)

	aliceConn := connectWS(t, wsURL+"?username=alice")
	defer aliceConn.Close()
	_, _ = readNextMsgSkipPolice(t, aliceConn, 2*time.Second)

	reservedTypes := []string{
		TypeBalanceUpdate,
		TypePoliceState,
		TypePoliceEncounterStart,
		TypePoliceEncounterResult,
		TypePoliceFineStop,
		TypePoliceChase,
		TypeVehicleImpulse,
	}

	for _, msgType := range reservedTypes {
		if err := sendMsgPack(t, aliceConn, map[string]any{"type": msgType, "money": 999999}); err != nil {
			t.Fatalf("write error for %s: %v", msgType, err)
		}
		errReply, err := readNextMsgSkipPolice(t, aliceConn, 2*time.Second)
		if err != nil {
			t.Fatalf("expected error reply for reserved type %s, got err: %v", msgType, err)
		}
		if errReply["type"] != TypeError || !strings.Contains(fmt.Sprint(errReply["message"]), "server reserved") {
			t.Fatalf("expected server reserved error for %s, got: %+v", msgType, errReply)
		}
	}

	snap := srv.Hub().Snapshot()
	if snap.Accounts["alice"] != DefaultInitialMoney {
		t.Fatalf("expected alice balance unchanged (%d), got %d", DefaultInitialMoney, snap.Accounts["alice"])
	}
}

func TestPoliceCarHijackRejected(t *testing.T) {
	srv, wsURL := startTestServer(t, 5*time.Second)
	srv.Hub().SetSimAutoTick(false)

	aliceConn := connectWS(t, wsURL+"?username=alice")
	defer aliceConn.Close()
	_, _ = readNextMsgSkipPolice(t, aliceConn, 2*time.Second)

	for _, carID := range []string{"police_car_0", "police_car_1"} {
		x, y, z, speed, yaw := 23.0, 0.0, 10.0, 15.0, 0.0
		drift, lights := false, true
		payload, _ := msgpack.Marshal(InboundDrivingMoveMsg{
			Type:   TypeMove,
			Mode:   ModeDriving,
			CarID:  &carID,
			X:      &x,
			Y:      &y,
			Z:      &z,
			Speed:  &speed,
			Yaw:    &yaw,
			Drift:  &drift,
			Lights: &lights,
		})
		if err := aliceConn.WriteMessage(websocket.BinaryMessage, payload); err != nil {
			t.Fatalf("write error for %s: %v", carID, err)
		}
		errReply, err := readNextMsgSkipPolice(t, aliceConn, 2*time.Second)
		if err != nil {
			t.Fatalf("expected error rejecting %s hijack: %v", carID, err)
		}
		if errReply["type"] != TypeError || errReply["op"] != TypeMove {
			t.Fatalf("expected error with op=move for %s, got %+v", carID, errReply)
		}
	}

	snap := srv.Hub().Snapshot()
	if _, exists := snap.Cars["police_car_0"]; exists {
		t.Fatal("police_car_0 must never appear in tracked player cars map")
	}
	if _, exists := snap.Users["alice"]; exists {
		t.Fatal("rejected police car move must not put alice into driving state")
	}
}

func TestJoinAndReconnect_MoneyAndPoliceBaseline(t *testing.T) {
	srv, wsURL := startTestServer(t, 30*time.Second)
	srv.Hub().SetSimAutoTick(false)

	// 1. Alice joins and receives self-join with default money and police_state baseline
	alice1 := connectWS(t, wsURL+"?username=alice")
	defer alice1.Close()

	joinAlice, err := readNextMsg(t, alice1, 2*time.Second)
	if err != nil || joinAlice["type"] != TypeJoin {
		t.Fatalf("expected alice join, got %+v (err=%v)", joinAlice, err)
	}
	aliceTok, _ := joinAlice["token"].(string)
	if m, ok := asInt64(joinAlice["money"]); !ok || m != DefaultInitialMoney {
		t.Fatalf("expected alice initial money %d, got %v", DefaultInitialMoney, joinAlice["money"])
	}
	policeBaseline, err := readNextMsg(t, alice1, 2*time.Second)
	if err != nil || policeBaseline["type"] != TypePoliceState {
		t.Fatalf("expected police_state immediately after join, got %+v (err=%v)", policeBaseline, err)
	}

	// 2. Bob joins; Alice's broadcast of Bob's join must NOT leak Bob's token or money
	bob := connectWS(t, wsURL+"?username=bob")
	defer bob.Close()
	bobJoin, err := readNextMsg(t, bob, 2*time.Second)
	if err != nil || bobJoin["type"] != TypeJoin {
		t.Fatalf("expected bob self-join, got %+v (err=%v)", bobJoin, err)
	}
	if m, ok := asInt64(bobJoin["money"]); !ok || m != DefaultInitialMoney {
		t.Fatalf("expected bob initial money %d, got %v", DefaultInitialMoney, bobJoin["money"])
	}
	_, _ = readMsgOfType(t, bob, TypePoliceState, 2*time.Second)

	aliceSeesBob, err := readNextMsgSkipPolice(t, alice1, 2*time.Second)
	if err != nil || aliceSeesBob["type"] != TypeJoin || aliceSeesBob["user"] != "bob" {
		t.Fatalf("expected bob join broadcast on alice1, got %+v (err=%v)", aliceSeesBob, err)
	}
	if _, hasTok := aliceSeesBob["token"]; hasTok {
		t.Fatalf("broadcast join must omit token: %+v", aliceSeesBob)
	}
	if _, hasMoney := aliceSeesBob["money"]; hasMoney {
		t.Fatalf("broadcast join must omit money: %+v", aliceSeesBob)
	}

	// 3. Drive Alice's balance negative via two animated speeding fine-stops paying 66666 each (leaves car_0 unblocked, balance = -7932)
	for i := 0; i < 2; i++ {
		srv.Hub().StepSimulation(10.5) // clear officer return, grace & cooldowns
		snap := srv.Hub().Snapshot()
		pc := snap.Police.PoliceCars[0]
		if err := sendMsgPack(t, alice1, map[string]any{
			"type": TypeMove, "mode": ModeDriving, "car_id": "car_0",
			"x": pc.X, "y": 0.0, "z": pc.Z + 12.0, "speed": 18.0, "yaw": 0.0, "drift": false, "lights": true,
		}); err != nil {
			t.Fatal(err)
		}
		_, _ = readMsgOfType(t, bob, TypeMove, 2*time.Second)
		srv.Hub().StepSimulation(0.05) // chase started

		// Stop next to police_car_0 until fine_stop starts
		for s := 0; s < 16; s++ {
			snapLoop := srv.Hub().Snapshot()
			if _, inStop := snapLoop.Police.ActiveFineStops["alice"]; inStop {
				break
			}
			pcLoop := snapLoop.Police.PoliceCars[0]
			_ = sendMsgPack(t, alice1, map[string]any{
				"type": TypeMove, "mode": ModeDriving, "car_id": "car_0",
				"x": pcLoop.X + 3.0, "y": 0.0, "z": pcLoop.Z + 1.0, "speed": 0.0, "yaw": 0.0, "drift": false, "lights": true,
			})
			_, _ = readMsgOfType(t, bob, TypeMove, 2*time.Second)
			srv.Hub().StepSimulation(0.05)
		}
		// Step until DPS officer walks up and starts traffic encounter
		for s := 0; s < 80; s++ {
			if _, hasEnc := srv.Hub().Snapshot().Police.ActiveEncounters["alice"]; hasEnc {
				break
			}
			srv.Hub().StepSimulation(0.05)
		}
		trafficEnc, err := readMsgOfType(t, alice1, TypePoliceEncounterStart, 2*time.Second)
		if err != nil {
			t.Fatalf("round %d: expected traffic police_encounter_start: %v", i, err)
		}
		if err := sendMsgPack(t, alice1, map[string]any{
			"type":         TypePoliceDialogueChoice,
			"encounter_id": fmt.Sprint(trafficEnc["encounter_id"]),
			"option_index": 3, // 66666 rub, car remains unblocked
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := readMsgOfType(t, bob, TypePoliceEncounterResult, 2*time.Second); err != nil {
			t.Fatalf("round %d: expected encounter result on bob: %v", i, err)
		}
	}

	snapNeg := srv.Hub().Snapshot()
	wantNegMoney := DefaultInitialMoney - 2*PoliceMaxFineNoBan // -7932
	if snapNeg.Accounts["alice"] != wantNegMoney {
		t.Fatalf("expected alice negative balance %d, got %d", wantNegMoney, snapNeg.Accounts["alice"])
	}

	// 4. Alice triggers an active foot-cop encounter while balance is negative
	srv.Hub().StepSimulation(16.0) // clear playerCooldownUntil
	snapNeg = srv.Hub().Snapshot()
	cop0 := snapNeg.Police.FootCops[0]
	for _, c := range snapNeg.Police.FootCops {
		if !strings.HasPrefix(c.ID, "dps_") {
			cop0 = c
			break
		}
	}
	_ = sendMsgPack(t, alice1, map[string]any{
		"type": TypeMove, "mode": ModePedestrian,
		"x": cop0.X, "y": 0.0, "z": cop0.Z + 1.5, "vx": 0.0, "vz": 0.0, "yaw": 0.0, "anim": AnimIdle,
	})
	_, _ = readMsgOfType(t, bob, TypeMove, 2*time.Second)
	srv.Hub().StepSimulation(0.05) // approach
	srv.Hub().StepSimulation(0.05) // dialogue starts

	encOnOld, err := readMsgOfType(t, alice1, TypePoliceEncounterStart, 2*time.Second)
	if err != nil {
		t.Fatalf("expected active encounter on alice1 before 4408 reconnect: %v", err)
	}
	encID := fmt.Sprint(encOnOld["encounter_id"])

	// 5. Alice reconnects with her session token (4408 replacement):
	//    must receive join.money == -7932, tracked cars baseline, police_state, AND the unresolved police_encounter_start!
	alice2 := connectWS(t, fmt.Sprintf("%s?username=alice&token=%s", wsURL, aliceTok))
	defer alice2.Close()

	join2, err := readNextMsg(t, alice2, 2*time.Second)
	if err != nil || join2["type"] != TypeJoin {
		t.Fatalf("expected alice2 join, got %+v (err=%v)", join2, err)
	}
	if m, ok := asInt64(join2["money"]); !ok || m != wantNegMoney {
		t.Fatalf("expected reconnected alice2 money %d, got %v", wantNegMoney, join2["money"])
	}
	ps2, err := readMsgOfType(t, alice2, TypePoliceState, 2*time.Second)
	if err != nil || ps2["type"] != TypePoliceState {
		t.Fatalf("expected police_state after alice2 join, got %+v (err=%v)", ps2, err)
	}
	enc2, err := readNextMsg(t, alice2, 2*time.Second)
	if err != nil || enc2["type"] != TypePoliceEncounterStart || fmt.Sprint(enc2["encounter_id"]) != encID {
		t.Fatalf("expected unresolved police_encounter_start %q re-sent on 4408 reconnect, got %+v (err=%v)", encID, enc2, err)
	}

	// Old connection receives 4408
	_, err = readNextMsgSkipPolice(t, alice1, time.Second)
	if err == nil || !strings.Contains(err.Error(), "4408") {
		t.Fatalf("expected 4408 on replaced alice1, got: %v", err)
	}

	// 6. Alice resolves the preserved encounter on alice2; bob receives police_encounter_result
	if err := sendMsgPack(t, alice2, map[string]any{
		"type":         TypePoliceDialogueChoice,
		"encounter_id": encID,
		"option_index": 2,
	}); err != nil {
		t.Fatal(err)
	}
	resBob, err := readMsgOfType(t, bob, TypePoliceEncounterResult, 2*time.Second)
	if err != nil || fmt.Sprint(resBob["encounter_id"]) != encID {
		t.Fatalf("expected bob to observe encounter result %q, got %+v (err=%v)", encID, resBob, err)
	}
}

func TestMultiplayer_PoliceEncounterAndFineSync(t *testing.T) {
	srv, wsURL := startTestServer(t, 30*time.Second)
	srv.Hub().SetSimAutoTick(false)

	alice := connectWS(t, wsURL+"?username=alice")
	defer alice.Close()
	_, _ = readMsgOfType(t, alice, TypePoliceState, 2*time.Second)

	bob := connectWS(t, wsURL+"?username=bob")
	defer bob.Close()
	_, _ = readMsgOfType(t, bob, TypePoliceState, 2*time.Second)
	_, _ = readNextMsgSkipPolice(t, alice, 2*time.Second) // bob join

	// Place alice near cop_0 (within 12m, > 2.4m)
	snap0 := srv.Hub().Snapshot()
	cop0 := snap0.Police.FootCops[0]
	if err := sendMsgPack(t, alice, map[string]any{
		"type": TypeMove, "mode": ModePedestrian,
		"x": cop0.X, "y": 0.0, "z": cop0.Z + 6.0, "vx": 0.0, "vz": 0.0, "yaw": 0.0, "anim": AnimIdle,
	}); err != nil {
		t.Fatal(err)
	}
	_, _ = readMsgOfType(t, bob, TypeMove, 2*time.Second)

	// Step simulation without any client request until unsolicited encounter arrives
	for i := 0; i < 40; i++ {
		srv.Hub().StepSimulation(0.05)
	}

	enc, err := readMsgOfType(t, alice, TypePoliceEncounterStart, 2*time.Second)
	if err != nil {
		t.Fatalf("expected unsolicited police_encounter_start on alice: %v", err)
	}
	encID := fmt.Sprint(enc["encounter_id"])
	if enc["target_user"] != "alice" || enc["cop_id"] != "cop_0" {
		t.Fatalf("unexpected encounter target/cop: %+v", enc)
	}

	// Bob must NOT receive Alice's private encounter prompt, and trying to answer it must return error
	if err := sendMsgPack(t, bob, map[string]any{
		"type":         TypePoliceDialogueChoice,
		"encounter_id": encID,
		"option_index": 0,
	}); err != nil {
		t.Fatal(err)
	}
	bobErr, err := readMsgOfType(t, bob, TypeError, 2*time.Second)
	if err != nil || bobErr["op"] != TypePoliceDialogueChoice {
		t.Fatalf("expected error with op=police_dialogue_choice for unauthorized bob, got %+v (err=%v)", bobErr, err)
	}

	// Alice sends option 2 (person_search option 2 has fine=1500)
	if err := sendMsgPack(t, alice, map[string]any{
		"type":         TypePoliceDialogueChoice,
		"encounter_id": encID,
		"option_index": 2,
	}); err != nil {
		t.Fatal(err)
	}

	aliceBal, err := readMsgOfType(t, alice, TypeBalanceUpdate, 2*time.Second)
	if err != nil {
		t.Fatalf("expected balance_update on alice: %v", err)
	}
	aliceRes, err := readMsgOfType(t, alice, TypePoliceEncounterResult, 2*time.Second)
	if err != nil {
		t.Fatalf("expected police_encounter_result on alice: %v", err)
	}
	bobRes, err := readMsgOfType(t, bob, TypePoliceEncounterResult, 2*time.Second)
	if err != nil {
		t.Fatalf("expected police_encounter_result on bob: %v", err)
	}
	fineA, _ := asInt64(aliceRes["fine"])
	moneyA, _ := asInt64(aliceRes["money"])
	moneyB, _ := asInt64(bobRes["money"])
	if fineA <= 0 || moneyA != DefaultInitialMoney-fineA || moneyB != moneyA {
		t.Fatalf("unexpected encounter result fine/money sync: alice=%+v bob=%+v", aliceRes, bobRes)
	}

	balMoney, _ := asInt64(aliceBal["money"])
	balDelta, _ := asInt64(aliceBal["delta"])
	if balMoney != moneyA || balDelta != -fineA {
		t.Fatalf("balance_update mismatch: got money=%d delta=%d, want money=%d delta=%d", balMoney, balDelta, moneyA, -fineA)
	}
}

func TestMultiplayer_SpeedingChaseCollisionAndStopFineSync(t *testing.T) {
	srv, wsURL := startTestServer(t, 30*time.Second)
	srv.Hub().SetSimAutoTick(false)

	alice := connectWS(t, wsURL+"?username=alice")
	defer alice.Close()
	_, _ = readMsgOfType(t, alice, TypePoliceState, 2*time.Second)

	bob := connectWS(t, wsURL+"?username=bob")
	defer bob.Close()
	_, _ = readMsgOfType(t, bob, TypePoliceState, 2*time.Second)
	_, _ = readNextMsgSkipPolice(t, alice, 2*time.Second)

	// 1. Alice drives car_0 > 40 km/h (18 m/s) in front of police_car_0
	snap0 := srv.Hub().Snapshot()
	pc0 := snap0.Police.PoliceCars[0]
	if err := sendMsgPack(t, alice, map[string]any{
		"type": TypeMove, "mode": ModeDriving, "car_id": "car_0",
		"x": pc0.X, "y": 0.0, "z": pc0.Z + 12.0, "speed": 18.0, "yaw": 0.0, "drift": false, "lights": true,
	}); err != nil {
		t.Fatal(err)
	}
	_, _ = readMsgOfType(t, bob, TypeMove, 2*time.Second)
	srv.Hub().StepSimulation(0.05)

	chaseAlice, err := readMsgOfType(t, alice, TypePoliceChase, 2*time.Second)
	if err != nil || chaseAlice["status"] != ChaseStatusStarted {
		t.Fatalf("expected police_chase started on alice, got %+v (err=%v)", chaseAlice, err)
	}
	chaseBob, err := readMsgOfType(t, bob, TypePoliceChase, 2*time.Second)
	if err != nil || chaseBob["status"] != ChaseStatusStarted || chaseBob["target_user"] != "alice" {
		t.Fatalf("expected police_chase started on bob, got %+v (err=%v)", chaseBob, err)
	}

	// 2. Position car_0 directly ahead of chasing police_car_0 to verify heavy 3-circle vehicle_impulse sync
	snapChase := srv.Hub().Snapshot()
	pcChase := snapChase.Police.PoliceCars[0]
	// Accelerate police_car_0 for a few steps so it carries momentum
	for i := 0; i < 10; i++ {
		srv.Hub().StepSimulation(0.05)
	}
	snapChase = srv.Hub().Snapshot()
	pcChase = snapChase.Police.PoliceCars[0]
	impactX := pcChase.X + math.Sin(pcChase.Yaw)*3.8
	impactZ := pcChase.Z + math.Cos(pcChase.Yaw)*3.8
	_ = sendMsgPack(t, alice, map[string]any{
		"type": TypeMove, "mode": ModeDriving, "car_id": "car_0",
		"x": impactX, "y": 0.0, "z": impactZ, "speed": 0.0, "yaw": pcChase.Yaw, "drift": false, "lights": true,
	})
	_, _ = readMsgOfType(t, bob, TypeMove, 2*time.Second)
	srv.Hub().StepSimulation(0.05)

	impAlice, err := readMsgOfType(t, alice, TypeVehicleImpulse, 2*time.Second)
	if err != nil || impAlice["car_id"] != "car_0" {
		t.Fatalf("expected vehicle_impulse on alice, got %+v (err=%v)", impAlice, err)
	}
	if pmass, _ := impAlice["police_mass"].(float64); pmass != PoliceCarMass {
		t.Fatalf("expected police_mass %v, got %v", PoliceCarMass, impAlice["police_mass"])
	}

	// 3. Alice remains stopped near police_car_0 -> enters fine_stop, forces exit, spawns DPS officer, then option 0 fines 5000 & bans car_0
	for i := 0; i < 16; i++ {
		s := srv.Hub().Snapshot()
		p := s.Police.PoliceCars[0]
		if p.State != PoliceCarStateChase {
			break
		}
		_ = sendMsgPack(t, alice, map[string]any{
			"type": TypeMove, "mode": ModeDriving, "car_id": "car_0",
			"x": p.X + 4.5, "y": 0.0, "z": p.Z, "speed": 0.0, "yaw": 0.0, "drift": false, "lights": true,
		})
		_, _ = readMsgOfType(t, bob, TypeMove, 2*time.Second)
		srv.Hub().StepSimulation(0.05)
	}

	var stoppedMsg, fineStopApp map[string]any
	deadline := time.Now().Add(2 * time.Second)
	for (stoppedMsg == nil || fineStopApp == nil) && time.Now().Before(deadline) {
		m, err := readNextMsg(t, bob, time.Until(deadline))
		if err != nil {
			t.Fatalf("expected police_chase stopped and police_fine_stop approaching on bob: %v", err)
		}
		if m["type"] == TypePoliceChase && m["status"] == ChaseStatusStopped {
			stoppedMsg = m
		} else if m["type"] == TypePoliceFineStop && m["stage"] == "approaching" {
			fineStopApp = m
		}
	}
	if stoppedMsg["reason"] != "caught" {
		t.Fatalf("expected caught stop reason, got %+v", stoppedMsg)
	}
	if fineStopApp["car_id"] != "car_0" || fineStopApp["target_user"] != "alice" {
		t.Fatalf("unexpected approaching fine_stop payload: %+v", fineStopApp)
	}

	// Step simulation until DPS officer reaches Alice and opens traffic encounter
	for i := 0; i < 100; i++ {
		if _, ok := srv.Hub().Snapshot().Police.ActiveEncounters["alice"]; ok {
			break
		}
		srv.Hub().StepSimulation(0.05)
	}
	encStart, err := readMsgOfType(t, alice, TypePoliceEncounterStart, 2*time.Second)
	if err != nil || encStart["encounter_kind"] != EncounterKindTraffic {
		t.Fatalf("expected traffic police_encounter_start on alice, got %+v (err=%v)", encStart, err)
	}
	if err := sendMsgPack(t, alice, map[string]any{
		"type":         TypePoliceDialogueChoice,
		"encounter_id": fmt.Sprint(encStart["encounter_id"]),
		"option_index": 0, // 5000 rub + 5-min car_0 ban
	}); err != nil {
		t.Fatal(err)
	}

	var balBob, resBob map[string]any
	deadline = time.Now().Add(2 * time.Second)
	for (balBob == nil || resBob == nil) && time.Now().Before(deadline) {
		m, err := readNextMsg(t, bob, time.Until(deadline))
		if err != nil {
			t.Fatalf("expected balance_update and police_encounter_result on bob: %v", err)
		}
		if m["type"] == TypeBalanceUpdate {
			balBob = m
		} else if m["type"] == TypePoliceEncounterResult {
			resBob = m
		}
	}
	fineVal, _ := asInt64(resBob["fine"])
	moneyVal, _ := asInt64(resBob["money"])
	if fineVal != PoliceSpeedingFine || moneyVal != DefaultInitialMoney-PoliceSpeedingFine || resBob["vehicle_blocked"] != true {
		t.Fatalf("unexpected traffic encounter result: %+v", resBob)
	}
	if bMoney, _ := asInt64(balBob["money"]); bMoney != DefaultInitialMoney-PoliceSpeedingFine {
		t.Fatalf("expected synced balance %d on bob, got %+v", DefaultInitialMoney-PoliceSpeedingFine, balBob)
	}

	// Banned car_0 rejects re-entry move from alice
	if err := sendMsgPack(t, alice, map[string]any{
		"type": TypeMove, "mode": ModeDriving, "car_id": "car_0",
		"x": 23.0, "y": 0.0, "z": 20.0, "speed": 0.0, "yaw": 0.0, "drift": false, "lights": true,
	}); err != nil {
		t.Fatal(err)
	}
	banErr, err := readMsgOfType(t, alice, TypeError, 2*time.Second)
	if err != nil || banErr["op"] != TypeMove || !strings.Contains(fmt.Sprint(banErr["message"]), "запрет") {
		t.Fatalf("expected ban error on car_0 driving move, got %+v (err=%v)", banErr, err)
	}

	// 4. Late joiner Charlie sees current authoritative police_state including vehicle_bans
	charlie := connectWS(t, wsURL+"?username=charlie")
	defer charlie.Close()
	psCharlie, err := readMsgOfType(t, charlie, TypePoliceState, 2*time.Second)
	if err != nil {
		t.Fatalf("expected police_state baseline on late joiner charlie: %v", err)
	}
	carsSlice, ok := psCharlie["police_cars"].([]any)
	if !ok || len(carsSlice) != 2 {
		t.Fatalf("expected 2 police cars on late joiner baseline, got %+v", psCharlie["police_cars"])
	}
	bansSlice, ok := psCharlie["vehicle_bans"].([]any)
	if !ok || len(bansSlice) != 1 {
		t.Fatalf("expected 1 active vehicle_ban on charlie baseline, got %+v", psCharlie["vehicle_bans"])
	}
}

func TestMultiplayer_OpenRoadRealisticBrakingStopAndFineSync(t *testing.T) {
	srv, wsURL := startTestServer(t, 30*time.Second)
	srv.Hub().SetSimAutoTick(false)

	alice := connectWS(t, wsURL+"?username=alice")
	defer alice.Close()
	_, _ = readMsgOfType(t, alice, TypePoliceState, 2*time.Second)

	bob := connectWS(t, wsURL+"?username=bob")
	defer bob.Close()
	_, _ = readMsgOfType(t, bob, TypePoliceState, 2*time.Second)
	_, _ = readNextMsgSkipPolice(t, alice, 2*time.Second)

	// Alice drives car_0 at (23.0, 45.0) at 12.0 m/s (> 40 km/h) ahead of police_car_0 (23.0, 10.0)
	carX, carZ := 23.0, 45.0
	carVX, carVZ := 0.0, 12.0
	if err := sendMsgPack(t, alice, map[string]any{
		"type": TypeMove, "mode": ModeDriving, "car_id": "car_0",
		"x": carX, "y": 0.0, "z": carZ, "vx": carVX, "vz": carVZ, "speed": 12.0, "yaw": 0.0, "drift": false, "lights": true,
	}); err != nil {
		t.Fatal(err)
	}
	_, _ = readMsgOfType(t, bob, TypeMove, 2*time.Second)
	srv.Hub().StepSimulation(0.05)

	chaseBob, err := readMsgOfType(t, bob, TypePoliceChase, 2*time.Second)
	if err != nil || chaseBob["status"] != ChaseStatusStarted {
		t.Fatalf("expected chase started on bob, got %+v (err=%v)", chaseBob, err)
	}
	if _, err := readMsgOfType(t, bob, TypePoliceState, 2*time.Second); err != nil {
		t.Fatalf("expected police_state after chase start on bob: %v", err)
	}
	if _, err := readMsgOfType(t, alice, TypePoliceState, 2*time.Second); err != nil {
		t.Fatalf("expected police_state after chase start on alice: %v", err)
	}

	// Simulate realistic 31.4 m/s^2 braking + aero drag without any lateral teleporting
	const dt = 0.05
	var stoppedBob, fineStopBob map[string]any
	maxZ := carZ

	for tick := 0; tick < 300; tick++ {
		spd := math.Hypot(carVX, carVZ)
		if spd > 0.001 {
			decel := (31.4 + 0.002*spd*spd) * dt
			if decel >= spd {
				carVX, carVZ = 0, 0
			} else {
				scale := (spd - decel) / spd
				carVX *= scale
				carVZ *= scale
			}
		} else {
			carVX, carVZ = 0, 0
		}
		carX += carVX * dt
		carZ += carVZ * dt
		if carZ > maxZ {
			maxZ = carZ
		}

		if err := sendMsgPack(t, alice, map[string]any{
			"type": TypeMove, "mode": ModeDriving, "car_id": "car_0",
			"x": carX, "y": 0.0, "z": carZ, "vx": carVX, "vz": carVZ, "speed": carVZ, "yaw": 0.0, "drift": false, "lights": true,
		}); err != nil {
			t.Fatal(err)
		}
		_, _ = readMsgOfType(t, bob, TypeMove, 2*time.Second)
		srv.Hub().StepSimulation(dt)

		// Each StepSimulation ends with TypePoliceState; read until it arrives so no timeout breaks the WS conn
		for {
			m, err := readNextMsg(t, bob, 2*time.Second)
			if err != nil {
				t.Fatalf("bob read failed on tick %d: %v", tick, err)
			}
			switch m["type"] {
			case TypeVehicleImpulse:
				if dvx, ok := m["dvx"].(float64); ok {
					carVX += dvx
				}
				if dvz, ok := m["dvz"].(float64); ok {
					carVZ += dvz
				}
			case TypePoliceFineStop:
				fineStopBob = m
			case TypePoliceChase:
				if m["status"] == ChaseStatusStopped || m["status"] == ChaseStatusEvaded {
					stoppedBob = m
				}
			}
			if m["type"] == TypePoliceState {
				break
			}
		}
		if _, err := readMsgOfType(t, alice, TypePoliceState, 2*time.Second); err != nil {
			t.Fatalf("alice read failed on tick %d: %v", tick, err)
		}
		if stoppedBob != nil && fineStopBob != nil {
			break
		}
	}

	if stoppedBob == nil || fineStopBob == nil {
		t.Fatalf("expected police_chase stopped + police_fine_stop over WS without bulldozing (maxZ=%.2f)", maxZ)
	}
	if stoppedBob["status"] != ChaseStatusStopped || stoppedBob["reason"] != "caught" {
		t.Fatalf("expected caught chase transition into fine_stop, got %+v (maxZ=%.2f)", stoppedBob, maxZ)
	}
	if maxZ >= 85.0 {
		t.Fatalf("expected car_0 not to be bulldozed down the road (maxZ=%.2f)", maxZ)
	}

	// Finish DPS officer walk -> traffic dialogue -> option 0 (5000 rub fine)
	for tick := 0; tick < 100; tick++ {
		if _, ok := srv.Hub().Snapshot().Police.ActiveEncounters["alice"]; ok {
			break
		}
		srv.Hub().StepSimulation(dt)
	}
	encStart, err := readMsgOfType(t, alice, TypePoliceEncounterStart, 2*time.Second)
	if err != nil {
		t.Fatalf("expected police_encounter_start after officer walk: %v", err)
	}
	if err := sendMsgPack(t, alice, map[string]any{
		"type":         TypePoliceDialogueChoice,
		"encounter_id": fmt.Sprint(encStart["encounter_id"]),
		"option_index": 0,
	}); err != nil {
		t.Fatal(err)
	}
	balBob, err := readMsgOfType(t, bob, TypeBalanceUpdate, 2*time.Second)
	if err != nil {
		t.Fatalf("expected balance_update broadcast to bob: %v", err)
	}
	if m, _ := asInt64(balBob["money"]); m != DefaultInitialMoney-PoliceSpeedingFine {
		t.Fatalf("expected synced balance %d on bob, got %+v", DefaultInitialMoney-PoliceSpeedingFine, balBob)
	}
}

func TestMultiplayer_FineStopReconnect66666UnblockedAndBumpSplit(t *testing.T) {
	srv, wsURL := startTestServer(t, 30*time.Second)
	srv.Hub().SetSimAutoTick(false)

	alice1 := connectWS(t, wsURL+"?username=alice")
	defer alice1.Close()
	j1, err := readNextMsg(t, alice1, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	aliceTok := fmt.Sprint(j1["token"])
	_, _ = readMsgOfType(t, alice1, TypePoliceState, 2*time.Second)

	bob := connectWS(t, wsURL+"?username=bob")
	defer bob.Close()
	_, _ = readMsgOfType(t, bob, TypePoliceState, 2*time.Second)

	// 1. Alice bumps into patrolling police_car_0 at low speed (< 40 km/h) -> collision chase!
	pc0 := srv.Hub().Snapshot().Police.PoliceCars[0]
	if err := sendMsgPack(t, alice1, map[string]any{
		"type": TypeMove, "mode": ModeDriving, "car_id": "car_0",
		"x": pc0.X, "y": 0.0, "z": pc0.Z + 3.8, "vx": 0.0, "vz": -5.0, "speed": -5.0, "yaw": 0.0, "drift": false, "lights": true,
	}); err != nil {
		t.Fatal(err)
	}
	_, _ = readMsgOfType(t, bob, TypeMove, 2*time.Second)
	srv.Hub().StepSimulation(0.05)

	bumpChase, err := readMsgOfType(t, bob, TypePoliceChase, 2*time.Second)
	if err != nil || bumpChase["status"] != ChaseStatusStarted || bumpChase["reason"] != "collision" {
		t.Fatalf("expected bump collision chase started on bob, got %+v (err=%v)", bumpChase, err)
	}

	// 2. Stop near police_car_0 -> fine_stop dialogue starts -> 4408 reconnect preserves BOTH fine_stop and encounter!
	for i := 0; i < 16; i++ {
		if _, ok := srv.Hub().Snapshot().Police.ActiveFineStops["alice"]; ok {
			break
		}
		p := srv.Hub().Snapshot().Police.PoliceCars[0]
		_ = sendMsgPack(t, alice1, map[string]any{
			"type": TypeMove, "mode": ModeDriving, "car_id": "car_0",
			"x": p.X + 3.0, "y": 0.0, "z": p.Z + 1.0, "vx": 0.0, "vz": 0.0, "speed": 0.0, "yaw": 0.0, "drift": false, "lights": true,
		})
		_, _ = readMsgOfType(t, bob, TypeMove, 2*time.Second)
		srv.Hub().StepSimulation(0.05)
	}
	for i := 0; i < 100; i++ {
		if _, ok := srv.Hub().Snapshot().Police.ActiveEncounters["alice"]; ok {
			break
		}
		srv.Hub().StepSimulation(0.05)
	}

	alice2 := connectWS(t, fmt.Sprintf("%s?username=alice&token=%s", wsURL, aliceTok))
	defer alice2.Close()
	_, _ = readNextMsg(t, alice2, 2*time.Second)                    // join
	_, _ = readMsgOfType(t, alice2, TypePoliceState, 2*time.Second) // police_state
	reFS, err := readNextMsg(t, alice2, 2*time.Second)
	if err != nil || reFS["type"] != TypePoliceFineStop {
		t.Fatalf("expected preserved police_fine_stop on 4408 reconnect, got %+v (err=%v)", reFS, err)
	}
	reEnc, err := readNextMsg(t, alice2, 2*time.Second)
	if err != nil || reEnc["type"] != TypePoliceEncounterStart || reEnc["scenario_id"] != "traffic_collision" {
		t.Fatalf("expected preserved traffic_collision encounter on 4408 reconnect, got %+v (err=%v)", reEnc, err)
	}

	// 3. Choosing option 3 (66666) leaves car_0 unblocked and immediately drivable!
	if err := sendMsgPack(t, alice2, map[string]any{
		"type":         TypePoliceDialogueChoice,
		"encounter_id": fmt.Sprint(reEnc["encounter_id"]),
		"option_index": 3,
	}); err != nil {
		t.Fatal(err)
	}
	res2, err := readMsgOfType(t, alice2, TypePoliceEncounterResult, 2*time.Second)
	if err != nil || res2["vehicle_blocked"] == true {
		t.Fatalf("expected 66666 choice unblocked result, got %+v (err=%v)", res2, err)
	}
	if err := sendMsgPack(t, alice2, map[string]any{
		"type": TypeMove, "mode": ModeDriving, "car_id": "car_0",
		"x": 23.0, "y": 0.0, "z": 25.0, "speed": 2.0, "yaw": 0.0, "drift": false, "lights": true,
	}); err != nil {
		t.Fatal(err)
	}
	bobDrive, err := readMsgOfType(t, bob, TypeMove, 2*time.Second)
	if err != nil || bobDrive["car_id"] != "car_0" {
		t.Fatalf("expected immediate re-drive on car_0 after 66666 choice, got %+v (err=%v)", bobDrive, err)
	}
}
