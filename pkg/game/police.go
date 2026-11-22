package game

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"sort"
	"strings"

	"nabka"
)

// Police simulation, speed-limit, and vehicle collision constants matching static/js/physics.js.
const (
	DefaultInitialMoney int64 = 125400

	PoliceSpeedLimitKMH = 40.0
	PoliceSpeedLimitMS  = PoliceSpeedLimitKMH / 3.6 // 11.11111111111111 m/s

	PoliceCarMass        = 4200.0
	PlayerCarDefaultMass = 1450.0
	CarLength            = 4.8
	CarWidth             = 2.3
	CarWheelbase         = 2.7
	CarAxleOffset        = 1.18
	CarCollisionRadius   = 0.96
	CarRestitution       = 0.25

	PoliceMaxSpeedForward = 44.44
	PoliceMaxSpeedBoost   = 55.56
	PoliceMaxSpeedReverse = -10.0
	PoliceAccelForward    = 24.0
	PoliceAccelBoost      = 32.0
	PoliceAccelBrake      = 12.0
	PoliceAccelReverse    = 8.0
	PoliceDragRoll        = 1.4
	PoliceDragAero        = 0.002
	PoliceMuGrip          = 1.15
	PoliceLatDampingGrip  = 12.0
	PoliceSteerGain       = 0.52

	PolicePatrolSpeed    = 9.0 // 32.4 km/h (< 40 km/h)
	PoliceDetectRadius   = 45.0
	PoliceStopDist       = 7.5
	PoliceStopSpeedMS    = 3.0
	PoliceStopHoldSec    = 0.5
	PoliceEvadeDist      = 90.0
	PoliceEvadeHoldSec   = 5.0
	PoliceMaxChaseSec    = 45.0
	PoliceSpeedingFine   = int64(5000)
	PoliceCarCooldownSec = 8.0
	PoliceTargetGraceSec = 6.0
	ImpulseCooldownSec   = 0.300 // 300ms per-pair impulse cooldown

	FootCopDetectRadius        = 12.0
	FootCopTalkRadius          = 2.4
	FootCopAbandonRadius       = 20.0
	FootCopApproachMaxDuration = 15.0
	FootCopPatrolSpeed         = 1.6
	FootCopApproachSpeed       = 3.4
	FootCopDialogueTimeout     = 45.0
	FootCopCooldownDuration    = 12.0
	PlayerEncounterCooldown    = 15.0
	FootCopCollisionRadius     = 0.52
	FootCopMinX                = -14.0
	FootCopMaxX                = 290.0
	FootCopMinZ                = -165.0
	FootCopMaxZ                = 165.0
)

func readStaticDataFile(diskPath, embeddedPath string) ([]byte, error) {
	if raw, err := os.ReadFile(diskPath); err == nil {
		return raw, nil
	}
	return fs.ReadFile(nabka.FS(), embeddedPath)
}

type worldBoundsRect struct {
	minX float64
	maxX float64
	minZ float64
	maxZ float64
}

type worldCollider struct {
	isCircle bool
	id       string
	x        float64
	z        float64
	radius   float64
	halfW    float64
	halfD    float64
	minY     float64
	height   float64
	rotY     float64
}

type worldMapConfig struct {
	vehicleIDs    []string
	vehicleMasses map[string]float64
	fortress      fortressCoords
	vehicleBounds worldBoundsRect
	colliders     []worldCollider
}

type localBounds struct {
	minX, maxX float64
	minY, maxY float64
	minZ, maxZ float64
}

var defaultModelBounds = map[string]localBounds{
	"models/arbat_paving.glb":         {-14, 14, -0.06, 0.06, -7, 7},
	"models/azimut_hotel.glb":         {-7.5, 7, 0, 28, -15, 15},
	"models/bench.glb":                {-0.45, 0.45, -0.325, 0.325, -1.3, 1.3},
	"models/bridge_deck.glb":          {-80, 80, -0.9, 0.9, -3, 3},
	"models/bridge_pylon.glb":         {-12.329, 12.329, -1.891, 65.821, -1.6, 1.6},
	"models/dynamo_stadium.glb":       {-18.625, 18, 0, 19, -28, 28},
	"models/ferris_wheel.glb":         {-14.4, 14.4, -0.844, 33.9, -2.7, 2.7},
	"models/fortress_museum.glb":      {-5.502, 11, 0, 7.3, -11, 11},
	"models/fountain.glb":             {-10.2, 10.2, 0, 2, -10.2, 10.2},
	"models/lighthouse.glb":           {-5.5, 49.5, -0.4, 18, -3, 3},
	"models/ocean_cinema.glb":         {-12.5, 11, 0, 16.5, -14, 14},
	"models/oceanarium.glb":           {-12, 12, 0, 16.8, -12, 12.05},
	"models/olympiets_complex.glb":    {-9.45, 9, 0, 11.2, -14, 14},
	"models/pier.glb":                 {-18, 18, -0.3, 0.3, -3.5, 3.5},
	"models/road_lamp.glb":            {-0.28, 0.28, 0, 7.65, -0.28, 0.28},
	"models/sopka.glb":                {-32.064, 31.36, -12.96, 48, -32, 32},
	"models/stall_chifanka.glb":       {-2.3, 2.2, 0, 4.9, -3.1, 3.1},
	"models/stall_coffee.glb":         {-2.3, 2.2, 0, 4.9, -3.1, 3.1},
	"models/stall_pyanse.glb":         {-2.3, 2.2, 0, 4.9, -3.1, 3.1},
	"models/street_lamp.glb":          {-0.42, 0.42, 0, 5.72, -0.399, 0.399},
	"models/supra_restaurant.glb":     {-8.7, 5.5, 0, 7.5, -6.5, 6.5},
	"models/tanker.glb":               {-3.5, 3.5, -0.2, 10.25, -17.1, 17.1},
	"models/tiger_statue.glb":         {-1.8, 1.886, 0, 2.35, -1.2, 1.2},
	"models/yacht_club_boathouse.glb": {-3.5, 3.5, -2.25, 2.25, -4.5, 4.5},
	"models/yacht_club_pier.glb":      {-15, 15, -0.35, 0.35, -4, 4},
}

var defaultCompoundColliders = map[string][]localBounds{
	"models/dynamo_stadium.glb": {
		{-18.625, -9.5, 0, 9.5, -27.75, 27.75},
		{9.5, 18, 0, 9.5, -27.75, 27.75},
		{-18.625, -6.5, 0, 5.5, -27.75, -26.5},
		{6.5, 18, 0, 5.5, -27.75, -26.5},
		{-18.625, -3.5, 0, 8.75, 26, 27.75},
		{3.5, 18, 0, 8.75, 26, 27.75},
	},
}

func inferCarMassFromName(name string) float64 {
	if strings.Contains(name, "Skyline") || strings.Contains(name, "R34") {
		return 1560.0
	}
	if strings.Contains(name, "Forester") {
		return 1510.0
	}
	if strings.Contains(name, "Chaser") {
		return 1480.0
	}
	if strings.Contains(name, "Mark II") {
		return 1470.0
	}
	if strings.Contains(name, "RX-7") || strings.Contains(name, "FD3S") {
		return 1280.0
	}
	return PlayerCarDefaultMass
}

func normalizeModelKey(raw string) string {
	s := strings.TrimSpace(raw)
	s = strings.TrimLeft(s, "/")
	s = strings.TrimPrefix(s, "./")
	return s
}

