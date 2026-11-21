package game

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"strings"
	"unicode/utf8"

	"github.com/vmihailenco/msgpack/v5"
)

// Standard anim values for pedestrian dead-reckoning
const (
	AnimIdle  = "idle"
	AnimWalk  = "walk"
	AnimRun   = "run"
	AnimJump  = "jump"
	AnimSwim  = "swim"
	AnimEmote = "emote"
)

// Standard message types
const (
	TypeRegister              = "register"
	TypeJoin                  = "join"
	TypeLeave                 = "leave"
	TypeMove                  = "move"
	TypeChat                  = "chat"
	TypeError                 = "error"
	TypePing                  = "ping"
	TypePong                  = "pong"
	TypeCannonFire            = "cannon_fire"
	TypeCannonShot            = "cannon_shot"
	TypeBalanceUpdate         = "balance_update"
	TypePoliceState           = "police_state"
	TypePoliceEncounterStart  = "police_encounter_start"
	TypePoliceDialogueChoice  = "police_dialogue_choice"
	TypePoliceEncounterResult = "police_encounter_result"
	TypePoliceChase           = "police_chase"
	TypeVehicleImpulse        = "vehicle_impulse"
)

// Foot cop simulation states
const (
	CopStatePatrol   = "patrol"
	CopStateApproach = "approach"
	CopStateDialogue = "dialogue"
	CopStateCooldown = "cooldown"
)

// Police car simulation states
const (
	PoliceCarStatePatrol   = "patrol"
	PoliceCarStateChase    = "chase"
	PoliceCarStateCooldown = "cooldown"
)

// Police chase event statuses
const (
	ChaseStatusStarted = "started"
	ChaseStatusStopped = "stopped"
	ChaseStatusEvaded  = "evaded"
)

// Modes for movement
const (
	ModePedestrian = "pedestrian"
	ModeDriving    = "driving"
)

// Disconnect reasons
const (
	ReasonLeft       = "left"
	ReasonInactivity = "kicked for 30s inactivity"
)

// Envelope inspects inbound message type and mode without failing on unknown fields.
type Envelope struct {
	Type     string `msgpack:"type"`
	Mode     string `msgpack:"mode,omitempty"`
	Username string `msgpack:"username,omitempty"`
}

// InboundRegisterMsg is sent by clients connecting without query parameter.
type InboundRegisterMsg struct {
	Type     string `msgpack:"type,omitempty"`
	Username string `msgpack:"username"`
	Token    string `msgpack:"token,omitempty"`
}

// InboundPedestrianMoveMsg represents an incoming pedestrian update.
type InboundPedestrianMoveMsg struct {
	Type     string   `msgpack:"type"`
	Username string   `msgpack:"username,omitempty"`
	Mode     string   `msgpack:"mode"`
	X        *float64 `msgpack:"x"`
	Y        *float64 `msgpack:"y"`
	Z        *float64 `msgpack:"z"`
	VX       *float64 `msgpack:"vx,omitempty"`
	VZ       *float64 `msgpack:"vz,omitempty"`
	Yaw      *float64 `msgpack:"yaw"`
	Anim     *string  `msgpack:"anim"`
}

// InboundDrivingMoveMsg represents an incoming vehicle update.
type InboundDrivingMoveMsg struct {
	Type     string   `msgpack:"type"`
	Username string   `msgpack:"username,omitempty"`
	Mode     string   `msgpack:"mode"`
	CarID    *string  `msgpack:"car_id"`
	X        *float64 `msgpack:"x"`
	Y        *float64 `msgpack:"y"`
	Z        *float64 `msgpack:"z"`
	Speed    *float64 `msgpack:"speed"`
	Yaw      *float64 `msgpack:"yaw"`
	Drift    *bool    `msgpack:"drift"`
	Lights   *bool    `msgpack:"lights"`
	VX       *float64 `msgpack:"vx"`
	VZ       *float64 `msgpack:"vz"`
	YawRate  *float64 `msgpack:"yaw_rate"`
}

