package game

import (
	"fmt"
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

	valid["anim"] = AnimSwim
	b, _ = msgpack.Marshal(valid)
	out, err = ParsePedestrianMove(b, "vasya")
	if err != nil || out.Anim != AnimSwim {
		t.Fatalf("swim animation should be accepted: %+v, %v", out, err)
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

func TestParseCannonFire(t *testing.T) {
	// Valid message
	valid := map[string]any{"type": TypeCannonFire}
	b, err := msgpack.Marshal(valid)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}
	out, err := ParseCannonFire(b)
	if err != nil {
		t.Fatalf("expected valid parse, got error: %v", err)
	}
	if out.Type != TypeCannonFire {
		t.Fatalf("expected type %q, got %q", TypeCannonFire, out.Type)
	}

	// Wrong type
	wrong := map[string]any{"type": "cannon_boom"}
	bWrong, _ := msgpack.Marshal(wrong)
	if _, err := ParseCannonFire(bWrong); err == nil {
		t.Fatal("expected error for wrong message type")
	}

	// Trailing data
	bTrailing := append(b, []byte("extra")...)
	if _, err := ParseCannonFire(bTrailing); err == nil {
		t.Fatal("expected error for trailing data")
	}

	// Non-map root
	arr := []string{"cannon_fire"}
	bArr, _ := msgpack.Marshal(arr)
	if _, err := ParseCannonFire(bArr); err == nil {
		t.Fatal("expected error for non-map root")
	}

	// Empty payload
	if _, err := ParseCannonFire([]byte{}); err == nil {
		t.Fatal("expected error for empty payload")
	}
}

func TestParsePoliceDialogueChoice(t *testing.T) {
	// Valid option 0 with trimmed whitespace
	b, err := msgpack.Marshal(map[string]any{
		"type":         TypePoliceDialogueChoice,
		"encounter_id": "  enc_1  ",
		"option_index": 0,
	})
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}
	req, err := ParsePoliceDialogueChoice(b)
	if err != nil {
		t.Fatalf("expected valid parse for option 0, got: %v", err)
	}
	if req.EncounterID != "enc_1" || req.OptionIndex != 0 {
		t.Fatalf("unexpected parsed request: %+v", req)
	}

	// Valid upper boundary option 15
	b15, _ := msgpack.Marshal(map[string]any{
		"type":         TypePoliceDialogueChoice,
		"encounter_id": "enc_15",
		"option_index": 15,
	})
	req15, err := ParsePoliceDialogueChoice(b15)
	if err != nil || req15.OptionIndex != 15 {
		t.Fatalf("expected valid parse for option 15, got %+v (err=%v)", req15, err)
	}

	// Invalid cases
	cases := []struct {
		name    string
		payload any
	}{
		{"missing option_index", map[string]any{"type": TypePoliceDialogueChoice, "encounter_id": "enc_1"}},
		{"nil option_index", map[string]any{"type": TypePoliceDialogueChoice, "encounter_id": "enc_1", "option_index": nil}},
		{"negative option_index", map[string]any{"type": TypePoliceDialogueChoice, "encounter_id": "enc_1", "option_index": -1}},
		{"out of range option_index", map[string]any{"type": TypePoliceDialogueChoice, "encounter_id": "enc_1", "option_index": 16}},
		{"float option_index", map[string]any{"type": TypePoliceDialogueChoice, "encounter_id": "enc_1", "option_index": 1.5}},
		{"missing encounter_id", map[string]any{"type": TypePoliceDialogueChoice, "option_index": 0}},
		{"whitespace encounter_id", map[string]any{"type": TypePoliceDialogueChoice, "encounter_id": "   ", "option_index": 0}},
		{"control char encounter_id", map[string]any{"type": TypePoliceDialogueChoice, "encounter_id": "enc\x001", "option_index": 0}},
		{"too long encounter_id", map[string]any{"type": TypePoliceDialogueChoice, "encounter_id": string(make([]rune, 65)), "option_index": 0}},
		{"wrong type", map[string]any{"type": TypeChat, "encounter_id": "enc_1", "option_index": 0}},
		{"non-map root", []any{TypePoliceDialogueChoice, "enc_1", 0}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := msgpack.Marshal(tc.payload)
			if err != nil {
				t.Fatalf("marshal error: %v", err)
			}
			if _, err := ParsePoliceDialogueChoice(raw); err == nil {
				t.Fatalf("expected error for %s, got nil", tc.name)
			}
		})
	}

	// Trailing bytes & empty payload
	if _, err := ParsePoliceDialogueChoice(append(b, 0x01)); err == nil {
		t.Fatal("expected error for trailing bytes")
	}
	if _, err := ParsePoliceDialogueChoice([]byte{}); err == nil {
		t.Fatal("expected error for empty payload")
	}
}