func loadWorldMapConfig() worldMapConfig {
	cfg := worldMapConfig{
		vehicleMasses: map[string]float64{
			"car_0": 1470.0,
			"car_1": 1450.0,
			"car_2": 1510.0,
			"car_3": 1450.0,
			"car_4": 1450.0,
		},
		fortress: fortressCoords{x: 127.87, z: -124.43, radius: 6.0},
		vehicleBounds: worldBoundsRect{
			minX: -13.0,
			maxX: 290.0,
			minZ: -165.0,
			maxZ: 165.0,
		},
	}

	raw, err := readStaticDataFile("static/data/world_map.json", "data/world_map.json")
	if err != nil {
		return cfg
	}

	type rawColliderBox struct {
		MinX float64 `json:"minX"`
		MaxX float64 `json:"maxX"`
		MinY float64 `json:"minY"`
		MaxY float64 `json:"maxY"`
		MinZ float64 `json:"minZ"`
		MaxZ float64 `json:"maxZ"`
	}
	type rawEntity struct {
		ID            string           `json:"id"`
		Name          string           `json:"name"`
		Type          string           `json:"type"`
		Model         string           `json:"model"`
		X             float64          `json:"x"`
		Y             *float64         `json:"y"`
		Z             float64          `json:"z"`
		RotY          *float64         `json:"rotY"`
		Rotation      *float64         `json:"rotation"`
		Scale         *float64         `json:"scale"`
		HasCollider   *bool            `json:"hasCollider"`
		ColliderBoxes []rawColliderBox `json:"colliderBoxes"`
	}
	type rawHill struct {
		ID       string   `json:"id"`
		X        float64  `json:"x"`
		Y        *float64 `json:"y"`
		Z        float64  `json:"z"`
		R        float64  `json:"r"`
		RX       *float64 `json:"rx"`
		RZ       *float64 `json:"rz"`
		H        float64  `json:"h"`
		RotY     *float64 `json:"rotY"`
		Rotation *float64 `json:"rotation"`
	}

	var parsed struct {
		Vehicles []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"vehicles"`
		Interactables []struct {
			ID     string  `json:"id"`
			X      float64 `json:"x"`
			Z      float64 `json:"z"`
			Radius float64 `json:"radius"`
		} `json:"interactables"`
		Bounds struct {
			Vehicle *struct {
				MinX float64 `json:"minX"`
				MaxX float64 `json:"maxX"`
				MinZ float64 `json:"minZ"`
				MaxZ float64 `json:"maxZ"`
			} `json:"vehicle"`
		} `json:"bounds"`
		Landmarks []rawEntity `json:"landmarks"`
		Stalls    []rawEntity `json:"stalls"`
		Props     []rawEntity `json:"props"`
		Hills     struct {
			East  []rawHill `json:"east"`
			North []rawHill `json:"north"`
			South []rawHill `json:"south"`
		} `json:"hills"`
	}

	if err := json.Unmarshal(raw, &parsed); err != nil {
		return cfg
	}

	for _, v := range parsed.Vehicles {
		if v.ID == "" || strings.HasPrefix(v.ID, "police_car") {
			continue
		}
		cfg.vehicleIDs = append(cfg.vehicleIDs, v.ID)
		cfg.vehicleMasses[v.ID] = inferCarMassFromName(v.Name)
	}

	for _, it := range parsed.Interactables {
		if it.ID == "fortress" {
			r := it.Radius
			if r <= 0 {
				r = 6.0
			}
			cfg.fortress = fortressCoords{x: it.X, z: it.Z, radius: r}
			break
		}
	}

	if parsed.Bounds.Vehicle != nil {
		b := parsed.Bounds.Vehicle
		if b.MaxX > b.MinX && b.MaxZ > b.MinZ {
			cfg.vehicleBounds = worldBoundsRect{minX: b.MinX, maxX: b.MaxX, minZ: b.MinZ, maxZ: b.MaxZ}
		}
	}

	addEntityColliders := func(items []rawEntity, category string) {
		for _, item := range items {
			if item.HasCollider != nil && !*item.HasCollider {
				continue
			}
			modelKey := normalizeModelKey(item.Model)
			if modelKey == "" {
				switch category {
				case "stalls":
					if item.ID != "" {
						modelKey = "models/stall_" + item.ID + ".glb"
					}
				case "props":
					if item.Type == "bench" || strings.Contains(modelKey, "bench") {
						modelKey = "models/bench.glb"
					} else if item.Type == "road_lamp" || strings.Contains(modelKey, "road_lamp") {
						modelKey = "models/road_lamp.glb"
					} else {
						modelKey = "models/street_lamp.glb"
					}
				default:
					if item.ID != "" {
						modelKey = "models/" + item.ID + ".glb"
					}
				}
			}
			if !strings.HasPrefix(modelKey, "models/") && modelKey != "" {
				modelKey = "models/" + modelKey
			}

			isBench := category == "props" && (item.Type == "bench" || strings.Contains(modelKey, "bench"))
			py := 0.0
			if item.Y != nil {
				py = *item.Y
			} else if isBench {
				py = 0.325
			}
			rotY := 0.0
			if item.RotY != nil {
				rotY = *item.RotY
			} else if item.Rotation != nil {
				rotY = *item.Rotation
			}
			scale := 1.0
			if item.Scale != nil && IsFinite(*item.Scale) && *item.Scale > 0 {
				scale = *item.Scale
			}

			var boxes []localBounds
			if len(item.ColliderBoxes) > 0 {
				for _, b := range item.ColliderBoxes {
					boxes = append(boxes, localBounds{b.MinX, b.MaxX, b.MinY, b.MaxY, b.MinZ, b.MaxZ})
				}
			} else if cb, ok := defaultCompoundColliders[modelKey]; ok {
				boxes = cb
			} else if b, ok := defaultModelBounds[modelKey]; ok {
				boxes = []localBounds{b}
			}

			cosY := math.Cos(rotY)
			sinY := math.Sin(rotY)
			for _, b := range boxes {
				w := (b.maxX - b.minX) * scale
				d := (b.maxZ - b.minZ) * scale
				if w <= 0 || d <= 0 {
					continue
				}
				ox := ((b.minX + b.maxX) * 0.5) * scale
				oz := ((b.minZ + b.maxZ) * 0.5) * scale
				cx := item.X + ox*cosY + oz*sinY
				cz := item.Z - ox*sinY + oz*cosY
				minY := py + b.minY*scale
				maxY := py + b.maxY*scale
				cfg.colliders = append(cfg.colliders, worldCollider{
					isCircle: false,
					id:       item.ID,
					x:        cx,
					z:        cz,
					halfW:    w * 0.5,
					halfD:    d * 0.5,
					minY:     minY,
					height:   maxY,
					rotY:     rotY,
				})
			}
		}
	}

	addEntityColliders(parsed.Landmarks, "landmarks")
	addEntityColliders(parsed.Stalls, "stalls")
	addEntityColliders(parsed.Props, "props")

	addHillColliders := func(hills []rawHill) {
		for _, h := range hills {
			py := -0.5
			if h.Y != nil {
				py = *h.Y
			}
			r := h.R
			if r <= 0 {
				r = 32
			}
			rx := r
			if h.RX != nil {
				rx = *h.RX
			}
			rz := r
			if h.RZ != nil {
				rz = *h.RZ
			}
			height := h.H
			if height <= 0 {
				height = 48
			}
			maxY := py + height
			if math.Abs(rx-rz) < 0.001 {
				cfg.colliders = append(cfg.colliders, worldCollider{
					isCircle: true,
					id:       h.ID,
					x:        h.X,
					z:        h.Z,
					radius:   rx * 0.78,
					minY:     py,
					height:   maxY,
				})
			} else {
				rotY := 0.0
				if h.RotY != nil {
					rotY = *h.RotY
				} else if h.Rotation != nil {
					rotY = *h.Rotation
				}
				cfg.colliders = append(cfg.colliders, worldCollider{
					isCircle: false,
					id:       h.ID,
					x:        h.X,
					z:        h.Z,
					halfW:    rx * 0.78,
					halfD:    rz * 0.78,
					minY:     py,
					height:   maxY,
					rotY:     rotY,
				})
			}
		}
	}

	addHillColliders(parsed.Hills.East)
	addHillColliders(parsed.Hills.North)
	addHillColliders(parsed.Hills.South)

	return cfg
}

// DialogueOption defines one choice inside a police scenario loaded from police_dialogues.json.
type DialogueOption struct {
	Index int    `json:"index"`
	Text  string `json:"text"`
	Reply string `json:"reply"`
	Fine  int64  `json:"fine"`
}

// PoliceScenario defines a Russian-language police conversation scenario.
type PoliceScenario struct {
	ID      string           `json:"id"`
	Title   string           `json:"title"`
	Opening string           `json:"opening"`
	Options []DialogueOption `json:"options"`
}

func loadPoliceDialogues() ([]PoliceScenario, error) {
	raw, err := readStaticDataFile("static/data/police_dialogues.json", "data/police_dialogues.json")
	if err != nil {
		return nil, fmt.Errorf("failed to load police_dialogues.json: %w", err)
	}
	var doc struct {
		Scenarios []PoliceScenario `json:"scenarios"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("failed to parse police_dialogues.json: %w", err)
	}
	if len(doc.Scenarios) < 4 {
		return nil, fmt.Errorf("police_dialogues.json must contain at least 4 scenarios, got %d", len(doc.Scenarios))
	}
	for i, s := range doc.Scenarios {
		if strings.TrimSpace(s.ID) == "" || strings.TrimSpace(s.Title) == "" || strings.TrimSpace(s.Opening) == "" {
			return nil, fmt.Errorf("police_dialogues.json scenario %d missing required fields", i)
		}
		if len(s.Options) == 0 {
			return nil, fmt.Errorf("police_dialogues.json scenario %q has no options", s.ID)
		}
		for idx, opt := range s.Options {
			if opt.Index != idx {
				return nil, fmt.Errorf("police_dialogues.json scenario %q option %d has non-contiguous index %d", s.ID, idx, opt.Index)
			}
			if strings.TrimSpace(opt.Text) == "" || strings.TrimSpace(opt.Reply) == "" || opt.Fine < 0 {
				return nil, fmt.Errorf("police_dialogues.json scenario %q option %d invalid", s.ID, idx)
			}
		}
	}
	return doc.Scenarios, nil
}

type waypoint2D struct {
	x float64
	z float64
}

type footCopEntity struct {
	id                string
	name              string
	x, y, z           float64
	vx, vz            float64
	yaw               float64
	state             string
	anim              string
	targetUser        string
	waypoints         []waypoint2D
	waypointIdx       int
	approachStartedAt float64
	cooldownUntil     float64
}

type policeCarEntity struct {
	id             string
	x, y, z        float64
	vx, vz         float64
	yaw, yawRate   float64
	speed          float64
	mass           float64
	yawInertia     float64
	tractionLoss   float64
	isDrifting     bool
	isBraking      bool
	state          string
	targetCarID    string
	targetUser     string
	siren          bool
	lights         bool
	waypoints      []waypoint2D
	waypointIdx    int
	chaseStartedAt float64
	stopHoldSec    float64
	outOfRangeSec  float64
	cooldownUntil  float64
	stuckSec       float64
	unstuckSec     float64
	unstuckSteer   float64
	progressX      float64
	progressZ      float64
	progressAt     float64
}

type activeEncounter struct {
	id         string
	copID      string
	copName    string
	scenario   PoliceScenario
	targetUser string
	createdAt  float64
	msg        OutboundPoliceEncounterStartMsg
}

// PoliceEncounterStartEvent represents an unsolicited dialogue triggered by a foot cop.
type PoliceEncounterStartEvent struct {
	Msg OutboundPoliceEncounterStartMsg
}

// PoliceChaseEvent represents a police car chase start, stop-and-fine, or evasion transition.
type PoliceChaseEvent struct {
	PoliceCarID string
	TargetCarID string
	TargetUser  string
	Status      string
	Reason      string
	Fine        int64
}

// VehicleImpulseEvent represents a 3-circle heavy collision velocity/yaw impulse applied to a player car.
type VehicleImpulseEvent struct {
	PoliceCarID string
	CarID       string
	TargetUser  string
	DVX         float64
	DVZ         float64
	DYawRate    float64
	PoliceMass  float64
	PlayerMass  float64
}

// PoliceStepOutput aggregates all authoritative events emitted during a simulation step.
type PoliceStepOutput struct {
	EncounterStarts []PoliceEncounterStartEvent
	ChaseEvents     []PoliceChaseEvent
	ImpulseEvents   []VehicleImpulseEvent
	ModifiedCars    map[string]struct{}
}

// DialogueResolution represents the validated result of a player's police dialogue option selection.
type DialogueResolution struct {
	EncounterID string
	CopID       string
	CopName     string
	ScenarioID  string
	TargetUser  string
	OptionIndex int
	ReplyText   string
	Fine        int64
}

// PoliceSnapshot is an immutable copy of police entities and active encounters for inspection/tests.
type PoliceSnapshot struct {
	FootCops         []PoliceFootCopState
	PoliceCars       []PoliceCarState
	ActiveEncounters map[string]OutboundPoliceEncounterStartMsg
}

// PoliceManager owns authoritative foot policemen, police cars, encounters, chases, and 3-circle vehicle collisions.
type PoliceManager struct {
	worldCfg               worldMapConfig
	scenarios              []PoliceScenario
	footCops               []*footCopEntity
	policeCars             []*policeCarEntity
	activeEncountersByID   map[string]*activeEncounter
	activeEncountersByUser map[string]*activeEncounter
	playerCooldownUntil    map[string]float64
	chaseGraceUntil        map[string]float64
	lastImpulseAt          map[string]float64
	roadNodes              []waypoint2D
	roadEdges              [][]float64
	simTimeSec             float64
	encounterSeq           uint64
}