// InboundChatMsg represents an incoming chat message.
type InboundChatMsg struct {
	Type     string `msgpack:"type"`
	Username string `msgpack:"username,omitempty"`
	Text     string `msgpack:"text"`
}

// InboundCannonFireMsg represents a request from a client to fire the fortress cannon.
type InboundCannonFireMsg struct {
	Type string `msgpack:"type"`
}

// InboundPoliceDialogueChoiceMsg represents a client response to an active police encounter.
type InboundPoliceDialogueChoiceMsg struct {
	Type        string  `msgpack:"type"`
	EncounterID *string `msgpack:"encounter_id"`
	OptionIndex *int    `msgpack:"option_index"`
}

// PoliceDialogueChoiceRequest holds validated police dialogue choice parameters.
type PoliceDialogueChoiceRequest struct {
	EncounterID string
	OptionIndex int
}

// Int64Ptr returns a pointer to v (used for optional wire fields where 0/negative must serialize).
func Int64Ptr(v int64) *int64 {
	return &v
}

// OutboundJoinMsg broadcasts when a user connects.
type OutboundJoinMsg struct {
	Type   string   `msgpack:"type"`
	User   string   `msgpack:"user"`
	Token  string   `msgpack:"token,omitempty"`
	Roster []string `msgpack:"roster,omitempty"`
	Money  *int64   `msgpack:"money,omitempty"`
}

// OutboundLeaveMsg broadcasts when a user disconnects or times out.
type OutboundLeaveMsg struct {
	Type   string `msgpack:"type"`
	User   string `msgpack:"user"`
	Reason string `msgpack:"reason"`
}

// OutboundPedestrianMoveMsg broadcasts verified pedestrian movement.
type OutboundPedestrianMoveMsg struct {
	Username string  `msgpack:"username"`
	Type     string  `msgpack:"type"`
	Mode     string  `msgpack:"mode"`
	X        float64 `msgpack:"x"`
	Y        float64 `msgpack:"y"`
	Z        float64 `msgpack:"z"`
	VX       float64 `msgpack:"vx"`
	VZ       float64 `msgpack:"vz"`
	Yaw      float64 `msgpack:"yaw"`
	Anim     string  `msgpack:"anim"`
}

// OutboundDrivingMoveMsg broadcasts verified vehicle movement.
type OutboundDrivingMoveMsg struct {
	Username     string  `msgpack:"username"`
	Type         string  `msgpack:"type"`
	Mode         string  `msgpack:"mode"`
	CarID        string  `msgpack:"car_id"`
	X            float64 `msgpack:"x"`
	Y            float64 `msgpack:"y"`
	Z            float64 `msgpack:"z"`
	Speed        float64 `msgpack:"speed"`
	Yaw          float64 `msgpack:"yaw"`
	Drift        bool    `msgpack:"drift"`
	Lights       bool    `msgpack:"lights"`
	VX           float64 `msgpack:"vx"`
	VZ           float64 `msgpack:"vz"`
	YawRate      float64 `msgpack:"yaw_rate"`
	Sequence     uint64  `msgpack:"sequence"`
	SampleTimeMS float64 `msgpack:"sample_time_ms"`
}

// OutboundChatMsg forwards verified chat to display in chat and speech bubbles.
type OutboundChatMsg struct {
	Username string `msgpack:"username"`
	Type     string `msgpack:"type"`
	From     string `msgpack:"from"`
	Text     string `msgpack:"text"`
}

// OutboundErrorMsg delivers errors directly to a client.
type OutboundErrorMsg struct {
	Type    string `msgpack:"type"`
	Message string `msgpack:"message"`
	Op      string `msgpack:"op,omitempty"`
}

