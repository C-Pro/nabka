package game

import (
	"math"
	"testing"

	"github.com/vmihailenco/msgpack/v5"
)

func TestValidateUsername(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		want      string
		expectErr bool
	}{
		{"valid simple", "vasya", "vasya", false},
		{"valid with spaces trimmed", "  alice  ", "alice", false},
		{"valid cyrillic", "Вася", "Вася", false},
		{"empty", "", "", true},
		{"spaces only", "   ", "", true},
		{"too long", string(make([]rune, 33)), "", true},
		{"control character", "alice\x00bob", "", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ValidateUsername(tt.input)
			if tt.expectErr && err == nil {
				t.Fatalf("expected error for %q, got nil", tt.input)
			}
			if !tt.expectErr && err != nil {
				t.Fatalf("unexpected error for %q: %v", tt.input, err)
			}
			if !tt.expectErr && got != tt.want {
				t.Fatalf("expected %q, got %q", tt.want, got)
			}
		})
	}
}

func TestPedestrianMoveValidation(t *testing.T) {
	// Valid pedestrian message
	valid := map[string]any{
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

	b, err := msgpack.Marshal(valid)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}

	out, err := ParsePedestrianMove(b, "vasya")
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if out.Username != "vasya" || out.Mode != "pedestrian" || out.Anim != "run" || out.X != 0.5 {
		t.Fatalf("unexpected output: %+v", out)
	}

	// Missing anim
	missingAnim := map[string]any{
		"type": "move",
		"mode": "pedestrian",
		"x":    0.5,
		"y":    0.0,
		"z":    18.2,
		"yaw":  3.14,
	}
	b, _ = msgpack.Marshal(missingAnim)
	if _, err := ParsePedestrianMove(b, "vasya"); err == nil {
		t.Fatal("expected error for missing anim, got nil")
	}

	// Invalid anim
	invalidAnim := map[string]any{
		"type": "move",
		"mode": "pedestrian",
		"x":    0.5,
		"y":    0.0,
		"z":    18.2,
		"yaw":  3.14,
		"anim": "fly",
	}
	b, _ = msgpack.Marshal(invalidAnim)
	if _, err := ParsePedestrianMove(b, "vasya"); err == nil {
		t.Fatal("expected error for invalid anim 'fly', got nil")
	}

	// NaN coordinate
	nanCoord := map[string]any{
		"type": "move",
		"mode": "pedestrian",
		"x":    math.NaN(),
		"y":    0.0,
		"z":    18.2,
		"yaw":  3.14,
		"anim": "idle",
	}
	b, _ = msgpack.Marshal(nanCoord)
	if _, err := ParsePedestrianMove(b, "vasya"); err == nil {
		t.Fatal("expected error for NaN coordinate, got nil")
	}
}

func TestDrivingMoveValidation(t *testing.T) {
	// Valid driving move
	valid := map[string]any{
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

	b, err := msgpack.Marshal(valid)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}

	out, err := ParseDrivingMove(b, "vasya")
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if out.CarID != "car_0" || out.Speed != 22.4 || !out.Drift || !out.Lights {
		t.Fatalf("unexpected output: %+v", out)
	}

	// Missing car_id
	missingCar := map[string]any{
		"type":   "move",
		"mode":   "driving",
		"x":      19.5,
		"y":      0.02,
		"z":      14.0,
		"speed":  22.4,
		"yaw":    1.57,
		"drift":  false,
		"lights": false,
	}
	b, _ = msgpack.Marshal(missingCar)
	if _, err := ParseDrivingMove(b, "vasya"); err == nil {
		t.Fatal("expected error for missing car_id")
	}

	// Whitespace-only car_id
	whitespaceCar := map[string]any{
		"type":   "move",
		"mode":   "driving",
		"car_id": "   ",
		"x":      19.5,
		"y":      0.02,
		"z":      14.0,
		"speed":  22.4,
		"yaw":    1.57,
		"drift":  false,
		"lights": false,
	}
	b, _ = msgpack.Marshal(whitespaceCar)
	if _, err := ParseDrivingMove(b, "vasya"); err == nil {
		t.Fatal("expected error for whitespace-only car_id")
	}

	// Inf speed
	infSpeed := map[string]any{
		"type":   "move",
		"mode":   "driving",
		"car_id": "car_0",
		"x":      19.5,
		"y":      0.02,
		"z":      14.0,
		"speed":  math.Inf(1),
		"yaw":    1.57,
		"drift":  false,
		"lights": false,
	}
	b, _ = msgpack.Marshal(infSpeed)
	if _, err := ParseDrivingMove(b, "vasya"); err == nil {
		t.Fatal("expected error for Inf speed")
	}
}

func TestChatValidation(t *testing.T) {
	valid := map[string]any{
		"type": "chat",
		"text": "Го дрифтить у фонтана!",
	}
	b, err := msgpack.Marshal(valid)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}

	out, err := ParseChat(b, "vasya")
	if err != nil {
		t.Fatalf("unexpected chat error: %v", err)
	}
	if out.Username != "vasya" || out.From != "vasya" || out.Text != "Го дрифтить у фонтана!" {
		t.Fatalf("unexpected chat out: %+v", out)
	}

	// Empty text
	emptyText := map[string]any{
		"type": "chat",
		"text": "   ",
	}
	b, _ = msgpack.Marshal(emptyText)
	if _, err := ParseChat(b, "vasya"); err == nil {
		t.Fatal("expected error for empty chat text")
	}
}

func TestTrailingDataRejection(t *testing.T) {
	valid := map[string]any{
		"type": "chat",
		"text": "hello",
	}
	b, _ := msgpack.Marshal(valid)
	// Append extra bytes
	corrupted := append(b, []byte("extra")...)

	if _, err := ParseEnvelope(corrupted); err == nil {
		t.Fatal("expected ParseEnvelope to reject trailing bytes")
	}

	reg := map[string]any{
		"type":     "register",
		"username": "vasya",
	}
	bReg, _ := msgpack.Marshal(reg)
	corruptedReg := append(bReg, []byte("extra")...)
	if _, err := ParseRegister(corruptedReg); err == nil {
		t.Fatal("expected ParseRegister to reject trailing bytes")
	}
}

func TestNonMapRootRejection(t *testing.T) {
	// Array root instead of map
	arr := []string{"move", "pedestrian"}
	b, _ := msgpack.Marshal(arr)

	if _, err := ParseEnvelope(b); err == nil {
		t.Fatal("expected ParseEnvelope to reject array root")
	}
	if _, err := ParseRegister(b); err == nil {
		t.Fatal("expected ParseRegister to reject array root")
	}
}