// NewPoliceManager initializes foot policemen, patrolling police cars, world colliders, and Russian dialogue scenarios.
func NewPoliceManager(worldCfg worldMapConfig) (*PoliceManager, error) {
	scenarios, err := loadPoliceDialogues()
	if err != nil {
		return nil, err
	}

	footCops := []*footCopEntity{
		{
			id:   "cop_0",
			name: "Сержант ППС Дробышев",
			x:    -5.0, y: 0.0, z: 5.0,
			yaw:   math.Pi,
			state: CopStatePatrol,
			anim:  AnimWalk,
			waypoints: []waypoint2D{
				{-5.0, -5.0},
				{2.0, -5.0},
				{2.0, 30.0},
				{-5.0, 30.0},
			},
			waypointIdx: 0,
		},
		{
			id:   "cop_1",
			name: "Старшина Мельников",
			x:    -6.0, y: 0.0, z: 60.0,
			yaw:   0.0,
			state: CopStatePatrol,
			anim:  AnimWalk,
			waypoints: []waypoint2D{
				{-6.0, 38.0},
				{1.5, 38.0},
				{1.5, 92.0},
				{-6.0, 92.0},
			},
			waypointIdx: 3,
		},
		{
			id:   "cop_2",
			name: "Мл. сержант Ковалёв",
			x:    -5.5, y: 0.0, z: -65.0,
			yaw:   0.0,
			state: CopStatePatrol,
			anim:  AnimWalk,
			waypoints: []waypoint2D{
				{-5.5, -96.0},
				{2.5, -96.0},
				{2.5, -36.0},
				{-5.5, -36.0},
			},
			waypointIdx: 3,
		},
		{
			id:   "cop_3",
			name: "Лейтенант Сорокин",
			x:    140.0, y: 0.0, z: 96.0,
			yaw:   math.Pi * 0.5,
			state: CopStatePatrol,
			anim:  AnimWalk,
			waypoints: []waypoint2D{
				{124.0, 96.0},
				{158.0, 96.0},
				{158.0, 110.0},
				{124.0, 110.0},
			},
			waypointIdx: 1,
		},
	}

	policeInertia := PoliceCarMass * (CarWidth*CarWidth + CarLength*CarLength) / 12.0
	policeCars := []*policeCarEntity{
		{
			id: "police_car_0",
			x:  23.0, y: 0.0, z: 10.0,
			yaw:        0.0,
			mass:       PoliceCarMass,
			yawInertia: policeInertia,
			state:      PoliceCarStatePatrol,
			waypoints: []waypoint2D{
				{23.0, -35.5},
				{23.0, 82.0},
				{105.5, 82.0},
				{105.5, -35.5},
			},
			waypointIdx: 1,
		},
		{
			id: "police_car_1",
			x:  110.5, y: 0.0, z: -80.0,
			yaw:        math.Pi * 0.5,
			mass:       PoliceCarMass,
			yawInertia: policeInertia,
			state:      PoliceCarStatePatrol,
			waypoints: []waypoint2D{
				{23.0, -150.0},
				{23.0, -80.0},
				{175.0, -80.0},
				{175.0, -40.5},
				{110.5, -40.5},
				{110.5, -150.0},
			},
			waypointIdx: 2,
		},
	}

	pm := &PoliceManager{
		worldCfg:               worldCfg,
		scenarios:              scenarios,
		footCops:               footCops,
		policeCars:             policeCars,
		activeEncountersByID:   make(map[string]*activeEncounter),
		activeEncountersByUser: make(map[string]*activeEncounter),
		playerCooldownUntil:    make(map[string]float64),
		chaseGraceUntil:        make(map[string]float64),
		lastImpulseAt:          make(map[string]float64),
	}
	pm.buildRoadGraph()
	for _, pc := range pm.policeCars {
		pc.progressX, pc.progressZ = pc.x, pc.z
	}
	return pm, nil
}

// SimTimeMS returns accumulated simulation time in milliseconds.
func (pm *PoliceManager) SimTimeMS() int64 {
	return int64(math.Round(pm.simTimeSec * 1000.0))
}

// StateMsg builds the outbound Wire PoliceState snapshot.
func (pm *PoliceManager) StateMsg(sequence uint64) OutboundPoliceStateMsg {
	cops := make([]PoliceFootCopState, 0, len(pm.footCops))
	for _, c := range pm.footCops {
		cops = append(cops, PoliceFootCopState{
			ID:         c.id,
			Name:       c.name,
			X:          c.x,
			Y:          c.y,
			Z:          c.z,
			VX:         c.vx,
			VZ:         c.vz,
			Yaw:        c.yaw,
			State:      c.state,
			Anim:       c.anim,
			TargetUser: c.targetUser,
		})
	}
	cars := make([]PoliceCarState, 0, len(pm.policeCars))
	for _, pc := range pm.policeCars {
		cars = append(cars, PoliceCarState{
			ID:          pc.id,
			X:           pc.x,
			Y:           pc.y,
			Z:           pc.z,
			VX:          pc.vx,
			VZ:          pc.vz,
			Yaw:         pc.yaw,
			YawRate:     pc.yawRate,
			Speed:       pc.speed,
			Mass:        pc.mass,
			State:       pc.state,
			TargetCarID: pc.targetCarID,
			TargetUser:  pc.targetUser,
			Siren:       pc.siren,
			Lights:      pc.lights,
		})
	}
	return OutboundPoliceStateMsg{
		Type:         TypePoliceState,
		Sequence:     sequence,
		SampleTimeMS: pm.SimTimeMS(),
		FootCops:     cops,
		PoliceCars:   cars,
	}
}

// Snapshot returns a copy of current police state for tests.
func (pm *PoliceManager) Snapshot() PoliceSnapshot {
	msg := pm.StateMsg(0)
	enc := make(map[string]OutboundPoliceEncounterStartMsg, len(pm.activeEncountersByUser))
	for uname, e := range pm.activeEncountersByUser {
		opts := make([]PoliceDialogueOptionView, len(e.msg.Options))
		copy(opts, e.msg.Options)
		cp := e.msg
		cp.Options = opts
		enc[uname] = cp
	}
	return PoliceSnapshot{
		FootCops:         msg.FootCops,
		PoliceCars:       msg.PoliceCars,
		ActiveEncounters: enc,
	}
}

// ActiveEncounterFor returns a deep copy of an unresolved encounter for username, or nil.
func (pm *PoliceManager) ActiveEncounterFor(username string) *OutboundPoliceEncounterStartMsg {
	e, ok := pm.activeEncountersByUser[username]
	if !ok {
		return nil
	}
	opts := make([]PoliceDialogueOptionView, len(e.msg.Options))
	copy(opts, e.msg.Options)
	cp := e.msg
	cp.Options = opts
	return &cp
}

// CleanupExpiredUser removes cooldown/grace entries when a user's session expires.
func (pm *PoliceManager) CleanupExpiredUser(username string) {
	delete(pm.playerCooldownUntil, username)
	delete(pm.chaseGraceUntil, username)
}

// HandleDialogueChoice validates and resolves a player's dialogue choice, transitioning the cop to cooldown.
func (pm *PoliceManager) HandleDialogueChoice(username, encounterID string, optionIndex int) (*DialogueResolution, error) {
	enc, ok := pm.activeEncountersByID[encounterID]
	if !ok {
		return nil, errors.New("police encounter not found or expired")
	}
	if enc.targetUser != username {
		return nil, errors.New("police encounter belongs to another player")
	}
	if optionIndex < 0 || optionIndex >= len(enc.scenario.Options) {
		return nil, fmt.Errorf("option_index %d out of bounds", optionIndex)
	}

	opt := enc.scenario.Options[optionIndex]
	delete(pm.activeEncountersByID, encounterID)
	delete(pm.activeEncountersByUser, username)
	pm.playerCooldownUntil[username] = pm.simTimeSec + PlayerEncounterCooldown

	for _, cop := range pm.footCops {
		if cop.id == enc.copID {
			cop.state = CopStateCooldown
			cop.targetUser = ""
			cop.anim = AnimWalk
			cop.cooldownUntil = pm.simTimeSec + FootCopCooldownDuration
			break
		}
	}

	return &DialogueResolution{
		EncounterID: enc.id,
		CopID:       enc.copID,
		CopName:     enc.copName,
		ScenarioID:  enc.scenario.ID,
		TargetUser:  username,
		OptionIndex: optionIndex,
		ReplyText:   opt.Reply,
		Fine:        opt.Fine,
	}, nil
}

// OnPlayerEnteredVehicle cancels any foot cop approach or active dialogue targeting username.
func (pm *PoliceManager) OnPlayerEnteredVehicle(username, _ string) {
	pm.cancelFootCopInteraction(username, false)
}

// OnPlayerExitedVehicle ends any active police chase targeting (username, carID) as evaded.
func (pm *PoliceManager) OnPlayerExitedVehicle(username, carID string) []PoliceChaseEvent {
	var events []PoliceChaseEvent
	for _, pc := range pm.policeCars {
		if pc.state == PoliceCarStateChase && pc.targetUser == username && (carID == "" || pc.targetCarID == carID) {
			events = append(events, pm.endChase(pc, ChaseStatusEvaded, "target_exited", 0))
		}
	}
	return events
}

// OnPlayerDisconnected cancels active foot cop encounters/approaches and ends active chases for username.
func (pm *PoliceManager) OnPlayerDisconnected(username string) []PoliceChaseEvent {
	pm.cancelFootCopInteraction(username, true)
	var events []PoliceChaseEvent
	for _, pc := range pm.policeCars {
		if pc.state == PoliceCarStateChase && pc.targetUser == username {
			events = append(events, pm.endChase(pc, ChaseStatusEvaded, "target_disconnected", 0))
		}
	}
	return events
}

func (pm *PoliceManager) cancelFootCopInteraction(username string, isDisconnect bool) {
	if enc, ok := pm.activeEncountersByUser[username]; ok {
		delete(pm.activeEncountersByID, enc.id)
		delete(pm.activeEncountersByUser, username)
		if !isDisconnect {
			pm.playerCooldownUntil[username] = pm.simTimeSec + 5.0
		}
	}
	for _, cop := range pm.footCops {
		if cop.targetUser == username {
			cop.targetUser = ""
			if cop.state == CopStateDialogue {
				cop.state = CopStateCooldown
				cop.anim = AnimWalk
				cop.cooldownUntil = pm.simTimeSec + FootCopCooldownDuration
			} else if cop.state == CopStateApproach {
				cop.state = CopStatePatrol
				cop.anim = AnimWalk
			}
		}
	}
}

func (pm *PoliceManager) endChase(pc *policeCarEntity, status, reason string, fine int64) PoliceChaseEvent {
	ev := PoliceChaseEvent{
		PoliceCarID: pc.id,
		TargetCarID: pc.targetCarID,
		TargetUser:  pc.targetUser,
		Status:      status,
		Reason:      reason,
		Fine:        fine,
	}
	if pc.targetUser != "" && (reason == "fined" || reason == "evaded" || reason == "timeout") {
		pm.chaseGraceUntil[pc.targetUser] = pm.simTimeSec + PoliceTargetGraceSec
	}
	pc.state = PoliceCarStateCooldown
	pc.targetCarID = ""
	pc.targetUser = ""
	pc.siren = false
	pc.lights = false
	pc.stopHoldSec = 0
	pc.outOfRangeSec = 0
	pc.stuckSec = 0
	pc.unstuckSec = 0
	pc.unstuckSteer = 0
	pc.progressX, pc.progressZ, pc.progressAt = pc.x, pc.z, pm.simTimeSec
	pc.cooldownUntil = pm.simTimeSec + PoliceCarCooldownSec
	return ev
}

// Step advances the entire police simulation by dt seconds in deterministic <=0.05s macro steps.
func (pm *PoliceManager) Step(dt float64, users map[string]*UserState, cars map[string]*CarState) PoliceStepOutput {
	out := PoliceStepOutput{
		ModifiedCars: make(map[string]struct{}),
	}
	if dt <= 0 || !IsFinite(dt) {
		return out
	}

	remaining := dt
	for remaining > 1e-6 {
		stepDt := math.Min(0.05, remaining)
		pm.stepTick(stepDt, users, cars, &out)
		remaining -= stepDt
	}
	return out
}

