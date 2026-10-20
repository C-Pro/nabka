package game

import (
	"context"
	"fmt"
	"io"
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

func TestPingKeepalive(t *testing.T) {
	timeout := 150 * time.Millisecond
	_, baseURL := startTestServer(t, timeout)

	conn := connectWS(t, baseURL+"?username=pinger")
	defer conn.Close()

	joinMsg, err := readNextMsg(t, conn, time.Second)
	if err != nil || joinMsg["type"] != "join" {
		t.Fatalf("expected join, got %v (err %v)", joinMsg, err)
	}

	for i := 0; i < 7; i++ {
		time.Sleep(50 * time.Millisecond)
		if err := sendMsgPack(t, conn, map[string]any{"type": "ping"}); err != nil {
			t.Fatalf("failed to send ping: %v", err)
		}
		pongMsg, err := readNextMsg(t, conn, time.Second)
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
	<-c1.send // car_move

	// Now broadcast message from c1 to trigger eviction of c2
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

	joinAlice, err := readNextMsg(t, aliceConn, 2*time.Second)
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
	aliceParkedMsg, err := readNextMsg(t, aliceConn, 2*time.Second)
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
	aliceSawBob, err := readNextMsg(t, aliceConn, 2*time.Second)
	if err != nil {
		t.Fatalf("alice failed reading bob join: %v", err)
	}
	if aliceSawBob["type"] != TypeJoin || aliceSawBob["user"] != "bob" {
		t.Fatalf("unexpected join saw by alice: %+v", aliceSawBob)
	}

	// Bob receives messages
	msg1, err := readNextMsg(t, bobConn, 2*time.Second)
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
		syncMsg, err := readNextMsg(t, bobConn, 2*time.Second)
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
	leaveAlice, err := readNextMsg(t, bobConn, 2*time.Second)
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

	charlieMsg1, err := readNextMsg(t, charlieConn, 2*time.Second)
	if err != nil {
		t.Fatalf("charlie failed reading msg1: %v", err)
	}
	if charlieMsg1["type"] != TypeJoin || charlieMsg1["user"] != "charlie" {
		t.Fatalf("expected charlie join, got: %+v", charlieMsg1)
	}

	charlieCarMsg, err := readNextMsg(t, charlieConn, 2*time.Second)
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

	aliceConn := connectWS(t, wsURL+"?username=alice")
	defer aliceConn.Close()
	_, _ = readNextMsg(t, aliceConn, 2*time.Second)

	bobConn := connectWS(t, wsURL+"?username=bob")
	defer bobConn.Close()
	_, _ = readNextMsg(t, bobConn, 2*time.Second)
	_, _ = readNextMsg(t, aliceConn, 2*time.Second)

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
	bobSawAliceDrive, err := readNextMsg(t, bobConn, 2*time.Second)
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
	bobRejectionMsg, err := readNextMsg(t, bobConn, 2*time.Second)
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
	aliceParked, err := readNextMsg(t, aliceConn, 2*time.Second)
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
		msg, err := readNextMsg(t, bobConn, 2*time.Second)
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
