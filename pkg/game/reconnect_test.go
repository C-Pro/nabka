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

	// 4. c1 should have been closed/terminated by the server replacement:
	_ = c1.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	_, _, err = c1.ReadMessage()
	if err == nil {
		t.Fatal("expected old connection c1 to be closed by server replacement, but read succeeded")
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
	// Small pause for actor loop to process
	time.Sleep(50 * time.Millisecond)

	// Verify server snapshot shows Alice is driving car_0
	snap := srv.Hub().Snapshot()
	car0, exists := snap.Cars["car_0"]
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