func (pm *PoliceManager) stepTick(dt float64, users map[string]*UserState, cars map[string]*CarState, out *PoliceStepOutput) {
	pm.simTimeSec += dt
	pm.stepFootCops(dt, users, out)
	pm.stepPoliceCars(dt, users, cars, out)
}

func (pm *PoliceManager) isUserTargetedByOtherCop(username, excludeCopID string) bool {
	for _, cop := range pm.footCops {
		if cop.id != excludeCopID && cop.targetUser == username {
			return true
		}
	}
	return false
}

func (pm *PoliceManager) stepFootCops(dt float64, users map[string]*UserState, out *PoliceStepOutput) {
	// Expire stale dialogues cleanly
	for id, enc := range pm.activeEncountersByID {
		if pm.simTimeSec-enc.createdAt >= FootCopDialogueTimeout {
			delete(pm.activeEncountersByID, id)
			delete(pm.activeEncountersByUser, enc.targetUser)
			pm.playerCooldownUntil[enc.targetUser] = pm.simTimeSec + PlayerEncounterCooldown
			for _, cop := range pm.footCops {
				if cop.id == enc.copID {
					cop.state = CopStateCooldown
					cop.targetUser = ""
					cop.anim = AnimWalk
					cop.cooldownUntil = pm.simTimeSec + FootCopCooldownDuration
					break
				}
			}
		}
	}

	sortedUsers := make([]string, 0, len(users))
	for uname := range users {
		sortedUsers = append(sortedUsers, uname)
	}
	sort.Strings(sortedUsers)

	for copIdx, cop := range pm.footCops {
		switch cop.state {
		case CopStateCooldown:
			pm.advanceFootCopPatrol(cop, dt)
			if pm.simTimeSec >= cop.cooldownUntil {
				cop.state = CopStatePatrol
			}

		case CopStatePatrol:
			pm.advanceFootCopPatrol(cop, dt)

			// Scan for nearest eligible pedestrian within FootCopDetectRadius
			bestUser := ""
			bestDistSq := FootCopDetectRadius * FootCopDetectRadius
			for _, uname := range sortedUsers {
				u := users[uname]
				if u == nil || u.Mode != ModePedestrian || u.X < FootCopMinX {
					continue
				}
				if pm.activeEncountersByUser[uname] != nil {
					continue
				}
				if pm.isUserTargetedByOtherCop(uname, cop.id) {
					continue
				}
				if until, ok := pm.playerCooldownUntil[uname]; ok && pm.simTimeSec < until {
					continue
				}
				dx := u.X - cop.x
				dz := u.Z - cop.z
				dSq := dx*dx + dz*dz
				if dSq <= bestDistSq {
					bestDistSq = dSq
					bestUser = uname
				}
			}
			if bestUser != "" {
				cop.state = CopStateApproach
				cop.targetUser = bestUser
				cop.approachStartedAt = pm.simTimeSec
				cop.anim = AnimWalk
			}

		case CopStateApproach:
			u, exists := users[cop.targetUser]
			if !exists || u.Mode != ModePedestrian || u.X < FootCopMinX ||
				pm.activeEncountersByUser[cop.targetUser] != nil ||
				pm.simTimeSec-cop.approachStartedAt > FootCopApproachMaxDuration {
				cop.state = CopStatePatrol
				cop.targetUser = ""
				cop.anim = AnimWalk
				continue
			}

			dx := u.X - cop.x
			dz := u.Z - cop.z
			dist := math.Hypot(dx, dz)
			if dist > FootCopAbandonRadius {
				cop.state = CopStatePatrol
				cop.targetUser = ""
				cop.anim = AnimWalk
				continue
			}

			if dist <= FootCopTalkRadius {
				cop.vx = 0
				cop.vz = 0
				cop.anim = AnimIdle
				if dist > 1e-4 {
					cop.yaw = NormalizeYaw(math.Atan2(dx, dz))
				}

				scenario := pm.scenarios[(copIdx+int(pm.encounterSeq))%len(pm.scenarios)]
				pm.encounterSeq++
				encID := fmt.Sprintf("enc_%d", pm.encounterSeq)

				opts := make([]PoliceDialogueOptionView, 0, len(scenario.Options))
				for _, opt := range scenario.Options {
					opts = append(opts, PoliceDialogueOptionView{
						Index: opt.Index,
						Text:  opt.Text,
						Fine:  opt.Fine,
					})
				}

				msg := OutboundPoliceEncounterStartMsg{
					Type:        TypePoliceEncounterStart,
					EncounterID: encID,
					CopID:       cop.id,
					CopName:     cop.name,
					ScenarioID:  scenario.ID,
					Title:       scenario.Title,
					Opening:     scenario.Opening,
					Options:     opts,
					TargetUser:  cop.targetUser,
				}
				enc := &activeEncounter{
					id:         encID,
					copID:      cop.id,
					copName:    cop.name,
					scenario:   scenario,
					targetUser: cop.targetUser,
					createdAt:  pm.simTimeSec,
					msg:        msg,
				}
				pm.activeEncountersByID[encID] = enc
				pm.activeEncountersByUser[cop.targetUser] = enc
				cop.state = CopStateDialogue
				out.EncounterStarts = append(out.EncounterStarts, PoliceEncounterStartEvent{Msg: msg})
				continue
			}

			// Move toward player
			dirX := dx / dist
			dirZ := dz / dist
			cop.vx = dirX * FootCopApproachSpeed
			cop.vz = dirZ * FootCopApproachSpeed
			cop.yaw = NormalizeYaw(math.Atan2(dirX, dirZ))
			cop.anim = AnimWalk

			nextX := cop.x + cop.vx*dt
			nextZ := cop.z + cop.vz*dt
			resolvedX, resolvedZ, hit := pm.resolveFootCopWorldCollision(nextX, nextZ)
			if hit {
				// Tangential slide if blocked head-on
				slideDist := math.Hypot(resolvedX-cop.x, resolvedZ-cop.z)
				if slideDist < FootCopApproachSpeed*dt*0.25 {
					tx, tz := -dirZ, dirX
					tryX, tryZ, _ := pm.resolveFootCopWorldCollision(cop.x+tx*FootCopApproachSpeed*dt, cop.z+tz*FootCopApproachSpeed*dt)
					if math.Hypot(tryX-cop.x, tryZ-cop.z) > slideDist {
						resolvedX, resolvedZ = tryX, tryZ
					}
				}
			}
			cop.x = resolvedX
			cop.z = resolvedZ

		case CopStateDialogue:
			cop.vx = 0
			cop.vz = 0
			cop.anim = AnimIdle
			if u, exists := users[cop.targetUser]; exists {
				dx := u.X - cop.x
				dz := u.Z - cop.z
				if math.Hypot(dx, dz) > 1e-4 {
					cop.yaw = NormalizeYaw(math.Atan2(dx, dz))
				}
			}
		}
	}
}

func (pm *PoliceManager) advanceFootCopPatrol(cop *footCopEntity, dt float64) {
	if len(cop.waypoints) == 0 {
		cop.vx, cop.vz = 0, 0
		cop.anim = AnimIdle
		return
	}
	wp := cop.waypoints[cop.waypointIdx]
	dx := wp.x - cop.x
	dz := wp.z - cop.z
	dist := math.Hypot(dx, dz)
	if dist < 0.75 {
		cop.waypointIdx = (cop.waypointIdx + 1) % len(cop.waypoints)
		wp = cop.waypoints[cop.waypointIdx]
		dx = wp.x - cop.x
		dz = wp.z - cop.z
		dist = math.Hypot(dx, dz)
	}
	if dist < 1e-4 {
		cop.vx, cop.vz = 0, 0
		cop.anim = AnimIdle
		return
	}
	dirX := dx / dist
	dirZ := dz / dist
	cop.vx = dirX * FootCopPatrolSpeed
	cop.vz = dirZ * FootCopPatrolSpeed
	cop.yaw = NormalizeYaw(math.Atan2(dirX, dirZ))
	cop.anim = AnimWalk

	nextX, nextZ, _ := pm.resolveFootCopWorldCollision(cop.x+cop.vx*dt, cop.z+cop.vz*dt)
	cop.x = nextX
	cop.z = nextZ
}

func (pm *PoliceManager) resolveFootCopWorldCollision(x, z float64) (float64, float64, bool) {
	hitAny := false
	px, pz := x, z
	r := FootCopCollisionRadius
	const entityY = 0.0

	for _, col := range pm.worldCfg.colliders {
		if col.minY > entityY+1.8 {
			continue
		}
		if entityY >= col.height-0.52 {
			continue
		}
		if col.isCircle {
			dx := px - col.x
			dz := pz - col.z
			dist := math.Hypot(dx, dz)
			minDist := col.radius + r
			if dist < minDist {
				hitAny = true
				nx, nz := 1.0, 0.0
				if dist > 1e-4 {
					nx, nz = dx/dist, dz/dist
				}
				px = col.x + nx*minDist
				pz = col.z + nz*minDist
			}
		} else {
			dx := px - col.x
			dz := pz - col.z
			hasRot := col.rotY != 0
			if hasRot {
				cosY := math.Cos(col.rotY)
				sinY := math.Sin(col.rotY)
				dx, dz = dx*cosY-dz*sinY, dx*sinY+dz*cosY
			}
			clampedX := math.Max(-col.halfW, math.Min(col.halfW, dx))
			clampedZ := math.Max(-col.halfD, math.Min(col.halfD, dz))
			diffX := dx - clampedX
			diffZ := dz - clampedZ
			distSq := diffX*diffX + diffZ*diffZ
			if distSq < r*r {
				hitAny = true
				dist := math.Sqrt(distSq)
				var pushX, pushZ float64
				if dist > 1e-4 {
					overlap := r - dist
					pushX = (diffX / dist) * overlap
					pushZ = (diffZ / dist) * overlap
				} else {
					penX := col.halfW + r - math.Abs(dx)
					penZ := col.halfD + r - math.Abs(dz)
					if penX < penZ {
						if dx >= 0 {
							pushX = penX
						} else {
							pushX = -penX
						}
					} else {
						if dz >= 0 {
							pushZ = penZ
						} else {
							pushZ = -penZ
						}
					}
				}
				if hasRot {
					cosY := math.Cos(col.rotY)
					sinY := math.Sin(col.rotY)
					wx := pushX*cosY + pushZ*sinY
					wz := -pushX*sinY + pushZ*cosY
					px += wx
					pz += wz
				} else {
					px += pushX
					pz += pushZ
				}
			}
		}
	}

	if px < FootCopMinX {
		px = FootCopMinX
		hitAny = true
	} else if px > FootCopMaxX {
		px = FootCopMaxX
		hitAny = true
	}
	if pz < FootCopMinZ {
		pz = FootCopMinZ
		hitAny = true
	} else if pz > FootCopMaxZ {
		pz = FootCopMaxZ
		hitAny = true
	}

	return px, pz, hitAny
}

func (pm *PoliceManager) isCarTargetedByOtherPolice(carID, excludePoliceID string) bool {
	for _, pc := range pm.policeCars {
		if pc.id != excludePoliceID && pc.state == PoliceCarStateChase && pc.targetCarID == carID {
			return true
		}
	}
	return false
}