// OutboundCannonShotMsg broadcasts a confirmed cannon shot to all connected clients.
type OutboundCannonShotMsg struct {
	Type   string `msgpack:"type"`
	User   string `msgpack:"user,omitempty"`
	Reason string `msgpack:"reason"`
}

// OutboundBalanceUpdateMsg notifies clients of an authoritative wallet change.
type OutboundBalanceUpdateMsg struct {
	Type     string `msgpack:"type"`
	Username string `msgpack:"username"`
	Money    int64  `msgpack:"money"`
	Delta    int64  `msgpack:"delta"`
	Reason   string `msgpack:"reason"`
	SourceID string `msgpack:"source_id,omitempty"`
}

// PoliceFootCopState represents a single foot policeman's replicated simulation state.
type PoliceFootCopState struct {
	ID         string  `msgpack:"id"`
	Name       string  `msgpack:"name"`
	X          float64 `msgpack:"x"`
	Y          float64 `msgpack:"y"`
	Z          float64 `msgpack:"z"`
	VX         float64 `msgpack:"vx"`
	VZ         float64 `msgpack:"vz"`
	Yaw        float64 `msgpack:"yaw"`
	State      string  `msgpack:"state"`
	Anim       string  `msgpack:"anim"`
	TargetUser string  `msgpack:"target_user"`
}

// PoliceCarState represents a single police car's replicated simulation state.
type PoliceCarState struct {
	ID          string  `msgpack:"id"`
	X           float64 `msgpack:"x"`
	Y           float64 `msgpack:"y"`
	Z           float64 `msgpack:"z"`
	VX          float64 `msgpack:"vx"`
	VZ          float64 `msgpack:"vz"`
	Yaw         float64 `msgpack:"yaw"`
	YawRate     float64 `msgpack:"yaw_rate"`
	Speed       float64 `msgpack:"speed"`
	Mass        float64 `msgpack:"mass"`
	State       string  `msgpack:"state"`
	TargetCarID string  `msgpack:"target_car_id"`
	TargetUser  string  `msgpack:"target_user"`
	Siren       bool    `msgpack:"siren"`
	Lights      bool    `msgpack:"lights"`
}

// OutboundPoliceStateMsg broadcasts authoritative police world state at 20 Hz and on join baseline.
type OutboundPoliceStateMsg struct {
	Type         string               `msgpack:"type"`
	Sequence     uint64               `msgpack:"sequence"`
	SampleTimeMS int64                `msgpack:"sample_time_ms"`
	FootCops     []PoliceFootCopState `msgpack:"foot_cops"`
	PoliceCars   []PoliceCarState     `msgpack:"police_cars"`
}

// PoliceDialogueOptionView is a single selectable dialogue option sent to the target player.
type PoliceDialogueOptionView struct {
	Index int    `msgpack:"index"`
	Text  string `msgpack:"text"`
	Fine  int64  `msgpack:"fine"`
}

// OutboundPoliceEncounterStartMsg initiates an unsolicited Russian police encounter with target_user.
type OutboundPoliceEncounterStartMsg struct {
	Type        string                     `msgpack:"type"`
	EncounterID string                     `msgpack:"encounter_id"`
	CopID       string                     `msgpack:"cop_id"`
	CopName     string                     `msgpack:"cop_name"`
	ScenarioID  string                     `msgpack:"scenario_id"`
	Title       string                     `msgpack:"title"`
	Opening     string                     `msgpack:"opening"`
	Options     []PoliceDialogueOptionView `msgpack:"options"`
	TargetUser  string                     `msgpack:"target_user"`
}

// OutboundPoliceEncounterResultMsg broadcasts the outcome of a police encounter choice.
type OutboundPoliceEncounterResultMsg struct {
	Type        string `msgpack:"type"`
	EncounterID string `msgpack:"encounter_id"`
	CopID       string `msgpack:"cop_id"`
	CopName     string `msgpack:"cop_name"`
	ScenarioID  string `msgpack:"scenario_id"`
	TargetUser  string `msgpack:"target_user"`
	OptionIndex int    `msgpack:"option_index"`
	ReplyText   string `msgpack:"reply_text"`
	Fine        int64  `msgpack:"fine"`
	Money       int64  `msgpack:"money"`
}

