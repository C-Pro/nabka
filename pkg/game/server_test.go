package game

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"sync"
	"testing"
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
	msg1, err := readNextMsg(t, conn1, 2*time.Second)
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
	msgBob, err := readNextMsg(t, conn2, 2*time.Second)
	if err != nil {
		t.Fatalf("bob failed to read join: %v", err)
	}
	if msgBob["type"] != "join" || msgBob["user"] != "bob" {
		t.Fatalf("unexpected bob join message: %+v", msgBob)
	}

	// Alice should also receive Bob's join message
	msgAliceSawBob, err := readNextMsg(t, conn1, 2*time.Second)
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
	_, _ = readNextMsg(t, observerConn, time.Second)

	// Inactive client
	inactiveConn := connectWS(t, baseURL+"?username=sleepy")
	defer inactiveConn.Close()

	// Read sleepy join on observer
	_, _ = readNextMsg(t, observerConn, time.Second)

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
		msg, err := readNextMsg(t, observerConn, time.Second)
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

	// Verify sleepy's username is freed and can reconnect
	reconnectConn := connectWS(t, baseURL+"?username=sleepy")
	defer reconnectConn.Close()

	joinMsg, err := readNextMsg(t, reconnectConn, time.Second)
	if err != nil {
		t.Fatalf("reconnected sleepy failed to receive join: %v", err)
	}
	if joinMsg["type"] != "join" || joinMsg["user"] != "sleepy" {
		t.Fatalf("unexpected reconnect join: %+v", joinMsg)
	}
}

func TestNormalDisconnect(t *testing.T) {
	_, baseURL := startTestServer(t, 5*time.Second)

	observer := connectWS(t, baseURL+"?username=observer")
	defer observer.Close()
	_, _ = readNextMsg(t, observer, time.Second)

	leaver := connectWS(t, baseURL+"?username=quitter")
	_, _ = readNextMsg(t, observer, time.Second)

	// Close quitter socket cleanly
	leaver.Close()

	leaveMsg, err := readNextMsg(t, observer, 2*time.Second)
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
	_, _ = readNextMsg(t, p1, time.Second)

	p2 := connectWS(t, baseURL+"?username=kolya")
	defer p2.Close()
	_, _ = readNextMsg(t, p2, time.Second)
	// p1 reads p2 join
	_, _ = readNextMsg(t, p1, time.Second)

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
	received, err := readNextMsg(t, p2, time.Second)
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
	_ = p1.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
	_, _, err = p1.ReadMessage()
	if err == nil {
		t.Fatal("vasya should not receive his own movement update")
	}
}

func TestDrivingMovement(t *testing.T) {
	_, baseURL := startTestServer(t, 5*time.Second)

	driver := connectWS(t, baseURL+"?username=vasya")
	defer driver.Close()
	_, _ = readNextMsg(t, driver, time.Second)

	spectator := connectWS(t, baseURL+"?username=spectator")
	defer spectator.Close()
	_, _ = readNextMsg(t, spectator, time.Second)
	_, _ = readNextMsg(t, driver, time.Second)

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

	received, err := readNextMsg(t, spectator, time.Second)
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
	_, _ = readNextMsg(t, p1, time.Second)

	p2 := connectWS(t, baseURL+"?username=kolya")
	defer p2.Close()
	_, _ = readNextMsg(t, p2, time.Second)
	_, _ = readNextMsg(t, p1, time.Second)

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
	msgKolya, err := readNextMsg(t, p2, time.Second)
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
	msgVasya, err := readNextMsg(t, p1, time.Second)
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
	_, _ = readNextMsg(t, alice, time.Second)

	bob := connectWS(t, baseURL+"?username=bob")
	defer bob.Close()
	_, _ = readNextMsg(t, bob, time.Second)
	_, _ = readNextMsg(t, alice, time.Second)

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
	received, err := readNextMsg(t, bob, time.Second)
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
	_, _ = readNextMsg(t, client, time.Second)

	// Send invalid msgpack data
	_ = client.SetWriteDeadline(time.Now().Add(time.Second))
	_ = client.WriteMessage(websocket.BinaryMessage, []byte{0xc1, 0x99, 0xff}) // invalid msgpack

	// Client should receive an error message back
	errResp, err := readNextMsg(t, client, time.Second)
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
	chatEcho, err := readNextMsg(t, client, time.Second)
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

	// Client with buffer size 1
	c1 := &Client{
		Username: "fast",
		send:     make(chan []byte, 10),
	}
	c2 := &Client{
		Username: "slow",
		send:     make(chan []byte, 1),
	}

	if !hub.Register(c1) {
		t.Fatal("failed to register c1")
	}
	if !hub.Register(c2) {
		t.Fatal("failed to register c2")
	}

	// Drain join messages from c1
	<-c1.send // c1 join
	<-c1.send // c2 join

	// c2's send buffer of capacity 1 is already full from c2's join broadcast!
	// Broadcasting another message from c1 will encounter a full buffer on c2 and trigger eviction.
	hub.Broadcast(c1, false, []byte("message 1"))

	// c1 should receive its own broadcast, followed by a leave event for c2 with reason "slow consumer"
	<-c1.send // message 1
	leaveData := <-c1.send

	var leaveMsg map[string]any
	if err := msgpack.Unmarshal(leaveData, &leaveMsg); err != nil {
		t.Fatalf("failed to decode leave msg: %v", err)
	}

	if leaveMsg["type"] != "leave" || leaveMsg["user"] != "slow" || leaveMsg["reason"] != "slow consumer" {
		t.Fatalf("unexpected leave msg for slow consumer: %+v", leaveMsg)
	}
}