func (pm *PoliceManager) stepPoliceCars(dt float64, users map[string]*UserState, cars map[string]*CarState, out *PoliceStepOutput) {
	carIDs := make([]string, 0, len(cars))
	for cid := range cars {
		carIDs = append(carIDs, cid)
	}
	sort.Strings(carIDs)

	// 1. Evaluate AI state transitions (detection, stop-and-fine, evasion, cooldown expiry)
	for _, pc := range pm.policeCars {
		switch pc.state {
		case PoliceCarStateCooldown:
			if pm.simTimeSec >= pc.cooldownUntil {
				pc.state = PoliceCarStatePatrol
			}

		case PoliceCarStatePatrol:
			bestCarID := ""
			bestUser := ""
			bestDistSq := PoliceDetectRadius * PoliceDetectRadius
			for _, cid := range carIDs {
				car := cars[cid]
				if car == nil || car.Driver == "" {
					continue
				}
				u := users[car.Driver]
				if u == nil || u.Mode != ModeDriving || u.CarID != cid {
					continue
				}
				if until, ok := pm.chaseGraceUntil[car.Driver]; ok && pm.simTimeSec < until {
					continue
				}
				if pm.isCarTargetedByOtherPolice(cid, pc.id) {
					continue
				}
				speedMag := math.Max(math.Abs(car.Speed), math.Hypot(car.VX, car.VZ))
				if speedMag <= PoliceSpeedLimitMS {
					continue
				}
				dx := car.X - pc.x
				dz := car.Z - pc.z
				dSq := dx*dx + dz*dz
				if dSq <= bestDistSq {
					bestDistSq = dSq
					bestCarID = cid
					bestUser = car.Driver
				}
			}
			if bestCarID != "" {
				pc.state = PoliceCarStateChase
				pc.targetCarID = bestCarID
				pc.targetUser = bestUser
				pc.siren = true
				pc.lights = true
				pc.chaseStartedAt = pm.simTimeSec
				pc.stopHoldSec = 0
				pc.outOfRangeSec = 0
				pc.stuckSec = 0
				pc.unstuckSec = 0
				pc.unstuckSteer = 0
				pc.progressX, pc.progressZ, pc.progressAt = pc.x, pc.z, pm.simTimeSec
				out.ChaseEvents = append(out.ChaseEvents, PoliceChaseEvent{
					PoliceCarID: pc.id,
					TargetCarID: bestCarID,
					TargetUser:  bestUser,
					Status:      ChaseStatusStarted,
					Reason:      "speeding",
					Fine:        0,
				})
			}

		case PoliceCarStateChase:
			car, carOK := cars[pc.targetCarID]
			u, userOK := users[pc.targetUser]
			if !carOK || !userOK || car.Driver != pc.targetUser || u.Mode != ModeDriving || u.CarID != pc.targetCarID {
				out.ChaseEvents = append(out.ChaseEvents, pm.endChase(pc, ChaseStatusEvaded, "target_exited", 0))
				continue
			}

			dist := math.Hypot(car.X-pc.x, car.Z-pc.z)
			targetSpeed := math.Max(math.Abs(car.Speed), math.Hypot(car.VX, car.VZ))

			if dist <= PoliceStopDist && targetSpeed <= PoliceStopSpeedMS {
				pc.stopHoldSec += dt
				if pc.stopHoldSec >= PoliceStopHoldSec {
					out.ChaseEvents = append(out.ChaseEvents, pm.endChase(pc, ChaseStatusStopped, "fined", PoliceSpeedingFine))
					continue
				}
			} else {
				pc.stopHoldSec = 0
			}

			if dist > PoliceEvadeDist {
				pc.outOfRangeSec += dt
			} else {
				pc.outOfRangeSec = 0
			}
			if pc.outOfRangeSec >= PoliceEvadeHoldSec {
				out.ChaseEvents = append(out.ChaseEvents, pm.endChase(pc, ChaseStatusEvaded, "evaded", 0))
				continue
			}
			if pm.simTimeSec-pc.chaseStartedAt >= PoliceMaxChaseSec {
				out.ChaseEvents = append(out.ChaseEvents, pm.endChase(pc, ChaseStatusEvaded, "timeout", 0))
				continue
			}

		}
		pm.updatePoliceCarUnstuck(pc, cars, dt)
	}

	// Accumulate per-(policeCarID, carID) collision impulses across physics substeps
	type impulsePairKey struct {
		policeCarID string
		carID       string
	}
	type impulseAccum struct {
		policeCarID string
		carID       string
		dvx         float64
		dvz         float64
		dyawRate    float64
	}
	accum := make(map[impulsePairKey]*impulseAccum)

	// 2. Sub-stepped dynamics & 3-circle vehicle collisions (maxSubDt = 0.016s)
	subRemaining := dt
	for subRemaining > 1e-4 {
		subDt := math.Min(0.016, subRemaining)
		subRemaining -= subDt

		for _, pc := range pm.policeCars {
			throttle, steer, boost := pm.computePoliceCarControl(pc, cars)
			stepSinglePoliceVehicleDynamics(pc, throttle, steer, boost, subDt)
			pm.resolvePoliceCarWorldCollision(pc)
		}

		// Police car vs police car collision
		if len(pm.policeCars) >= 2 {
			for i := 0; i < len(pm.policeCars); i++ {
				for j := i + 1; j < len(pm.policeCars); j++ {
					a := pm.policeCars[i].asBody()
					b := pm.policeCars[j].asBody()
					if ResolveVehiclePairCollision(&a, &b) {
						pm.policeCars[i].applyBody(a)
						pm.policeCars[j].applyBody(b)
					}
				}
			}
		}

		// Police car vs tracked player cars (3-circle rigid-body physics)
		for _, pc := range pm.policeCars {
			for _, cid := range carIDs {
				car := cars[cid]
				if car == nil {
					continue
				}
				pMass := pm.worldCfg.vehicleMasses[cid]
				if pMass <= 0 {
					pMass = PlayerCarDefaultMass
				}
				bodyA := pc.asBody()
				bodyB := VehicleBody{
					X:       car.X,
					Z:       car.Z,
					VX:      car.VX,
					VZ:      car.VZ,
					Yaw:     car.Yaw,
					YawRate: car.YawRate,
					Speed:   car.Speed,
					Mass:    pMass,
					Inertia: pMass * (CarWidth*CarWidth + CarLength*CarLength) / 12.0,
				}
				prevVX, prevVZ, prevYawRate := bodyB.VX, bodyB.VZ, bodyB.YawRate
				collided := ResolveVehiclePairCollision(&bodyA, &bodyB)
				dvx, dvz, dyr := 0.0, 0.0, 0.0
				if collided {
					dvx = bodyB.VX - prevVX
					dvz = bodyB.VZ - prevVZ
					dyr = bodyB.YawRate - prevYawRate
				}
				if car.Driver != "" && math.Hypot(dvx, dvz) <= 0.05 {
					minCircleDist, nx, nz := closestVehicleCircleContact(&bodyA, &bodyB)
					if collided || (minCircleDist < CarCollisionRadius*2.0+0.26 &&
						(math.Hypot(bodyA.VX, bodyA.VZ) > 0.4 || math.Hypot(bodyB.VX, bodyB.VZ) > 0.4)) {
						relN := math.Abs((prevVX-bodyA.VX)*nx + (prevVZ-bodyA.VZ)*nz)
						if relN < 1.2 {
							relN = math.Max(1.2, math.Hypot(bodyA.VX, bodyA.VZ)*0.5+math.Hypot(prevVX, prevVZ)*0.35)
						}
						invMA := 1.0 / bodyA.Mass
						invMB := 1.0 / bodyB.Mass
						jMag := (1.0 + CarRestitution) * relN / (invMA + invMB)
						dvx = jMag * nx * invMB
						dvz = jMag * nz * invMB
						if !collided {
							bodyB.VX = prevVX + dvx
							bodyB.VZ = prevVZ + dvz
							bodyB.Speed = bodyB.VX*math.Sin(bodyB.Yaw) + bodyB.VZ*math.Cos(bodyB.Yaw)
							bodyA.VX -= jMag * nx * invMA
							bodyA.VZ -= jMag * nz * invMA
							bodyA.Speed = bodyA.VX*math.Sin(bodyA.Yaw) + bodyA.VZ*math.Cos(bodyA.Yaw)
							collided = true
						}
					}
				}
				if collided {
					pc.applyBody(bodyA)
					car.X = bodyB.X
					car.Z = bodyB.Z
					if car.Driver == "" {
						car.VX = 0
						car.VZ = 0
						car.YawRate = 0
						car.Speed = 0
					} else {
						car.VX = bodyB.VX
						car.VZ = bodyB.VZ
						car.YawRate = bodyB.YawRate
						car.Speed = bodyB.Speed
					}
					out.ModifiedCars[cid] = struct{}{}

					if car.Driver != "" {
						if u, ok := users[car.Driver]; ok && u.Mode == ModeDriving && u.CarID == cid {
							u.X = car.X
							u.Z = car.Z
							u.VX = car.VX
							u.VZ = car.VZ
							u.YawRate = car.YawRate
							u.Speed = car.Speed
						}
						key := impulsePairKey{policeCarID: pc.id, carID: cid}
						acc := accum[key]
						if acc == nil {
							acc = &impulseAccum{
								policeCarID: pc.id,
								carID:       cid,
							}
							accum[key] = acc
						}
						acc.dvx += dvx
						acc.dvz += dvz
						acc.dyawRate += dyr
					}
				}
			}
		}
	}

	// Emit vehicle_impulse events subject to 300ms per-pair cooldown
	for _, pc := range pm.policeCars {
		for _, cid := range carIDs {
			key := impulsePairKey{policeCarID: pc.id, carID: cid}
			acc, ok := accum[key]
			if !ok {
				continue
			}
			car := cars[cid]
			if car == nil || car.Driver == "" {
				continue
			}
			if math.Hypot(acc.dvx, acc.dvz) <= 0.05 && math.Abs(acc.dyawRate) <= 0.05 {
				continue
			}
			pairKey := pc.id + "\x00" + cid
			if lastAt, ok := pm.lastImpulseAt[pairKey]; ok && pm.simTimeSec < lastAt+ImpulseCooldownSec {
				continue
			}
			pm.lastImpulseAt[pairKey] = pm.simTimeSec
			pMass := pm.worldCfg.vehicleMasses[cid]
			if pMass <= 0 {
				pMass = PlayerCarDefaultMass
			}
			out.ImpulseEvents = append(out.ImpulseEvents, VehicleImpulseEvent{
				PoliceCarID: pc.id,
				CarID:       cid,
				TargetUser:  car.Driver,
				DVX:         acc.dvx,
				DVZ:         acc.dvz,
				DYawRate:    acc.dyawRate,
				PoliceMass:  PoliceCarMass,
				PlayerMass:  pMass,
			})
		}
	}
}