// OutboundPoliceChaseMsg broadcasts police car chase lifecycle transitions.
type OutboundPoliceChaseMsg struct {
	Type        string `msgpack:"type"`
	PoliceCarID string `msgpack:"police_car_id"`
	TargetCarID string `msgpack:"target_car_id"`
	TargetUser  string `msgpack:"target_user"`
	Status      string `msgpack:"status"`
	Reason      string `msgpack:"reason"`
	Fine        int64  `msgpack:"fine"`
	Money       int64  `msgpack:"money"`
}

// OutboundVehicleImpulseMsg notifies clients of a server-resolved heavy police collision impulse.
type OutboundVehicleImpulseMsg struct {
	Type        string  `msgpack:"type"`
	PoliceCarID string  `msgpack:"police_car_id"`
	CarID       string  `msgpack:"car_id"`
	TargetUser  string  `msgpack:"target_user"`
	DVX         float64 `msgpack:"dvx"`
	DVZ         float64 `msgpack:"dvz"`
	DYawRate    float64 `msgpack:"dyaw_rate"`
	PoliceMass  float64 `msgpack:"police_mass"`
	PlayerMass  float64 `msgpack:"player_mass"`
	Sequence    uint64  `msgpack:"sequence"`
}

// CarState tracks the last seen world position and state of a vehicle.
type CarState struct {
	CarID        string  `msgpack:"car_id"`
	X            float64 `msgpack:"x"`
	Y            float64 `msgpack:"y"`
	Z            float64 `msgpack:"z"`
	Speed        float64 `msgpack:"speed"`
	Yaw          float64 `msgpack:"yaw"`
	Drift        bool    `msgpack:"drift"`
	Lights       bool    `msgpack:"lights"`
	Driver       string  `msgpack:"driver,omitempty"` // Active driver username, or empty if parked
	VX           float64 `msgpack:"vx"`
	VZ           float64 `msgpack:"vz"`
	YawRate      float64 `msgpack:"yaw_rate"`
	Sequence     uint64  `msgpack:"sequence"`
	SampleTimeMS float64 `msgpack:"sample_time_ms"`
}

// UserState tracks the last seen movement state of an active player.
type UserState struct {
	Username     string  `msgpack:"username"`
	Mode         string  `msgpack:"mode"` // ModePedestrian or ModeDriving
	CarID        string  `msgpack:"car_id,omitempty"`
	X            float64 `msgpack:"x"`
	Y            float64 `msgpack:"y"`
	Z            float64 `msgpack:"z"`
	VX           float64 `msgpack:"vx,omitempty"`
	VZ           float64 `msgpack:"vz,omitempty"`
	Speed        float64 `msgpack:"speed,omitempty"`
	Yaw          float64 `msgpack:"yaw"`
	Anim         string  `msgpack:"anim,omitempty"`
	Drift        bool    `msgpack:"drift,omitempty"`
	Lights       bool    `msgpack:"lights,omitempty"`
	YawRate      float64 `msgpack:"yaw_rate"`
	Sequence     uint64  `msgpack:"sequence"`
	SampleTimeMS float64 `msgpack:"sample_time_ms"`
}

// Validation helpers

// ValidateMsgPackMap verifies the payload starts with a MsgPack map header.
func ValidateMsgPackMap(data []byte) error {
	if len(data) == 0 {
		return errors.New("empty payload")
	}
	b := data[0]
	// 0x80..0x8f = fixmap, 0xde = map 16, 0xdf = map 32
	if (b >= 0x80 && b <= 0x8f) || b == 0xde || b == 0xdf {
		return nil
	}
	return errors.New("payload root must be a msgpack map")
}

