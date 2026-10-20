package game

import (
	"math"
	"testing"
	"time"
)

func drivingPacket() map[string]any {
	return map[string]any{"type": TypeMove, "mode": ModeDriving, "car_id": "car_0",
		"x": 1.0, "y": 0.0, "z": 2.0, "speed": 0.0, "yaw": 0.0,
		"drift": true, "lights": false, "vx": 12.0, "vz": 0.0, "yaw_rate": 1.5}
}

func TestDrivingMotionValidation(t *testing.T) {
	for _, key := range []string{"vx", "vz", "yaw_rate"} {
		for _, invalid := range []any{math.NaN(), math.Inf(1), "fast"} {
			packet := drivingPacket()
			packet[key] = invalid
			data, _ := MarshalMsgPack(packet)
			if _, err := ParseDrivingMove(data, "driver"); err == nil {
				t.Fatalf("accepted %s=%v", key, invalid)
			}
		}
	}
	packet := drivingPacket()
	delete(packet, "vx")
	delete(packet, "vz")
	delete(packet, "yaw_rate")
	packet["speed"] = 10.0
	packet["yaw"] = math.Pi / 2
	data, _ := MarshalMsgPack(packet)
	got, err := ParseDrivingMove(data, "driver")
	if err != nil || math.Abs(got.VX-10) > 1e-8 || math.Abs(got.VZ) > 1e-8 || got.YawRate != 0 {
		t.Fatalf("legacy fallback: %+v, %v", got, err)
	}
}

func TestDrivingMotionBaselineAndParking(t *testing.T) {
	srv, url := startTestServer(t, 5*time.Second)
	driver := connectWS(t, url+"?username=driver")
	defer driver.Close()
	if _, err := readNextMsg(t, driver, time.Second); err != nil {
		t.Fatal(err)
	}
	observer := connectWS(t, url+"?username=observer")
	defer observer.Close()
	if _, err := readNextMsg(t, observer, time.Second); err != nil {
		t.Fatal(err)
	}
	packet := drivingPacket()
	packet["sequence"] = uint64(99999) // identity/timing of updates belongs to the hub
	packet["sample_time_ms"] = -123.0
	var lastSeq uint64
	for i := 0; i < 2; i++ {
		if err := sendMsgPack(t, driver, packet); err != nil {
			t.Fatal(err)
		}
		got, err := readNextMsg(t, observer, time.Second)
		if err != nil || got["vx"] != 12.0 || got["vz"] != 0.0 || got["yaw_rate"] != 1.5 {
			t.Fatalf("motion: %v, %v", got, err)
		}
		state := srv.Hub().Snapshot().Cars["car_0"]
		if state.Sequence <= lastSeq || state.Sequence == 99999 || state.SampleTimeMS < 0 {
			t.Fatalf("server stamps: %+v", state)
		}
		lastSeq = state.Sequence
	}
	late := connectWS(t, url+"?username=late")
	defer late.Close()
	if _, err := readNextMsg(t, late, time.Second); err != nil {
		t.Fatal(err)
	}
	baseline, err := readNextMsg(t, late, time.Second)
	if err != nil || baseline["vx"] != 12.0 || baseline["yaw_rate"] != 1.5 {
		t.Fatalf("baseline: %v, %v", baseline, err)
	}
	// Late join notification is next in the observer stream.
	if _, err := readNextMsg(t, observer, time.Second); err != nil {
		t.Fatal(err)
	}
	driver.Close()
	for i := 0; i < 2; i++ {
		got, err := readNextMsg(t, observer, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if got["type"] == TypeMove && (got["vx"] != 0.0 || got["vz"] != 0.0 || got["yaw_rate"] != 0.0) {
			t.Fatalf("parked motion: %v", got)
		}
	}
	state := srv.Hub().Snapshot().Cars["car_0"]
	if state.Driver != "" || state.VX != 0 || state.VZ != 0 || state.YawRate != 0 {
		t.Fatalf("parked state: %+v", state)
	}
}