func (pm *PoliceManager) computePoliceCarControl(pc *policeCarEntity, cars map[string]*CarState) (throttle, steer float64, boost bool) {
	if pc.unstuckSec > 0 {
		steerDir := pc.unstuckSteer
		if steerDir == 0 {
			steerDir = 1.0
		}
		return -0.85, steerDir, false
	}

	var aimX, aimZ float64
	var desiredSpeed float64
	chasingTarget := false
	targetSpeed := 0.0
	targetDist := 0.0
	closingSlowTarget := false

	vLong := pc.vx*math.Sin(pc.yaw) + pc.vz*math.Cos(pc.yaw)

	if pc.state == PoliceCarStateChase && pc.targetCarID != "" {
		if target, ok := cars[pc.targetCarID]; ok {
			chasingTarget = true
			targetDist = math.Hypot(target.X-pc.x, target.Z-pc.z)
			targetSpeed = math.Max(math.Abs(target.Speed), math.Hypot(target.VX, target.VZ))
			targetVX, targetVZ := target.VX, target.VZ
			if math.Hypot(targetVX, targetVZ) < 0.05 && math.Abs(target.Speed) > 0.05 {
				targetVX = target.Speed * math.Sin(target.Yaw)
				targetVZ = target.Speed * math.Cos(target.Yaw)
			}

			desiredSpeed = PoliceMaxSpeedForward
			if targetSpeed > PoliceStopSpeedMS+4.0 {
				leadTime := math.Max(0.08, math.Min(1.15, targetDist/math.Max(18.0, math.Max(vLong, 10.0)+12.0)))
				aimX = target.X + targetVX*leadTime
				aimZ = target.Z + targetVZ*leadTime
				if targetDist < 14.0 && targetSpeed > PoliceSpeedLimitMS {
					vMag := math.Hypot(targetVX, targetVZ)
					if vMag > 0.01 {
						aimX = target.X + 2.2*targetVX/vMag
						aimZ = target.Z + 2.2*targetVZ/vMag
					}
				}
				if pm.isPointBlockedForVehicle(aimX, aimZ) {
					aimX, aimZ = target.X, target.Z
				}
			} else {
				leadTime := math.Max(0, math.Min(0.35, targetDist/40.0))
				aimX = target.X + targetVX*leadTime
				aimZ = target.Z + targetVZ*leadTime
				boost = false

				posVLong := math.Max(0, vLong)
				stopDist := (posVLong * posVLong) / (2.0 * 10.0)

				// Pull alongside stopped/slowing target rather than rear-ending it down the road
				closingSlowTarget = targetSpeed <= PoliceStopSpeedMS+2.0 && (targetDist < 16.0 || (targetSpeed <= PoliceStopSpeedMS && stopDist >= targetDist-4.5))
				if closingSlowTarget {
					perpX := math.Cos(target.Yaw)
					perpZ := -math.Sin(target.Yaw)
					const sideOffset = 3.2
					plusBlocked := pm.isPointBlockedForVehicle(aimX+perpX*sideOffset, aimZ+perpZ*sideOffset)
					minusBlocked := pm.isPointBlockedForVehicle(aimX-perpX*sideOffset, aimZ-perpZ*sideOffset)
					side := 1.0
					if plusBlocked && !minusBlocked {
						side = -1.0
					} else if !plusBlocked && minusBlocked {
						side = 1.0
					} else {
						sideDot := (pc.x-target.X)*perpX + (pc.z-target.Z)*perpZ
						if sideDot < -0.1 {
							side = -1.0
						}
					}
					aimX += side * perpX * sideOffset
					aimZ += side * perpZ * sideOffset
				}

				if targetDist <= 6.0 && targetSpeed <= PoliceStopSpeedMS {
					desiredSpeed = 0.0
				} else {
					remDist := math.Max(0.0, targetDist-4.5)
					refTargetSpeed := targetSpeed
					if targetSpeed <= PoliceStopSpeedMS {
						refTargetSpeed = 0.0
					}
					safeApproachSpeed := math.Sqrt(refTargetSpeed*refTargetSpeed + 2.0*10.0*remDist)
					desiredSpeed = math.Min(desiredSpeed, safeApproachSpeed)
				}
			}
		}
	}
	if chasingTarget {
		boost = (targetDist > 7.5 || targetSpeed > PoliceSpeedLimitMS+1.5)
	}

	if !chasingTarget && len(pc.waypoints) > 0 {
		wp := pc.waypoints[pc.waypointIdx]
		if math.Hypot(wp.x-pc.x, wp.z-pc.z) < 4.5 {
			pc.waypointIdx = (pc.waypointIdx + 1) % len(pc.waypoints)
			wp = pc.waypoints[pc.waypointIdx]
		}
		aimX = wp.x
		aimZ = wp.z
		desiredSpeed = PolicePatrolSpeed
	}

	aimX, aimZ = pm.routeAroundObstacles(pc.x, pc.z, aimX, aimZ)
	dx := aimX - pc.x
	dz := aimZ - pc.z
	yawDes := math.Atan2(dx, dz)

	yawDes = pm.contextSteerYaw(pc, cars, yawDes, vLong)

	angleErr := NormalizeYaw(yawDes - pc.yaw)
	boost = boost && math.Abs(angleErr) < 0.78
	steer = math.Max(-1.0, math.Min(1.0, angleErr*1.8))

	if chasingTarget {
		if closingSlowTarget && math.Abs(angleErr) > 1.2 && targetDist < 15.0 {
			desiredSpeed = math.Min(desiredSpeed, 6.5)
		}

		if desiredSpeed <= 0.1 {
			if vLong > 0.2 {
				throttle = -1.0
			} else if vLong < -0.2 {
				throttle = 1.0
			} else {
				throttle = 0.0
			}
		} else if vLong > desiredSpeed+0.5 {
			if vLong > 0.2 {
				throttle = -1.0
			} else {
				throttle = 0.0
			}
		} else if targetSpeed > PoliceStopSpeedMS+4.0 {
			if math.Abs(angleErr) > 1.35 && vLong > 14.0 {
				throttle = -0.65
			} else if targetDist < 28.0 && math.Abs(angleErr) > 0.55 && vLong > 28.0 {
				throttle = -0.55
			} else {
				throttle = 1.0
			}
		} else {
			speedErr := desiredSpeed - vLong
			if speedErr <= 0 {
				throttle = 0.0
			} else {
				throttle = math.Max(0.0, math.Min(1.0, speedErr*0.45))
				if math.Abs(angleErr) > 1.2 && vLong > 15.0 {
					throttle = math.Min(throttle, 0.55)
				}
			}
		}
	} else {
		speedErr := desiredSpeed - vLong
		throttle = math.Max(-0.5, math.Min(1.0, speedErr*0.25))
	}

	return throttle, steer, boost
}

func (pm *PoliceManager) isSegmentBlockedForVehicle(x1, z1, x2, z2 float64) bool {
	dist := math.Hypot(x2-x1, z2-z1)
	steps := int(math.Ceil(dist / 2.2))
	if steps < 1 {
		steps = 1
	}
	for i := 0; i <= steps; i++ {
		t := float64(i) / float64(steps)
		if pm.isPointBlockedForVehicle(x1+(x2-x1)*t, z1+(z2-z1)*t) {
			return true
		}
	}
	return false
}

func (pm *PoliceManager) buildRoadGraph() {
	roadXs := [...]float64{18, 23, 108, 175, 225}
	roadZs := [...]float64{-135, -80, -38, 22, 82, 115}
	pm.roadNodes = nil
	for _, x := range roadXs {
		for _, z := range roadZs {
			if !pm.isPointBlockedForVehicle(x, z) {
				pm.roadNodes = append(pm.roadNodes, waypoint2D{x, z})
			}
		}
	}
	n := len(pm.roadNodes)
	pm.roadEdges = make([][]float64, n)
	for i := range pm.roadEdges {
		pm.roadEdges[i] = make([]float64, n)
		for j := range pm.roadEdges[i] {
			pm.roadEdges[i][j] = math.Inf(1)
		}
	}
	for i := 0; i < n; i++ {
		for j := i + 1; j < n; j++ {
			a, b := pm.roadNodes[i], pm.roadNodes[j]
			if !pm.isSegmentBlockedForVehicle(a.x, a.z, b.x, b.z) {
				d := math.Hypot(a.x-b.x, a.z-b.z)
				pm.roadEdges[i][j], pm.roadEdges[j][i] = d, d
			}
		}
	}
}

func (pm *PoliceManager) routeAroundObstacles(startX, startZ, goalX, goalZ float64) (float64, float64) {
	if !pm.isSegmentBlockedForVehicle(startX, startZ, goalX, goalZ) {
		return goalX, goalZ
	}
	if len(pm.roadNodes) == 0 {
		return goalX, goalZ
	}
	n := len(pm.roadNodes)
	start, goal := n, n+1
	dist := make([]float64, n+2)
	prev := make([]int, n+2)
	seen := make([]bool, n+2)
	for i := range dist {
		dist[i] = math.Inf(1)
		prev[i] = -1
	}
	dist[start] = 0
	startLinks := make([]float64, n)
	goalLinks := make([]float64, n)
	for i, p := range pm.roadNodes {
		startLinks[i], goalLinks[i] = math.Inf(1), math.Inf(1)
		if !pm.isSegmentBlockedForVehicle(startX, startZ, p.x, p.z) {
			startLinks[i] = math.Hypot(startX-p.x, startZ-p.z)
		}
		if !pm.isSegmentBlockedForVehicle(goalX, goalZ, p.x, p.z) {
			goalLinks[i] = math.Hypot(goalX-p.x, goalZ-p.z)
		}
	}
	for step := 0; step < n+2; step++ {
		u := -1
		for i := range dist {
			if !seen[i] && (u < 0 || dist[i] < dist[u]) {
				u = i
			}
		}
		if u < 0 || math.IsInf(dist[u], 1) || u == goal {
			break
		}
		seen[u] = true
		for v := 0; v < n+2; v++ {
			if seen[v] || v == start || v == u {
				continue
			}
			w := math.Inf(1)
			if u == start && v < n {
				w = startLinks[v]
			} else if u < n && v == goal {
				w = goalLinks[u]
			} else if u < n && v < n {
				w = pm.roadEdges[u][v]
			}
			if dist[u]+w < dist[v] {
				dist[v], prev[v] = dist[u]+w, u
			}
		}
	}
	if prev[goal] < 0 {
		return goalX, goalZ
	}
	path := []waypoint2D{{goalX, goalZ}}
	for at := prev[goal]; at >= 0 && at != start; at = prev[at] {
		path = append(path, pm.roadNodes[at])
	}
	for i := 0; i < len(path)/2; i++ {
		path[i], path[len(path)-1-i] = path[len(path)-1-i], path[i]
	}
	for i := len(path) - 1; i >= 0; i-- {
		p := path[i]
		if math.Hypot(p.x-startX, p.z-startZ) >= 3.5 && !pm.isSegmentBlockedForVehicle(startX, startZ, p.x, p.z) {
			return p.x, p.z
		}
	}
	return path[0].x, path[0].z
}