func IsFinite(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
}

func ValidateUsername(name string) (string, error) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return "", errors.New("username cannot be empty or whitespace")
	}
	if !utf8.ValidString(trimmed) {
		return "", errors.New("username must be valid UTF-8")
	}
	if utf8.RuneCountInString(trimmed) < 1 || utf8.RuneCountInString(trimmed) > 32 {
		return "", errors.New("username must be between 1 and 32 characters")
	}
	if strings.EqualFold(trimmed, "server") {
		return "", errors.New("username 'server' is reserved")
	}
	// Disallow control characters
	for _, r := range trimmed {
		if r < 32 || r == 127 {
			return "", errors.New("username contains invalid control characters")
		}
	}
	return trimmed, nil
}

func ValidateAnim(anim string) bool {
	switch anim {
	case AnimIdle, AnimWalk, AnimRun, AnimJump, AnimSwim, AnimEmote:
		return true
	default:
		return false
	}
}

// ParseEnvelope decodes the envelope and verifies root is a MsgPack map with no trailing bytes.
func ParseEnvelope(data []byte) (*Envelope, error) {
	if err := ValidateMsgPackMap(data); err != nil {
		return nil, err
	}

	reader := bytes.NewReader(data)
	dec := msgpack.NewDecoder(reader)

	var env Envelope
	if err := dec.Decode(&env); err != nil {
		return nil, fmt.Errorf("invalid msgpack envelope: %w", err)
	}

	// Verify no trailing data
	if reader.Len() > 0 {
		return nil, errors.New("unexpected trailing bytes after msgpack object")
	}

	if env.Type == "" {
		return nil, errors.New("missing message type")
	}

	return &env, nil
}

// NormalizeYaw bounds any finite angle strictly into [-pi, pi] in constant time.
func NormalizeYaw(yaw float64) float64 {
	return math.Atan2(math.Sin(yaw), math.Cos(yaw))
}

// ParsePedestrianMove decodes and strictly validates pedestrian movement.
func ParsePedestrianMove(data []byte, verifiedUsername string) (*OutboundPedestrianMoveMsg, error) {
	reader := bytes.NewReader(data)
	dec := msgpack.NewDecoder(reader)

	var in InboundPedestrianMoveMsg
	if err := dec.Decode(&in); err != nil {
		return nil, fmt.Errorf("failed to decode pedestrian move: %w", err)
	}

	if in.Mode != ModePedestrian {
		return nil, fmt.Errorf("expected mode %q, got %q", ModePedestrian, in.Mode)
	}
	if in.X == nil || in.Y == nil || in.Z == nil || in.Yaw == nil || in.Anim == nil {
		return nil, errors.New("missing required pedestrian fields (x, y, z, yaw, anim)")
	}

	if !IsFinite(*in.X) || !IsFinite(*in.Y) || !IsFinite(*in.Z) || !IsFinite(*in.Yaw) {
		return nil, errors.New("pedestrian coordinates or yaw must be finite numbers")
	}

	var vx, vz float64
	if in.VX != nil {
		if !IsFinite(*in.VX) {
			return nil, errors.New("vx must be finite")
		}
		vx = *in.VX
	}
	if in.VZ != nil {
		if !IsFinite(*in.VZ) {
			return nil, errors.New("vz must be finite")
		}
		vz = *in.VZ
	}

	anim := strings.TrimSpace(*in.Anim)
	if !ValidateAnim(anim) {
		return nil, fmt.Errorf("invalid anim %q: must be idle, walk, run, jump, swim, or emote", anim)
	}

	return &OutboundPedestrianMoveMsg{
		Username: verifiedUsername,
		Type:     TypeMove,
		Mode:     ModePedestrian,
		X:        *in.X,
		Y:        *in.Y,
		Z:        *in.Z,
		VX:       vx,
		VZ:       vz,
		Yaw:      NormalizeYaw(*in.Yaw),
		Anim:     anim,
	}, nil
}

