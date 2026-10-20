package game

import (
	"errors"
	"net"
	"testing"
	"time"
)

// Movement alone must keep an active player connected across multiple
// inactivity windows, even when no application heartbeat is sent by that player.
func TestMovementRefreshesInactivityDeadline(t *testing.T) {
	for _, mode := range []string{ModePedestrian, ModeDriving} {
		t.Run(mode, func(t *testing.T) {
			_, baseURL := startTestServer(t, 400*time.Millisecond)
			player := connectWS(t, baseURL+"?username=active")
			defer player.Close()
			if _, err := readNextMsg(t, player, time.Second); err != nil {
				t.Fatal(err)
			}
			observer := connectWS(t, baseURL+"?username=observer")
			defer observer.Close()
			if _, err := readNextMsg(t, observer, time.Second); err != nil {
				t.Fatal(err)
			}
			if _, err := readNextMsg(t, player, time.Second); err != nil {
				t.Fatal(err)
			}

			ticker := time.NewTicker(80 * time.Millisecond)
			defer ticker.Stop()
			for i := 0; i < 12; i++ {
				<-ticker.C
				if err := sendMsgPack(t, observer, map[string]any{"type": TypePing}); err != nil {
					t.Fatal(err)
				}
				pong, err := readNextMsg(t, observer, time.Second)
				if err != nil || pong["type"] != TypePong {
					t.Fatalf("observer heartbeat: %v, %v", pong, err)
				}
				move := map[string]any{
					"type": TypeMove, "mode": mode,
					"x": float64(i), "y": 0.0, "z": 10.0, "yaw": 0.0,
				}
				if mode == ModeDriving {
					move["car_id"], move["speed"], move["drift"], move["lights"] = "car_0", 10.0, false, false
				} else {
					move["anim"] = AnimRun
				}
				if err := sendMsgPack(t, player, move); err != nil {
					t.Fatal(err)
				}
				got, err := readNextMsg(t, observer, time.Second)
				if err != nil || got["type"] != TypeMove || got["x"] != float64(i) {
					t.Fatalf("movement %d: got %v, error %v", i, got, err)
				}
			}
		})
	}
}

// Browsers answer protocol pings independently of JavaScript timers. A healthy
// transport must survive when rendering or background timer throttling pauses
// all application messages.
func TestProtocolHeartbeatKeepsQuietClientConnected(t *testing.T) {
	const timeout = 250 * time.Millisecond
	_, baseURL := startTestServer(t, timeout)
	conn := connectWS(t, baseURL+"?username=quiet")
	defer conn.Close()
	if _, err := readNextMsg(t, conn, time.Second); err != nil {
		t.Fatal(err)
	}

	type result struct {
		message map[string]any
		err     error
	}
	readResult := make(chan result, 1)
	go func() {
		// ReadMessage services protocol pings using the default pong handler,
		// just as the browser network stack does without JavaScript callbacks.
		message, err := readNextMsg(t, conn, 3*time.Second)
		readResult <- result{message, err}
	}()

	timer := time.NewTimer(4 * timeout)
	defer timer.Stop()
	select {
	case got := <-readResult:
		t.Fatalf("quiet healthy connection ended before four liveness windows: message=%v, error=%v", got.message, got.err)
	case <-timer.C:
	}
	if err := sendMsgPack(t, conn, map[string]any{"type": TypePing}); err != nil {
		t.Fatal(err)
	}
	got := <-readResult
	if got.err != nil || got.message["type"] != TypePong {
		t.Fatalf("connection did not survive: message=%v, error=%v", got.message, got.err)
	}
}

func TestProtocolHeartbeatEvictsUnresponsiveClient(t *testing.T) {
	_, baseURL := startTestServer(t, 250*time.Millisecond)
	conn := connectWS(t, baseURL+"?username=unresponsive")
	defer conn.Close()
	if _, err := readNextMsg(t, conn, time.Second); err != nil {
		t.Fatal(err)
	}
	// Consume server pings without replying: merely sending probes must not
	// keep a dead peer alive on the server.
	conn.SetPingHandler(func(string) error { return nil })
	_, err := readNextMsg(t, conn, 2*time.Second)
	var netErr net.Error
	if err == nil || (errors.As(err, &netErr) && netErr.Timeout()) {
		t.Fatalf("server did not close the unresponsive connection: %v", err)
	}
}