func (pm *PoliceManager) contextSteerYaw(pc *policeCarEntity, cars map[string]*CarState, yawDes, vLong float64) float64 {
	lookahead := math.Max(7.5, math.Min(21.0, 6.5+math.Max(0, vLong)*0.42))
	offsets := [...]float64{0, 0.22, -0.22, 0.45, -0.45, 0.70, -0.70, 0.98, -0.98, 1.30, -1.30}
	bestYaw, bestScore := yawDes, math.Inf(-1)
	for _, off := range offsets {
		cand := yawDes + off
		clear := lookahead
		for d := 2.2; d <= lookahead; d += 2.2 {
			x := pc.x + math.Sin(cand)*d
			z := pc.z + math.Cos(cand)*d
			blocked := pm.isPointBlockedForVehicle(x, z)
			if !blocked {
				for _, car := range cars {
					if car == nil || car.CarID == pc.targetCarID {
						continue
					}
					if math.Hypot(x-car.X, z-car.Z) < 2*CarCollisionRadius+0.7 {
						blocked = true
						break
					}
				}
			}
			if blocked {
				clear = d - 2.2
				break
			}
		}
		score := clear - 3.5*math.Abs(NormalizeYaw(cand-yawDes)) - 1.2*math.Abs(NormalizeYaw(cand-pc.yaw))
		if score > bestScore {
			bestYaw, bestScore = cand, score
		}
	}
	return bestYaw
}

func (pm *PoliceManager) updatePoliceCarUnstuck(pc *policeCarEntity, cars map[string]*CarState, dt float64) {
	if pc.unstuckSec > 0 {
		pc.unstuckSec = math.Max(0, pc.unstuckSec-dt)
		pc.stuckSec = 0
		pc.progressX, pc.progressZ, pc.progressAt = pc.x, pc.z, pm.simTimeSec
		return
	}
	stoppedBesideTarget := false
	if pc.state == PoliceCarStateChase {
		if target := cars[pc.targetCarID]; target != nil {
			stoppedBesideTarget = math.Hypot(target.X-pc.x, target.Z-pc.z) <= PoliceStopDist &&
				math.Max(math.Abs(target.Speed), math.Hypot(target.VX, target.VZ)) <= PoliceStopSpeedMS
		}
	}
	if math.Hypot(pc.x-pc.progressX, pc.z-pc.progressZ) >= 1.8 {
		pc.progressX, pc.progressZ, pc.progressAt = pc.x, pc.z, pm.simTimeSec
	}
	if stoppedBesideTarget {
		pc.stuckSec = 0
		pc.progressAt = pm.simTimeSec
		return
	}
	if math.Hypot(pc.vx, pc.vz) < 0.8 {
		pc.stuckSec += dt
	} else {
		pc.stuckSec = 0
	}
	if pc.stuckSec <= 1.1 && pm.simTimeSec-pc.progressAt <= 1.7 {
		return
	}
	pc.unstuckSec = 0.90
	pc.stuckSec = 0
	pc.progressX, pc.progressZ, pc.progressAt = pc.x, pc.z, pm.simTimeSec
	clearRear := func(offset float64) float64 {
		for d := 2.0; d <= 7.0; d += 1.0 {
			if pm.isPointBlockedForVehicle(pc.x-math.Sin(pc.yaw+offset)*d, pc.z-math.Cos(pc.yaw+offset)*d) {
				return d - 1.0
			}
		}
		return 7.0
	}
	if clearRear(0.6) > clearRear(-0.6) {
		pc.unstuckSteer = 1
	} else {
		pc.unstuckSteer = -1
	}
}

func (pm *PoliceManager) isPointBlockedForVehicle(x, z float64) bool {
	b := pm.worldCfg.vehicleBounds
	if x < b.minX+1.5 || x > b.maxX-1.5 || z < b.minZ+1.5 || z > b.maxZ-1.5 {
		return true
	}
	const r = CarCollisionRadius + 0.5
	for _, col := range pm.worldCfg.colliders {
		if col.minY > 2.0 || col.height <= 0.52 {
			continue
		}
		if col.isCircle {
			if math.Hypot(x-col.x, z-col.z) < col.radius+r {
				return true
			}
		} else {
			dx := x - col.x
			dz := z - col.z
			if col.rotY != 0 {
				cosY := math.Cos(col.rotY)
				sinY := math.Sin(col.rotY)
				dx, dz = dx*cosY-dz*sinY, dx*sinY+dz*cosY
			}
			cx := math.Max(-col.halfW, math.Min(col.halfW, dx))
			cz := math.Max(-col.halfD, math.Min(col.halfD, dz))
			if (dx-cx)*(dx-cx)+(dz-cz)*(dz-cz) < r*r {
				return true
			}
		}
	}
	return false
}

func smoothstep(edge0, edge1, x float64) float64 {
	if edge0 >= edge1 {
		if x >= edge1 {
			return 1
		}
		return 0
	}
	t := math.Max(0, math.Min(1, (x-edge0)/(edge1-edge0)))
	return t * t * (3 - 2*t)
}

// stepSinglePoliceVehicleDynamics translates stepSingleVehicleDynamics from static/js/physics.js.
func stepSinglePoliceVehicleDynamics(pc *policeCarEntity, throttle, steer float64, boost bool, dt float64) {
	if dt <= 0 || !IsFinite(dt) {
		return
	}
	throttle = math.Max(-1.0, math.Min(1.0, throttle))
	steer = math.Max(-1.0, math.Min(1.0, steer))

	currentYaw := pc.yaw
	sinY := math.Sin(currentYaw)
	cosY := math.Cos(currentYaw)

	vLong := pc.vx*sinY + pc.vz*cosY
	vLat := pc.vx*cosY - pc.vz*sinY

	speedBefore := math.Hypot(vLong, vLat)
	slipAngle := math.Atan2(math.Abs(vLat), math.Max(math.Abs(vLong), 0.5))
	slipFactor := smoothstep(0.14, 0.55, slipAngle)
	speedFactor := smoothstep(1.0, 5.0, speedBefore)
	targetLoss := speedFactor * slipFactor

	lossRate := 8.0
	if targetLoss > pc.tractionLoss {
		lossRate = 12.0
	}
	pc.tractionLoss = pc.tractionLoss + (targetLoss-pc.tractionLoss)*(1.0-math.Exp(-lossRate*dt))

	scrubDecel := 0.012 * pc.tractionLoss * speedBefore * speedBefore
	if speedBefore > 0.001 && scrubDecel > 0 {
		scrubScale := math.Max(0, 1.0-(scrubDecel*dt)/speedBefore)
		vLong *= scrubScale
		vLat *= scrubScale
	}

	pc.isBraking = false
	maxFwd := PoliceMaxSpeedForward
	if boost {
		maxFwd = PoliceMaxSpeedBoost
	}

	drag := PoliceDragRoll + PoliceDragAero*vLong*vLong
	if vLong > 0 {
		vLong = math.Max(0, vLong-drag*dt)
	} else if vLong < 0 {
		vLong = math.Min(0, vLong+drag*dt)
	}

	if throttle > 0 {
		if vLong < -0.2 {
			vLong = math.Min(0, vLong+PoliceAccelBrake*throttle*dt)
			pc.isBraking = true
		} else {
			efficiency := 1.0 - 0.5*pc.tractionLoss
			accel := PoliceAccelForward
			if boost {
				accel = PoliceAccelBoost
			}
			accel *= throttle * efficiency
			if vLong < maxFwd {
				vLong += math.Min(accel*dt, maxFwd-vLong)
			}
		}
	} else if throttle < 0 {
		if vLong > 0.2 {
			vLong = math.Max(0, vLong-PoliceAccelBrake*math.Abs(throttle)*dt)
			pc.isBraking = true
		} else {
			revAccel := PoliceAccelReverse * math.Abs(throttle)
			if vLong > PoliceMaxSpeedReverse {
				vLong -= math.Min(revAccel*dt, vLong-PoliceMaxSpeedReverse)
			}
		}
	}

	speedMag := math.Abs(vLong)
	speedGain := 1.0 / (1.0 + math.Pow(speedMag/26.0, 2))
	targetYawRate := steer * (vLong / CarWheelbase) * PoliceSteerGain * speedGain

	maxLatDeltaV := PoliceMuGrip * 9.81 * dt
	deltaVLat := -vLat * (1.0 - math.Exp(-PoliceLatDampingGrip*dt))
	if math.Abs(deltaVLat) > maxLatDeltaV {
		if deltaVLat > 0 {
			deltaVLat = maxLatDeltaV
		} else {
			deltaVLat = -maxLatDeltaV
		}
	}
	vLat += deltaVLat

	pc.yawRate = pc.yawRate + (targetYawRate-pc.yawRate)*math.Min(1.0, 8.5*dt)

	pc.vx = vLong*sinY + vLat*cosY
	pc.vz = vLong*cosY - vLat*sinY

	pc.yaw = NormalizeYaw(currentYaw + pc.yawRate*dt)
	pc.x += pc.vx * dt
	pc.z += pc.vz * dt
	pc.speed = pc.vx*math.Sin(pc.yaw) + pc.vz*math.Cos(pc.yaw)
}

func (pm *PoliceManager) resolvePoliceCarWorldCollision(pc *policeCarEntity) {
	invMass := 1.0 / pc.mass
	invInertia := 1.0 / pc.yawInertia
	offsets := [3]float64{CarAxleOffset, 0, -CarAxleOffset}
	const carY = 0.0

	for pass := 0; pass < 2; pass++ {
		for _, offset := range offsets {
			sinY := math.Sin(pc.yaw)
			cosY := math.Cos(pc.yaw)
			offsetX := offset * sinY
			offsetZ := offset * cosY

			for _, col := range pm.worldCfg.colliders {
				if col.minY > carY+2.0 || carY >= col.height-0.52 {
					continue
				}
				circleX := pc.x + offsetX
				circleZ := pc.z + offsetZ

				maxDim := col.radius
				if !col.isCircle {
					maxDim = math.Max(col.halfW, col.halfD) * 1.42
				}
				maxExtent := maxDim + CarCollisionRadius
				if math.Abs(circleX-col.x) > maxExtent || math.Abs(circleZ-col.z) > maxExtent {
					continue
				}

				var nx, nz, overlap float64
				if col.isCircle {
					dx := circleX - col.x
					dz := circleZ - col.z
					dist := math.Hypot(dx, dz)
					minDist := col.radius + CarCollisionRadius
					if dist < minDist {
						overlap = minDist - dist
						if dist > 1e-4 {
							nx, nz = dx/dist, dz/dist
						} else {
							nx, nz = 1, 0
						}
					}
				} else {
					dx := circleX - col.x
					dz := circleZ - col.z
					hasRot := col.rotY != 0
					if hasRot {
						cosR := math.Cos(col.rotY)
						sinR := math.Sin(col.rotY)
						dx, dz = dx*cosR-dz*sinR, dx*sinR+dz*cosR
					}
					clampedX := math.Max(-col.halfW, math.Min(col.halfW, dx))
					clampedZ := math.Max(-col.halfD, math.Min(col.halfD, dz))
					diffX := dx - clampedX
					diffZ := dz - clampedZ
					distSq := diffX*diffX + diffZ*diffZ
					if distSq < CarCollisionRadius*CarCollisionRadius {
						dist := math.Sqrt(distSq)
						var localNx, localNz float64
						if dist > 1e-4 {
							localNx = diffX / dist
							localNz = diffZ / dist
							overlap = CarCollisionRadius - dist
						} else {
							penX := col.halfW + CarCollisionRadius - math.Abs(dx)
							penZ := col.halfD + CarCollisionRadius - math.Abs(dz)
							if penX < penZ {
								if dx >= 0 {
									localNx = 1
								} else {
									localNx = -1
								}
								overlap = penX
							} else {
								if dz >= 0 {
									localNz = 1
								} else {
									localNz = -1
								}
								overlap = penZ
							}
						}
						if hasRot {
							cosR := math.Cos(col.rotY)
							sinR := math.Sin(col.rotY)
							nx = localNx*cosR + localNz*sinR
							nz = -localNx*sinR + localNz*cosR
						} else {
							nx, nz = localNx, localNz
						}
					}
				}

				if overlap > 0 {
					pc.x += nx * overlap
					pc.z += nz * overlap
					contactX := pc.x + offsetX - nx*CarCollisionRadius
					contactZ := pc.z + offsetZ - nz*CarCollisionRadius
					applyStaticVehicleContactImpulse(pc, contactX, contactZ, nx, nz, invMass, invInertia)
				}
			}

			// World bounds enforcement
			b := pm.worldCfg.vehicleBounds
			cx := pc.x + offsetX
			cz := pc.z + offsetZ
			if cx-CarCollisionRadius < b.minX {
				pc.x += b.minX - (cx - CarCollisionRadius)
				applyStaticVehicleContactImpulse(pc, b.minX, cz, 1, 0, invMass, invInertia)
			} else if cx+CarCollisionRadius > b.maxX {
				pc.x -= (cx + CarCollisionRadius) - b.maxX
				applyStaticVehicleContactImpulse(pc, b.maxX, cz, -1, 0, invMass, invInertia)
			}
			cz = pc.z + offsetZ
			if cz-CarCollisionRadius < b.minZ {
				pc.z += b.minZ - (cz - CarCollisionRadius)
				applyStaticVehicleContactImpulse(pc, pc.x+offsetX, b.minZ, 0, 1, invMass, invInertia)
			} else if cz+CarCollisionRadius > b.maxZ {
				pc.z -= (cz + CarCollisionRadius) - b.maxZ
				applyStaticVehicleContactImpulse(pc, pc.x+offsetX, b.maxZ, 0, -1, invMass, invInertia)
			}
		}
	}
	pc.speed = pc.vx*math.Sin(pc.yaw) + pc.vz*math.Cos(pc.yaw)
}