// ParseDrivingMove decodes and strictly validates driving movement.
func ParseDrivingMove(data []byte, verifiedUsername string) (*OutboundDrivingMoveMsg, error) {
	reader := bytes.NewReader(data)
	dec := msgpack.NewDecoder(reader)

	var in InboundDrivingMoveMsg
	if err := dec.Decode(&in); err != nil {
		return nil, fmt.Errorf("failed to decode driving move: %w", err)
	}

	if in.Mode != ModeDriving {
		return nil, fmt.Errorf("expected mode %q, got %q", ModeDriving, in.Mode)
	}
	if in.CarID == nil {
		return nil, errors.New("missing car_id")
	}
	carID := strings.TrimSpace(*in.CarID)
	if carID == "" {
		return nil, errors.New("car_id cannot be empty or whitespace")
	}
	if !utf8.ValidString(carID) || utf8.RuneCountInString(carID) > 64 {
		return nil, errors.New("car_id must be valid UTF-8 and up to 64 characters")
	}

	if in.X == nil || in.Y == nil || in.Z == nil || in.Speed == nil || in.Yaw == nil || in.Drift == nil || in.Lights == nil {
		return nil, errors.New("missing required driving fields (car_id, x, y, z, speed, yaw, drift, lights)")
	}

	if !IsFinite(*in.X) || !IsFinite(*in.Y) || !IsFinite(*in.Z) || !IsFinite(*in.Speed) || !IsFinite(*in.Yaw) {
		return nil, errors.New("driving coordinates, speed, or yaw must be finite numbers")
	}

	vx, vz, yawRate := math.Sin(*in.Yaw)*(*in.Speed), math.Cos(*in.Yaw)*(*in.Speed), 0.0
	for _, field := range []struct {
		value  *float64
		target *float64
	}{{in.VX, &vx}, {in.VZ, &vz}, {in.YawRate, &yawRate}} {
		if field.value != nil {
			if !IsFinite(*field.value) {
				return nil, errors.New("vehicle velocity and yaw_rate must be finite")
			}
			*field.target = *field.value
		}
	}
	return &OutboundDrivingMoveMsg{
		VX: vx, VZ: vz, YawRate: yawRate,
		Username: verifiedUsername,
		Type:     TypeMove,
		Mode:     ModeDriving,
		CarID:    carID,
		X:        *in.X,
		Y:        *in.Y,
		Z:        *in.Z,
		Speed:    *in.Speed,
		Yaw:      NormalizeYaw(*in.Yaw),
		Drift:    *in.Drift,
		Lights:   *in.Lights,
	}, nil
}

// ParseChat decodes and validates chat messages.
func ParseChat(data []byte, verifiedUsername string) (*OutboundChatMsg, error) {
	reader := bytes.NewReader(data)
	dec := msgpack.NewDecoder(reader)

	var in InboundChatMsg
	if err := dec.Decode(&in); err != nil {
		return nil, fmt.Errorf("failed to decode chat message: %w", err)
	}

	text := strings.TrimSpace(in.Text)
	if text == "" {
		return nil, errors.New("chat text cannot be empty or whitespace")
	}
	if !utf8.ValidString(text) {
		return nil, errors.New("chat text must be valid UTF-8")
	}
	if utf8.RuneCountInString(text) > 500 {
		return nil, errors.New("chat text exceeds maximum length of 500 characters")
	}

	return &OutboundChatMsg{
		Username: verifiedUsername,
		Type:     TypeChat,
		From:     verifiedUsername,
		Text:     text,
	}, nil
}