func TestPoliceMsgPackZeroAndNegativeValues(t *testing.T) {
	// 1. OutboundJoinMsg with Money: 0, negative, and nil
	zeroJoinBytes, err := MarshalMsgPack(OutboundJoinMsg{Type: TypeJoin, User: "vasya", Money: Int64Ptr(0)})
	if err != nil {
		t.Fatal(err)
	}
	var zeroJoinMap map[string]any
	if err := msgpack.Unmarshal(zeroJoinBytes, &zeroJoinMap); err != nil {
		t.Fatal(err)
	}
	if v, ok := zeroJoinMap["money"]; !ok || fmt.Sprint(v) != "0" {
		t.Fatalf("expected money=0 present on self-join, got %+v", zeroJoinMap)
	}

	negJoinBytes, _ := MarshalMsgPack(OutboundJoinMsg{Type: TypeJoin, User: "vasya", Money: Int64Ptr(-5000)})
	var negJoinMap map[string]any
	_ = msgpack.Unmarshal(negJoinBytes, &negJoinMap)
	if fmt.Sprint(negJoinMap["money"]) != "-5000" {
		t.Fatalf("expected money=-5000, got %+v", negJoinMap)
	}

	nilJoinBytes, _ := MarshalMsgPack(OutboundJoinMsg{Type: TypeJoin, User: "vasya"})
	var nilJoinMap map[string]any
	_ = msgpack.Unmarshal(nilJoinBytes, &nilJoinMap)
	if _, hasMoney := nilJoinMap["money"]; hasMoney {
		t.Fatalf("expected broadcast join without Money pointer to omit money key, got %+v", nilJoinMap)
	}

	// 2. OutboundBalanceUpdateMsg with 0 and negative values
	balBytes, _ := MarshalMsgPack(OutboundBalanceUpdateMsg{
		Type:     TypeBalanceUpdate,
		Username: "vasya",
		Money:    -2600,
		Delta:    0,
		Reason:   "test",
	})
	var balMap map[string]any
	_ = msgpack.Unmarshal(balBytes, &balMap)
	if fmt.Sprint(balMap["money"]) != "-2600" || fmt.Sprint(balMap["delta"]) != "0" {
		t.Fatalf("expected money=-2600 and delta=0 keys present, got %+v", balMap)
	}
	if _, hasSrc := balMap["source_id"]; hasSrc {
		t.Fatalf("expected empty source_id to be omitted, got %+v", balMap)
	}

	// 3. OutboundPoliceStateMsg with non-nil empty slices & zero values
	psBytes, _ := MarshalMsgPack(OutboundPoliceStateMsg{
		Type:         TypePoliceState,
		Sequence:     0,
		SampleTimeMS: 0,
		FootCops:     make([]PoliceFootCopState, 0),
		PoliceCars:   make([]PoliceCarState, 0),
		VehicleBans:  make([]VehicleBanState, 0),
	})
	var psMap map[string]any
	_ = msgpack.Unmarshal(psBytes, &psMap)
	if _, ok := psMap["sequence"]; !ok {
		t.Fatalf("expected zero sequence key present: %+v", psMap)
	}
	if _, ok := psMap["sample_time_ms"]; !ok {
		t.Fatalf("expected zero sample_time_ms key present: %+v", psMap)
	}
	fcSlice, ok := psMap["foot_cops"].([]any)
	if !ok || fcSlice == nil {
		t.Fatalf("expected foot_cops encoded as non-nil empty array, got %#v", psMap["foot_cops"])
	}
	pcSlice, ok := psMap["police_cars"].([]any)
	if !ok || pcSlice == nil {
		t.Fatalf("expected police_cars encoded as non-nil empty array, got %#v", psMap["police_cars"])
	}
	vbSlice, ok := psMap["vehicle_bans"].([]any)
	if !ok || vbSlice == nil {
		t.Fatalf("expected vehicle_bans encoded as non-nil empty array, got %#v", psMap["vehicle_bans"])
	}

	// 4. OutboundPoliceEncounterStartMsg with Russian UTF-8 (str16 >255 bytes), traffic kind, blocks_vehicle, and fine=0
	longRussian := "Здравия желаю, сержант ППС Дробышев. Ориентировка по Спортивной набережной: не видели ли вы тут молодого человека в чёрной ветровке и тёмных спортивных штанах? Говорят, ушёл от Юбилейного пляжа в сторону кинотеатра Океан и улицы Адмирала Фокина на Набке."
	encBytes, _ := MarshalMsgPack(OutboundPoliceEncounterStartMsg{
		Type:          TypePoliceEncounterStart,
		EncounterID:   "enc_1",
		CopID:         "dps_police_car_0",
		CopName:       "Инспектор ДПС Соколов",
		ScenarioID:    "traffic_speeding",
		Title:         "Остановка ДПС: превышение скорости",
		Opening:       longRussian,
		Options:       []PoliceDialogueOptionView{{Index: 0, Text: "Оформляйте", Fine: 5000, BlocksVehicle: true}},
		TargetUser:    "vasya",
		EncounterKind: EncounterKindTraffic,
		CarID:         "car_0",
	})
	var encMap map[string]any
	_ = msgpack.Unmarshal(encBytes, &encMap)
	if encMap["opening"] != longRussian || encMap["encounter_kind"] != EncounterKindTraffic || encMap["car_id"] != "car_0" {
		t.Fatalf("traffic police_encounter_start round-trip mismatch: %+v", encMap)
	}

	// 5. OutboundPoliceEncounterResultMsg, OutboundPoliceFineStopMsg, OutboundPoliceChaseMsg, OutboundVehicleImpulseMsg zero/negative fields
	resBytes, _ := MarshalMsgPack(OutboundPoliceEncounterResultMsg{
		Type:           TypePoliceEncounterResult,
		EncounterID:    "enc_1",
		CopID:          "dps_police_car_0",
		CopName:        "Инспектор ДПС Соколов",
		ScenarioID:     "traffic_speeding",
		TargetUser:     "vasya",
		OptionIndex:    0,
		ReplyText:      "Запрет",
		Fine:           0,
		Money:          -2500,
		CarID:          "car_0",
		VehicleBlocked: true,
		VehicleBanSec:  300,
	})
	var resMap map[string]any
	_ = msgpack.Unmarshal(resBytes, &resMap)
	if fmt.Sprint(resMap["option_index"]) != "0" || fmt.Sprint(resMap["fine"]) != "0" || fmt.Sprint(resMap["money"]) != "-2500" ||
		resMap["vehicle_blocked"] != true || fmt.Sprint(resMap["vehicle_ban_sec"]) != "300" {
		t.Fatalf("expected zero option_index/fine, negative money, and ban fields, got %+v", resMap)
	}

	fsBytes, _ := MarshalMsgPack(OutboundPoliceFineStopMsg{
		Type:        TypePoliceFineStop,
		Stage:       "approaching",
		PoliceCarID: "police_car_0",
		CarID:       "car_0",
		OfficerID:   "dps_police_car_0",
		OfficerName: "Инспектор ДПС Соколов",
		TargetUser:  "vasya",
		ExitX:       0,
		ExitZ:       0,
		ExitYaw:     0,
		Reason:      "speeding",
	})
	var fsMap map[string]any
	_ = msgpack.Unmarshal(fsBytes, &fsMap)
	for _, k := range []string{"stage", "police_car_id", "car_id", "officer_id", "officer_name", "target_user", "exit_x", "exit_z", "exit_yaw", "reason"} {
		if _, ok := fsMap[k]; !ok {
			t.Fatalf("expected key %q present on zero-coord police_fine_stop, got %+v", k, fsMap)
		}
	}
	if fsMap["officer_name"] != "Инспектор ДПС Соколов" {
		t.Fatalf("expected Russian officer_name preserved, got %v", fsMap["officer_name"])
	}

	chaseBytes, _ := MarshalMsgPack(OutboundPoliceChaseMsg{
		Type:        TypePoliceChase,
		PoliceCarID: "police_car_0",
		TargetCarID: "car_0",
		TargetUser:  "vasya",
		Status:      ChaseStatusEvaded,
		Reason:      "evaded",
		Fine:        0,
		Money:       -1000,
	})
	var chaseMap map[string]any
	_ = msgpack.Unmarshal(chaseBytes, &chaseMap)
	if fmt.Sprint(chaseMap["fine"]) != "0" || fmt.Sprint(chaseMap["money"]) != "-1000" {
		t.Fatalf("expected fine=0 and money=-1000 on chase, got %+v", chaseMap)
	}

	impBytes, _ := MarshalMsgPack(OutboundVehicleImpulseMsg{
		Type:        TypeVehicleImpulse,
		PoliceCarID: "police_car_0",
		CarID:       "car_0",
		TargetUser:  "vasya",
		DVX:         0,
		DVZ:         0,
		DYawRate:    0,
		PoliceMass:  4200,
		PlayerMass:  1450,
		Sequence:    0,
	})
	var impMap map[string]any
	_ = msgpack.Unmarshal(impBytes, &impMap)
	for _, k := range []string{"dvx", "dvz", "dyaw_rate", "police_mass", "player_mass", "sequence"} {
		if _, ok := impMap[k]; !ok {
			t.Fatalf("expected key %q present on zero vehicle_impulse, got %+v", k, impMap)
		}
	}
}
