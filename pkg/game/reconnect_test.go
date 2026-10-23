package game

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/fasthttp/websocket"
	"github.com/vmihailenco/msgpack/v5"
)

func TestParseRegisterRequest(t *testing.T) {
	// 1. Valid with token
	validWithToken := map[string]any{
		"type":     "register",
		"username": "vasya",
		"token":    "tok_123456",
	}
	b, err := msgpack.Marshal(validWithToken)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}
	req, err := ParseRegisterRequest(b)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if req.Username != "vasya" || req.Token != "tok_123456" {
		t.Fatalf("unexpected req: %+v", req)
	}

	// 2. Valid without token
	validNoToken := map[string]any{
		"type":     "register",
		"username": "kolya",
	}
	b, _ = msgpack.Marshal(validNoToken)
	req, err = ParseRegisterRequest(b)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if req.Username != "kolya" || req.Token != "" {
		t.Fatalf("unexpected req: %+v", req)
	}

	// 3. Invalid username
	invalidName := map[string]any{
		"type":     "register",
		"username": "   ",
	}
	b, _ = msgpack.Marshal(invalidName)
	if _, err := ParseRegisterRequest(b); err == nil {
		t.Fatal("expected error for empty username, got nil")
	}
}

func TestSessionTokenIssuedOnJoin(t *testing.T) {
	_, baseURL := startTestServer(t, 5*time.Second)

	// Alice connects
	c1 := connectWS(t, baseURL+"?username=alice")
	defer c1.Close()

	join1, err := readNextMsg(t, c1, time.Second)
	if err != nil {
		t.Fatalf("alice failed to read join: %v", err)
	}
	if join1["type"] != "join" || join1["user"] != "alice" {
		t.Fatalf("unexpected join: %+v", join1)
	}
	token, ok := join1["token"].(string)
	if !ok || token == "" {
		t.Fatalf("expected non-empty token string in self-join, got %+v", join1["token"])
	}

	// Bob connects
	c2 := connectWS(t, baseURL+"?username=bob")
	defer c2.Close()

	// Bob receives self-join with token
	bobJoin, err := readNextMsg(t, c2, time.Second)
	if err != nil {
		t.Fatalf("bob failed to read join: %v", err)
	}
	if bobJoin["token"] == nil || bobJoin["token"] == "" {
		t.Fatalf("expected bob to receive token, got %+v", bobJoin)
	}

	// Alice receives bob's join WITHOUT bob's secret token
	aliceSeesBob, err := readNextMsg(t, c1, time.Second)
	if err != nil {
		t.Fatalf("alice failed to read bob join: %v", err)
	}
	if aliceSeesBob["user"] != "bob" {
		t.Fatalf("expected bob join, got %+v", aliceSeesBob)
	}
	if aliceSeesBob["token"] != nil && aliceSeesBob["token"] != "" {
		t.Fatalf("expected alice to NOT receive bob's private token, got %v", aliceSeesBob["token"])
	}
}

func TestReconnectReplacesActiveConnectionWithout4409(t *testing.T) {
	_, baseURL := startTestServer(t, 30*time.Second)

	// 1. Alice connects for the first time
	c1 := connectWS(t, baseURL+"?username=alice")
	defer c1.Close()

	join1, err := readNextMsg(t, c1, time.Second)
	if err != nil {
		t.Fatalf("failed to read initial join: %v", err)
	}
	aliceToken := join1["token"].(string)
	if aliceToken == "" {
		t.Fatal("expected alice to receive a session token")
	}

	// 2. While c1 is STILL open (simulating immediate reconnection or socket drop on client),
	// Alice connects a new socket c2 providing her session token:
	c2URL := fmt.Sprintf("%s?username=alice&token=%s", baseURL, aliceToken)
	c2 := connectWS(t, c2URL)
	defer c2.Close()

	// 3. c2 should NOT be rejected with 4409! It should successfully receive join:
	join2, err := readNextMsg(t, c2, time.Second)
	if err != nil {
		t.Fatalf("c2 failed to receive join on reconnection: %v", err)
	}
	if join2["type"] != "join" || join2["user"] != "alice" {
		t.Fatalf("unexpected join on reconnect: %+v", join2)
	}
	if join2["token"] != aliceToken {
		t.Fatalf("expected token %s to match, got %v", aliceToken, join2["token"])
	}

	// 4. c1 should have been closed with terminal code 4408 ("session replaced from another connection"):
	_ = c1.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	_, _, err = c1.ReadMessage()
	if err == nil {
		t.Fatal("expected old connection c1 to be closed by server replacement, but read succeeded")
	}
	if !strings.Contains(err.Error(), "4408") {
		t.Fatalf("expected close code 4408 on replaced connection, got: %v", err)
	}
}