// ParseCannonFire decodes and strictly validates cannon fire requests.
func ParseCannonFire(data []byte) (*InboundCannonFireMsg, error) {
	if err := ValidateMsgPackMap(data); err != nil {
		return nil, err
	}

	reader := bytes.NewReader(data)
	dec := msgpack.NewDecoder(reader)

	var in InboundCannonFireMsg
	if err := dec.Decode(&in); err != nil {
		return nil, fmt.Errorf("failed to decode cannon fire: %w", err)
	}

	if reader.Len() > 0 {
		return nil, errors.New("unexpected trailing bytes after cannon fire message")
	}

	if in.Type != TypeCannonFire {
		return nil, fmt.Errorf("expected type %q, got %q", TypeCannonFire, in.Type)
	}

	return &in, nil
}

// RegisterRequest represents validated registration parameters.
type RegisterRequest struct {
	Username string
	Token    string
}

// ParseRegisterRequest parses an inbound register msgpack payload.
func ParseRegisterRequest(data []byte) (*RegisterRequest, error) {
	if err := ValidateMsgPackMap(data); err != nil {
		return nil, err
	}

	reader := bytes.NewReader(data)
	dec := msgpack.NewDecoder(reader)

	var in InboundRegisterMsg
	if err := dec.Decode(&in); err != nil {
		return nil, fmt.Errorf("failed to decode register message: %w", err)
	}

	if reader.Len() > 0 {
		return nil, errors.New("unexpected trailing bytes after register message")
	}

	if in.Type != "" && in.Type != TypeRegister {
		return nil, fmt.Errorf("expected type %q, got %q", TypeRegister, in.Type)
	}

	validUsername, err := ValidateUsername(in.Username)
	if err != nil {
		return nil, err
	}

	return &RegisterRequest{
		Username: validUsername,
		Token:    strings.TrimSpace(in.Token),
	}, nil
}

// ParseRegister decodes an initial register message with map root and exact EOF validation.
func ParseRegister(data []byte) (string, error) {
	req, err := ParseRegisterRequest(data)
	if err != nil {
		return "", err
	}
	return req.Username, nil
}

// ParsePoliceDialogueChoice decodes and strictly validates a client's police dialogue option selection.
func ParsePoliceDialogueChoice(data []byte) (*PoliceDialogueChoiceRequest, error) {
	if err := ValidateMsgPackMap(data); err != nil {
		return nil, err
	}

	reader := bytes.NewReader(data)
	dec := msgpack.NewDecoder(reader)

	var in InboundPoliceDialogueChoiceMsg
	if err := dec.Decode(&in); err != nil {
		return nil, fmt.Errorf("failed to decode police dialogue choice: %w", err)
	}

	if reader.Len() > 0 {
		return nil, errors.New("unexpected trailing bytes after police dialogue choice")
	}

	if in.Type != TypePoliceDialogueChoice {
		return nil, fmt.Errorf("expected type %q, got %q", TypePoliceDialogueChoice, in.Type)
	}

	if in.EncounterID == nil {
		return nil, errors.New("missing encounter_id")
	}
	encID := strings.TrimSpace(*in.EncounterID)
	if encID == "" {
		return nil, errors.New("encounter_id cannot be empty or whitespace")
	}
	if !utf8.ValidString(encID) {
		return nil, errors.New("encounter_id must be valid UTF-8")
	}
	if rc := utf8.RuneCountInString(encID); rc < 1 || rc > 64 {
		return nil, errors.New("encounter_id must be between 1 and 64 characters")
	}
	for _, r := range encID {
		if r < 32 || r == 127 {
			return nil, errors.New("encounter_id contains invalid control characters")
		}
	}

	if in.OptionIndex == nil {
		return nil, errors.New("missing option_index")
	}
	if *in.OptionIndex < 0 || *in.OptionIndex > 15 {
		return nil, errors.New("option_index must be between 0 and 15")
	}

	return &PoliceDialogueChoiceRequest{
		EncounterID: encID,
		OptionIndex: *in.OptionIndex,
	}, nil
}

// MarshalMsgPack wraps msgpack.Marshal
func MarshalMsgPack(v any) ([]byte, error) {
	return msgpack.Marshal(v)
}