func applyStaticVehicleContactImpulse(pc *policeCarEntity, contactX, contactZ, nx, nz, invMass, invInertia float64) {
	rx := contactX - pc.x
	rz := contactZ - pc.z
	rotVx := pc.yawRate * rz
	rotVz := -pc.yawRate * rx
	contactVx := pc.vx + rotVx
	contactVz := pc.vz + rotVz
	vn := contactVx*nx + contactVz*nz
	if vn < -0.01 {
		ca := rz*nx - rx*nz
		denomN := invMass + ca*ca*invInertia
		restitution := 0.0
		if math.Abs(vn) > 0.8 {
			restitution = CarRestitution
		}
		Jn := -(1.0 + restitution) * vn / denomN
		pc.vx += Jn * nx * invMass
		pc.vz += Jn * nz * invMass
		pc.yawRate += Jn * ca * invInertia

		postVx := pc.vx + pc.yawRate*rz
		postVz := pc.vz - pc.yawRate*rx
		tx := -nz
		tz := nx
		vt := postVx*tx + postVz*tz
		ct := rz*tx - rx*tz
		denomT := invMass + ct*ct*invInertia
		Jt := -vt / denomT
		maxJt := 0.45 * math.Abs(Jn)
		if math.Abs(Jt) > maxJt {
			if Jt > 0 {
				Jt = maxJt
			} else {
				Jt = -maxJt
			}
		}
		pc.vx += Jt * tx * invMass
		pc.vz += Jt * tz * invMass
		pc.yawRate += Jt * ct * invInertia
	}
}

// VehicleBody represents a rigid-body vehicle state for 3-circle collision resolution.
type VehicleBody struct {
	X       float64
	Z       float64
	VX      float64
	VZ      float64
	Yaw     float64
	YawRate float64
	Speed   float64
	Mass    float64
	Inertia float64
}

func (pc *policeCarEntity) asBody() VehicleBody {
	return VehicleBody{
		X:       pc.x,
		Z:       pc.z,
		VX:      pc.vx,
		VZ:      pc.vz,
		Yaw:     pc.yaw,
		YawRate: pc.yawRate,
		Speed:   pc.speed,
		Mass:    pc.mass,
		Inertia: pc.yawInertia,
	}
}

func (pc *policeCarEntity) applyBody(b VehicleBody) {
	pc.x = b.X
	pc.z = b.Z
	pc.vx = b.VX
	pc.vz = b.VZ
	pc.yawRate = b.YawRate
	pc.speed = b.Speed
}

// closestVehicleCircleContact finds the nearest pair of vehicle collision circles.
func closestVehicleCircleContact(carA, carB *VehicleBody) (minCircleDist, nx, nz float64) {
	sinA, cosA := math.Sin(carA.Yaw), math.Cos(carA.Yaw)
	sinB, cosB := math.Sin(carB.Yaw), math.Cos(carB.Yaw)
	circlesA := [3][2]float64{
		{carA.X + CarAxleOffset*sinA, carA.Z + CarAxleOffset*cosA},
		{carA.X, carA.Z},
		{carA.X - CarAxleOffset*sinA, carA.Z - CarAxleOffset*cosA},
	}
	circlesB := [3][2]float64{
		{carB.X + CarAxleOffset*sinB, carB.Z + CarAxleOffset*cosB},
		{carB.X, carB.Z},
		{carB.X - CarAxleOffset*sinB, carB.Z - CarAxleOffset*cosB},
	}
	minCircleDist = math.Inf(1)
	for _, cA := range circlesA {
		for _, cB := range circlesB {
			dx, dz := cB[0]-cA[0], cB[1]-cA[1]
			dist := math.Hypot(dx, dz)
			if dist < minCircleDist {
				minCircleDist = dist
				nx, nz = dx, dz
			}
		}
	}
	if minCircleDist > 1e-4 {
		return minCircleDist, nx / minCircleDist, nz / minCircleDist
	}
	dx, dz := carB.X-carA.X, carB.Z-carA.Z
	if dist := math.Hypot(dx, dz); dist > 1e-4 {
		return minCircleDist, dx / dist, dz / dist
	}
	return minCircleDist, 1, 0
}

// ResolveVehiclePairCollision executes the exact 3-circle rigid-body vehicle-to-vehicle collision
// math from static/js/physics.js (resolveVehicleToVehicleCollisions). Returns true if contact occurred.
func ResolveVehiclePairCollision(carA, carB *VehicleBody) bool {
	massA := carA.Mass
	if !IsFinite(massA) || massA <= 10.0 {
		massA = PlayerCarDefaultMass
	}
	invMassA := 1.0 / massA
	inertiaA := carA.Inertia
	if !IsFinite(inertiaA) || inertiaA <= 50.0 {
		inertiaA = massA * (CarWidth*CarWidth + CarLength*CarLength) / 12.0
	}
	invIA := 1.0 / inertiaA

	massB := carB.Mass
	if !IsFinite(massB) || massB <= 10.0 {
		massB = PlayerCarDefaultMass
	}
	invMassB := 1.0 / massB
	inertiaB := carB.Inertia
	if !IsFinite(inertiaB) || inertiaB <= 50.0 {
		inertiaB = massB * (CarWidth*CarWidth + CarLength*CarLength) / 12.0
	}
	invIB := 1.0 / inertiaB

	cdx := carB.X - carA.X
	cdz := carB.Z - carA.Z
	maxSep := (CarAxleOffset + CarCollisionRadius) * 2.0
	if cdx*cdx+cdz*cdz > maxSep*maxSep {
		return false
	}

	sinA, cosA := math.Sin(carA.Yaw), math.Cos(carA.Yaw)
	sinB, cosB := math.Sin(carB.Yaw), math.Cos(carB.Yaw)
	circlesA := [3][2]float64{
		{carA.X + CarAxleOffset*sinA, carA.Z + CarAxleOffset*cosA},
		{carA.X, carA.Z},
		{carA.X - CarAxleOffset*sinA, carA.Z - CarAxleOffset*cosA},
	}
	circlesB := [3][2]float64{
		{carB.X + CarAxleOffset*sinB, carB.Z + CarAxleOffset*cosB},
		{carB.X, carB.Z},
		{carB.X - CarAxleOffset*sinB, carB.Z - CarAxleOffset*cosB},
	}

	cdist := math.Hypot(cdx, cdz)
	fallbackNx, fallbackNz := 1.0, 0.0
	if cdist > 1e-4 {
		fallbackNx = cdx / cdist
		fallbackNz = cdz / cdist
	}

	bestOverlap := 0.0
	var bestNx, bestNz, bestContactX, bestContactZ float64
	const minDist = CarCollisionRadius * 2.0

	for _, cA := range circlesA {
		for _, cB := range circlesB {
			dx := cB[0] - cA[0]
			dz := cB[1] - cA[1]
			dist := math.Hypot(dx, dz)
			if dist < minDist {
				dotCar := dx*fallbackNx + dz*fallbackNz
				var nx, nz, overlap float64
				if dist > 1e-4 && dotCar > 0 {
					nx = dx / dist
					nz = dz / dist
					overlap = minDist - dist
				} else {
					nx = fallbackNx
					nz = fallbackNz
					projDist := dx*nx + dz*nz
					overlap = minDist - projDist
				}
				if overlap > bestOverlap {
					bestOverlap = overlap
					bestNx = nx
					bestNz = nz
					bestContactX = (cA[0] + cB[0]) * 0.5
					bestContactZ = (cA[1] + cB[1]) * 0.5
				}
			}
		}
	}

	if bestOverlap <= 1e-4 {
		return false
	}

	sumInvM := invMassA + invMassB
	carA.X -= bestNx * bestOverlap * (invMassA / sumInvM)
	carA.Z -= bestNz * bestOverlap * (invMassA / sumInvM)
	carB.X += bestNx * bestOverlap * (invMassB / sumInvM)
	carB.Z += bestNz * bestOverlap * (invMassB / sumInvM)

	rAx := bestContactX - carA.X
	rAz := bestContactZ - carA.Z
	rBx := bestContactX - carB.X
	rBz := bestContactZ - carB.Z

	vAx := carA.VX + carA.YawRate*rAz
	vAz := carA.VZ - carA.YawRate*rAx
	vBx := carB.VX + carB.YawRate*rBz
	vBz := carB.VZ - carB.YawRate*rBx

	vn := (vBx-vAx)*bestNx + (vBz-vAz)*bestNz
	if vn < -0.01 {
		ca := rAz*bestNx - rAx*bestNz
		cb := rBz*bestNx - rBx*bestNz
		denom := invMassA + invMassB + ca*ca*invIA + cb*cb*invIB

		restitution := 0.0
		if math.Abs(vn) > 0.8 {
			restitution = CarRestitution
		}
		J := -(1.0 + restitution) * vn / denom

		carA.VX -= J * bestNx * invMassA
		carA.VZ -= J * bestNz * invMassA
		carB.VX += J * bestNx * invMassB
		carB.VZ += J * bestNz * invMassB

		carA.YawRate -= J * ca * invIA
		carB.YawRate += J * cb * invIB

		carA.Speed = carA.VX*sinA + carA.VZ*cosA
		carB.Speed = carB.VX*sinB + carB.VZ*cosB
	}

	return true
}