func TestActiveSessionReplacementSurvivesPastTTL(t *testing.T) {
	srv, baseURL := startTestServer(t, 30*time.Second)

	// Set short sessionTTL (50ms) to ensure connection stays active longer than TTL
	srv.Hub().sessionTTL = 50 * time.Millisecond

	// 1. Alice connects
	c1 := connectWS(t, baseURL+"?username=alice")
	defer c1.Close()

	join1, err := readNextMsg(t, c1, time.Second)
	if err != nil {
		t.Fatalf("failed to read initial join: %v", err)
	}
	aliceToken := join1["token"].(string)

	// 2. Wait 120ms while c1 remains actively connected (exceeding 50ms sessionTTL)
	time.Sleep(120 * time.Millisecond)

	// 3. Alice reconnects on new socket c2 providing her session token:
	// Because c1 was actively connected, the session must NOT have expired!
	c2URL := fmt.Sprintf("%s?username=alice&token=%s", baseURL, aliceToken)
	c2 := connectWS(t, c2URL)
	defer c2.Close()

	join2, err := readNextMsg(t, c2, time.Second)
	if err != nil {
		t.Fatalf("c2 failed to receive join after active session exceeded TTL: %v", err)
	}
	if join2["token"] != aliceToken {
		t.Fatalf("expected token match %s, got %v", aliceToken, join2["token"])
	}

	// 4. c1 should be terminated with 4408
	_ = c1.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	_, _, err = c1.ReadMessage()
	if err == nil {
		t.Fatal("expected old connection c1 to be closed, but read succeeded")
	}
	if !strings.Contains(err.Error(), "4408") {
		t.Fatalf("expected close code 4408, got: %v", err)
	}
}

func TestReconnectWrongTokenOrNoTokenFailsWith4409(t *testing.T) {
	_, baseURL := startTestServer(t, 30*time.Second)

	// Alice connects
	c1 := connectWS(t, baseURL+"?username=alice")
	defer c1.Close()

	join1, err := readNextMsg(t, c1, time.Second)
	if err != nil {
		t.Fatalf("failed to read join: %v", err)
	}
	if join1["token"] == nil {
		t.Fatal("expected token")
	}

	// Impostor connects with wrong token:
	impostorURL := fmt.Sprintf("%s?username=alice&token=wrong_token", baseURL)
	dialer := websocket.Dialer{HandshakeTimeout: time.Second}
	c2, _, err := dialer.Dial(impostorURL, nil)
	if err == nil {
		defer c2.Close()
		_, _, readErr := c2.ReadMessage()
		if readErr == nil || !strings.Contains(readErr.Error(), "4409") {
			t.Fatalf("expected close 4409 for wrong token, got readErr: %v", readErr)
		}
	} else if !strings.Contains(err.Error(), "4409") {
		t.Fatalf("expected close code 4409, got dial err: %v", err)
	}

	// Impostor connects with NO token:
	c3, _, err := dialer.Dial(baseURL+"?username=alice", nil)
	if err == nil {
		defer c3.Close()
		_, _, readErr := c3.ReadMessage()
		if readErr == nil || !strings.Contains(readErr.Error(), "4409") {
			t.Fatalf("expected close 4409 for missing token, got readErr: %v", readErr)
		}
	} else if !strings.Contains(err.Error(), "4409") {
		t.Fatalf("expected close code 4409, got dial err: %v", err)
	}
}

func TestReconnectViaRegisterPacket(t *testing.T) {
	_, baseURL := startTestServer(t, 30*time.Second)

	// 1. Connect without query param, send initial register
	c1 := connectWS(t, baseURL)
	defer c1.Close()

	reg1 := map[string]any{"type": "register", "username": "bob"}
	if err := sendMsgPack(t, c1, reg1); err != nil {
		t.Fatal(err)
	}
	join1, err := readNextMsg(t, c1, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	bobToken := join1["token"].(string)
	if bobToken == "" {
		t.Fatal("expected bob token")
	}

	// 2. Reconnect via register packet with token
	c2 := connectWS(t, baseURL)
	defer c2.Close()

	reg2 := map[string]any{"type": "register", "username": "bob", "token": bobToken}
	if err := sendMsgPack(t, c2, reg2); err != nil {
		t.Fatal(err)
	}
	join2, err := readNextMsg(t, c2, time.Second)
	if err != nil {
		t.Fatalf("reconnect failed: %v", err)
	}
	if join2["user"] != "bob" || join2["token"] != bobToken {
		t.Fatalf("unexpected join: %+v", join2)
	}
}

func TestReconnectPreservesCarOccupancy(t *testing.T) {
	srv, baseURL := startTestServer(t, 30*time.Second)

	// Alice connects and drives car_0
	c1 := connectWS(t, baseURL+"?username=alice")
	defer c1.Close()

	join1, err := readNextMsg(t, c1, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	aliceToken := join1["token"].(string)

	// Alice sends driving move for car_0
	driveMsg := map[string]any{
		"type":   "move",
		"mode":   "driving",
		"car_id": "car_0",
		"x":      10.5,
		"y":      0.0,
		"z":      20.5,
		"speed":  15.0,
		"yaw":    1.57,
		"drift":  false,
		"lights": true,
	}
	if err := sendMsgPack(t, c1, driveMsg); err != nil {
		t.Fatal(err)
	}
	// Bounded wait for actor loop to process driving move
	deadline := time.Now().Add(2 * time.Second)
	var car0 CarState
	var exists bool
	for time.Now().Before(deadline) {
		snap := srv.Hub().Snapshot()
		car0, exists = snap.Cars["car_0"]
		if exists && car0.Driver == "alice" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Verify server snapshot shows Alice is driving car_0
	if !exists || car0.Driver != "alice" {
		t.Fatalf("expected alice driving car_0 before reconnect: %+v", car0)
	}

	// Alice reconnects with token while c1 is still open (or half-open)
	c2URL := fmt.Sprintf("%s?username=alice&token=%s", baseURL, aliceToken)
	c2 := connectWS(t, c2URL)
	defer c2.Close()

	join2, err := readNextMsg(t, c2, time.Second)
	if err != nil {
		t.Fatalf("c2 join failed: %v", err)
	}
	if join2["token"] != aliceToken {
		t.Fatalf("expected token match")
	}

	// c2 should receive car_0 baseline showing alice is driver
	foundCar0 := false
	for i := 0; i < 10; i++ {
		msg, err := readNextMsg(t, c2, 500*time.Millisecond)
		if err != nil {
			break
		}
		if msg["type"] == "move" && msg["car_id"] == "car_0" {
			foundCar0 = true
			if msg["username"] != "alice" {
				t.Fatalf("expected car_0 driver to still be alice, got %v", msg["username"])
			}
			break
		}
	}
	if !foundCar0 {
		t.Fatal("reconnected alice did not receive baseline for car_0")
	}

	// Server snapshot still shows alice as driver
	snap2 := srv.Hub().Snapshot()
	car0After := snap2.Cars["car_0"]
	if car0After.Driver != "alice" {
		t.Fatalf("expected car_0 driver to be preserved as alice, got %v", car0After.Driver)
	}
}

func TestRosterDeliveredInJoinBaseline(t *testing.T) {
	_, baseURL := startTestServer(t, 30*time.Second)

	// Alice connects
	c1 := connectWS(t, baseURL+"?username=alice")
	defer c1.Close()
	join1, err := readNextMsg(t, c1, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	roster1, ok := join1["roster"].([]any)
	if !ok || len(roster1) != 1 || roster1[0] != "alice" {
		t.Fatalf("expected alice roster to have ['alice'], got: %+v", join1["roster"])
	}

	// Bob connects
	c2 := connectWS(t, baseURL+"?username=bob")
	defer c2.Close()
	join2, err := readNextMsg(t, c2, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	roster2, ok := join2["roster"].([]any)
	if !ok || len(roster2) != 2 {
		t.Fatalf("expected bob roster to have 2 players, got: %+v", join2["roster"])
	}
	hasAlice := false
	hasBob := false
	for _, u := range roster2 {
		if u == "alice" {
			hasAlice = true
		}
		if u == "bob" {
			hasBob = true
		}
	}
	if !hasAlice || !hasBob {
		t.Fatalf("expected roster with both alice and bob, got: %+v", roster2)
	}
}

func TestDisconnectedSessionReservationAndExpiry(t *testing.T) {
	srv, baseURL := startTestServer(t, 30*time.Second)

	// Set short sessionTTL for testing (50ms)
	srv.Hub().sessionTTL = 50 * time.Millisecond

	// Observer client to synchronize disconnect events without arbitrary sleeps
	observer := connectWS(t, baseURL+"?username=observer")
	defer observer.Close()
	_, _ = readNextMsg(t, observer, time.Second)

	// 1. Alice connects and gets token
	c1 := connectWS(t, baseURL+"?username=alice")
	join1, err := readNextMsg(t, c1, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	aliceToken := join1["token"].(string)
	_, _ = readNextMsg(t, observer, time.Second) // consume alice join on observer

	// 2. Alice disconnects; wait on observer for leave event
	c1.Close()
	for {
		msg, err := readNextMsg(t, observer, time.Second)
		if err != nil {
			t.Fatalf("failed to receive alice leave event: %v", err)
		}
		if msg["type"] == "leave" && msg["user"] == "alice" {
			break
		}
	}

	// 3a. Within sessionTTL: impostor connects with WRONG token -> REJECTED (4409)
	dialer := websocket.Dialer{HandshakeTimeout: time.Second}
	cImp, _, err := dialer.Dial(baseURL+"?username=alice&token=wrong_token", nil)
	if err == nil {
		_, _, readErr := cImp.ReadMessage()
		cImp.Close()
		if readErr == nil || !strings.Contains(readErr.Error(), "4409") {
			t.Fatalf("expected close code 4409 for wrong token on reserved name, got: %v", readErr)
		}
	} else if !strings.Contains(err.Error(), "4409") {
		t.Fatalf("expected close code 4409 on dial for wrong token, got: %v", err)
	}

	// 3b. Within sessionTTL: impostor connects with MISSING token -> REJECTED (4409)
	cNoTok, _, err := dialer.Dial(baseURL+"?username=alice", nil)
	if err == nil {
		_, _, readErr := cNoTok.ReadMessage()
		cNoTok.Close()
		if readErr == nil || !strings.Contains(readErr.Error(), "4409") {
			t.Fatalf("expected close code 4409 for missing token on reserved name, got: %v", readErr)
		}
	} else if !strings.Contains(err.Error(), "4409") {
		t.Fatalf("expected close code 4409 on dial for missing token, got: %v", err)
	}

	// 4. Within sessionTTL: Alice reconnects with her valid token -> SUCCEEDS
	cAlice := connectWS(t, fmt.Sprintf("%s?username=alice&token=%s", baseURL, aliceToken))
	joinAlice, err := readNextMsg(t, cAlice, time.Second)
	if err != nil {
		t.Fatalf("alice failed to reclaim reserved session: %v", err)
	}
	if joinAlice["token"] != aliceToken {
		t.Fatalf("expected token match on session reclaim, got: %v", joinAlice["token"])
	}
	_, _ = readNextMsg(t, observer, time.Second) // consume alice join on observer

	// 5. Alice disconnects again; wait on observer for leave event
	cAlice.Close()
	for {
		msg, err := readNextMsg(t, observer, time.Second)
		if err != nil {
			t.Fatalf("failed to receive alice second leave event: %v", err)
		}
		if msg["type"] == "leave" && msg["user"] == "alice" {
			break
		}
	}

	// 6. Wait for sessionTTL (50ms) to elapse under controlled timing
	time.Sleep(75 * time.Millisecond)

	// 7. Now session has expired: connecting with the old expired token is accepted as brand new registration
	cExpired := connectWS(t, fmt.Sprintf("%s?username=alice&token=%s", baseURL, aliceToken))
	defer cExpired.Close()
	joinExpired, err := readNextMsg(t, cExpired, time.Second)
	if err != nil {
		t.Fatalf("new user should be able to register expired username, got: %v", err)
	}
	newToken := joinExpired["token"].(string)
	if newToken == "" || newToken == aliceToken {
		t.Fatalf("expected fresh token for newly claimed expired name, got: %v (original: %v)", newToken, aliceToken)
	}
}

func TestReplacementConcurrentWithTerminationAndSaturatedCommandQueue(t *testing.T) {
	srv, baseURL := startTestServer(t, 30*time.Second)

	// Connect Alice
	c1 := connectWS(t, baseURL+"?username=alice")
	join1, err := readNextMsg(t, c1, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	token := join1["token"].(string)

	// Deterministically synchronize and pause the Hub actor using an unbuffered snapshot request
	pauseCh := make(chan HubSnapshot)
	srv.Hub().cmdCh <- &cmdSnapshot{result: pauseCh}

	// Completely saturate cmdCh to capacity while Hub is paused
	hub := srv.Hub()
	for len(hub.cmdCh) < cap(hub.cmdCh) {
		select {
		case hub.cmdCh <- &cmdBroadcast{data: []byte("fill")}:
		default:
			break
		}
	}

	// Close c1 so terminate() runs and Unregister blocks on the saturated cmdCh
	_ = c1.Close()

	// Concurrently dial replacement c2 with Alice's token
	type dialRes struct {
		conn *websocket.Conn
		err  error
	}
	c2Chan := make(chan dialRes, 1)
	go func() {
		dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
		conn, _, err := dialer.Dial(fmt.Sprintf("%s?username=alice&token=%s", baseURL, token), nil)
		c2Chan <- dialRes{conn: conn, err: err}
	}()

	// Release the paused Hub actor: it unblocks and drains cmdCh
	select {
	case <-pauseCh:
	case <-time.After(2 * time.Second):
		t.Fatal("hub actor failed to reach pause point")
	}

	// Replacement connection c2 must complete handshake, receive self-join, and not deadlock
	select {
	case res := <-c2Chan:
		if res.err != nil {
			t.Fatalf("c2 replacement dial failed: %v", res.err)
		}
		c2 := res.conn
		defer c2.Close()

		join2, err := readNextMsg(t, c2, 3*time.Second)
		if err != nil {
			t.Fatalf("c2 failed to receive self-join: %v", err)
		}
		if join2["type"] != "join" || join2["user"] != "alice" || join2["token"] != token {
			t.Fatalf("unexpected join on c2: %+v", join2)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("deadlock detected: replacement blocked and timed out on saturated queue")
	}

	// Verify subsequent hub responsiveness via Snapshot()
	snap := srv.Hub().Snapshot()
	if snap.Cars == nil || snap.Users == nil {
		t.Fatal("hub failed to respond with snapshot after concurrent replacement")
	}
}
