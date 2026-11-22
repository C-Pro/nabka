package game

import (
	"math"
	"strings"
	"testing"
)

func TestPoliceManager_PatrolRoutesCollisionFreeAndSpeedBounded(t *testing.T) {
	worldCfg := loadWorldMapConfig()
	pm, err := NewPoliceManager(worldCfg)
	if err != nil {
		t.Fatalf("NewPoliceManager failed: %v", err)
	}

	snap0 := pm.Snapshot()
	if len(snap0.FootCops) != 4 {
		t.Fatalf("expected 4 foot cops, got %d", len(snap0.FootCops))
	}
	if len(snap0.PoliceCars) != 2 {
		t.Fatalf("expected 2 police cars, got %d", len(snap0.PoliceCars))
	}
	for _, cid := range worldCfg.vehicleIDs {
		if strings.HasPrefix(cid, "police_car") {
			t.Fatalf("world_map vehicleIDs must not include police cars, found %q", cid)
		}
	}

	users := make(map[string]*UserState)
	cars := make(map[string]*CarState)

	startCopPos := make(map[string][2]float64)
	movedCop := make(map[string]bool)
	startCarPos := make(map[string][2]float64)
	movedCar := make(map[string]bool)
	for _, c := range snap0.FootCops {
		startCopPos[c.ID] = [2]float64{c.X, c.Z}
	}
	for _, pc := range snap0.PoliceCars {
		startCarPos[pc.ID] = [2]float64{pc.X, pc.Z}
		if pc.Mass != PoliceCarMass {
			t.Fatalf("expected police car %s mass %v, got %v", pc.ID, PoliceCarMass, pc.Mass)
		}
	}

	// Step 90 seconds of idle patrol at 20 Hz
	for tick := 0; tick < 1800; tick++ {
		out := pm.Step(0.05, users, cars)
		if len(out.EncounterStarts) != 0 || len(out.ChaseEvents) != 0 || len(out.ImpulseEvents) != 0 {
			t.Fatalf("expected no encounters/chases/impulses on empty world tick %d, got %+v", tick, out)
		}
		for _, fc := range pm.footCops {
			if fc.x < FootCopMinX {
				t.Fatalf("foot cop %s stepped toward water: x=%v", fc.id, fc.x)
			}
			_, _, hit := pm.resolveFootCopWorldCollision(fc.x, fc.z)
			if hit {
				t.Fatalf("foot cop %s collided with world obstacle during patrol at (%v, %v)", fc.id, fc.x, fc.z)
			}
			if math.Hypot(fc.x-startCopPos[fc.id][0], fc.z-startCopPos[fc.id][1]) > 3.0 {
				movedCop[fc.id] = true
			}
		}
		for _, pc := range pm.policeCars {
			if pc.state != PoliceCarStatePatrol || pc.siren || pc.lights {
				t.Fatalf("police car %s unexpected idle state: %+v", pc.id, pc)
			}
			spd := math.Hypot(pc.vx, pc.vz)
			if spd >= PoliceSpeedLimitMS {
				t.Fatalf("patrolling police car %s exceeded 40 km/h limit: %v m/s", pc.id, spd)
			}
			if pm.isPointBlockedForVehicle(pc.x, pc.z) {
				t.Fatalf("patrolling police car %s hit world collider/bounds at (%v, %v)", pc.id, pc.x, pc.z)
			}
			if math.Hypot(pc.x-startCarPos[pc.id][0], pc.z-startCarPos[pc.id][1]) > 10.0 {
				movedCar[pc.id] = true
			}
		}
	}

	for _, fc := range pm.footCops {
		if !movedCop[fc.id] {
			t.Fatalf("foot cop %s did not patrol", fc.id)
		}
	}
	for _, pc := range pm.policeCars {
		if !movedCar[pc.id] {
			t.Fatalf("police car %s did not patrol", pc.id)
		}
	}
}

func TestPoliceManager_SmartObstacleRoutingAroundBuilding(t *testing.T) {
	pm, err := NewPoliceManager(loadWorldMapConfig())
	if err != nil {
		t.Fatalf("NewPoliceManager failed: %v", err)
	}
	pc := pm.policeCars[0]
	pc.x, pc.z, pc.yaw = 23.0, -58.0, 0
	pc.state, pc.targetCarID, pc.targetUser = PoliceCarStateChase, "car_0", "vasya"
	pc.progressX, pc.progressZ = pc.x, pc.z
	pc.siren, pc.lights = true, true
	pm.policeCars[1].x, pm.policeCars[1].z = 225.0, 115.0
	if !pm.isSegmentBlockedForVehicle(pc.x, pc.z, 75.0, -58.0) {
		t.Fatal("expected oceanarium to block the straight chase path")
	}
	wayX, wayZ := pm.routeAroundObstacles(pc.x, pc.z, 75.0, -58.0)
	if wayX == 75.0 && wayZ == -58.0 {
		t.Fatal("expected route to return a visible detour waypoint")
	}
	if pm.isSegmentBlockedForVehicle(pc.x, pc.z, wayX, wayZ) {
		t.Fatalf("detour waypoint (%.2f, %.2f) is blocked", wayX, wayZ)
	}
	users := map[string]*UserState{
		"vasya": {Username: "vasya", Mode: ModeDriving, CarID: "car_0", X: 75, Z: -58, Yaw: math.Pi / 2, Speed: 18},
	}
	cars := map[string]*CarState{
		"car_0": {CarID: "car_0", Driver: "vasya", X: 75, Z: -58, Yaw: math.Pi / 2, Speed: 18},
	}
	maxX := pc.x
	crossedAboveOceanarium := false
	for tick := 0; tick < 300; tick++ {
		pm.Step(0.05, users, cars)
		maxX = math.Max(maxX, pc.x)
		if pc.x > 40 && pc.z > -45 {
			crossedAboveOceanarium = true
		}
	}
	if maxX < 40 || !crossedAboveOceanarium {
		t.Fatalf("police car failed to make progress around oceanarium: maxX=%.2f final=(%.2f, %.2f)", maxX, pc.x, pc.z)
	}
}

func TestPoliceManager_FootCopApproachAndUnsolicitedDialogueAllScenarios(t *testing.T) {
	pm, err := NewPoliceManager(loadWorldMapConfig())
	if err != nil {
		t.Fatalf("NewPoliceManager failed: %v", err)
	}

	// Place vasya near cop_0 (within 12m detection radius, > 2.4m talk radius)
	users := map[string]*UserState{
		"vasya": {
			Username: "vasya",
			Mode:     ModePedestrian,
			X:        -5.0,
			Y:        0.0,
			Z:        13.0,
			Anim:     AnimIdle,
		},
	}
	cars := make(map[string]*CarState)

	// First tick should transition cop_0 to approach
	pm.Step(0.05, users, cars)
	if pm.footCops[0].state != CopStateApproach || pm.footCops[0].targetUser != "vasya" {
		t.Fatalf("expected cop_0 to enter approach toward vasya, got state=%q target=%q",
			pm.footCops[0].state, pm.footCops[0].targetUser)
	}

	// Step until unsolicited encounter starts (no client request!)
	var started *OutboundPoliceEncounterStartMsg
	for tick := 0; tick < 120; tick++ {
		out := pm.Step(0.05, users, cars)
		if len(out.EncounterStarts) > 0 {
			msg := out.EncounterStarts[0].Msg
			started = &msg
			break
		}
	}
	if started == nil {
		t.Fatal("expected cop_0 to initiate unsolicited police_encounter_start after approaching")
	}
	if started.TargetUser != "vasya" || started.CopID != "cop_0" || len(started.Options) < 3 {
		t.Fatalf("unexpected encounter start payload: %+v", started)
	}
	if pm.footCops[0].state != CopStateDialogue {
		t.Fatalf("expected cop_0 in dialogue state, got %q", pm.footCops[0].state)
	}

	// Wrong user or invalid encounter ID or out-of-bounds option must fail cleanly without clearing encounter
	if _, err := pm.HandleDialogueChoice("bob", started.EncounterID, 0); err == nil {
		t.Fatal("expected error when another player answers vasya's encounter")
	}
	if _, err := pm.HandleDialogueChoice("vasya", "enc_missing", 0); err == nil {
		t.Fatal("expected error for missing encounter_id")
	}
	if _, err := pm.HandleDialogueChoice("vasya", started.EncounterID, 9); err == nil {
		t.Fatal("expected error for out-of-bounds option_index")
	}
	if pm.ActiveEncounterFor("vasya") == nil {
		t.Fatal("encounter must remain active after rejected choices")
	}

	// Resolve encounter and verify cop_0 enters cooldown
	res, err := pm.HandleDialogueChoice("vasya", started.EncounterID, 0)
	if err != nil {
		t.Fatalf("expected valid resolution, got: %v", err)
	}
	if res.TargetUser != "vasya" || pm.footCops[0].state != CopStateCooldown {
		t.Fatalf("unexpected resolution or cop state: res=%+v state=%q", res, pm.footCops[0].state)
	}

	// Verify scenario rotation covers all 4 Russian scenarios including person_search and weed_shakedown
	seenScenarios := map[string]bool{started.ScenarioID: true}
	var weedScenario *PoliceScenario
	for i := range pm.scenarios {
		if pm.scenarios[i].ID == "weed_shakedown" {
			weedScenario = &pm.scenarios[i]
		}
	}
	if weedScenario == nil {
		t.Fatal("expected weed_shakedown scenario in loaded dialogues")
	}
	for _, opt := range weedScenario.Options {
		if opt.Fine <= 0 {
			t.Fatalf("weed_shakedown option %d must deduct money (fine > 0), got %d", opt.Index, opt.Fine)
		}
	}

	for round := 0; round < 3; round++ {
		// Advance past cooldowns (player=15s, cop=12s) and place vasya right next to cop_0
		pm.Step(16.0, map[string]*UserState{}, cars)
		users["vasya"].X = pm.footCops[0].x
		users["vasya"].Z = pm.footCops[0].z + 2.0

		var nextEnc *OutboundPoliceEncounterStartMsg
		for tick := 0; tick < 60; tick++ {
			out := pm.Step(0.05, users, cars)
			if len(out.EncounterStarts) > 0 {
				msg := out.EncounterStarts[0].Msg
				nextEnc = &msg
				break
			}
		}
		if nextEnc == nil {
			t.Fatalf("round %d: expected next encounter to trigger", round)
		}
		seenScenarios[nextEnc.ScenarioID] = true
		if _, err := pm.HandleDialogueChoice("vasya", nextEnc.EncounterID, 0); err != nil {
			t.Fatalf("round %d: resolve failed: %v", round, err)
		}
	}

	for _, reqID := range []string{"person_search", "weed_shakedown", "document_check", "public_order"} {
		if !seenScenarios[reqID] {
			t.Fatalf("expected scenario %q to be reached in rotation, saw %+v", reqID, seenScenarios)
		}
	}

	// Verify police dialogue CANNOT time out and CANNOT be dismissed by entering a vehicle
	pm.Step(16.0, map[string]*UserState{}, cars)
	users["vasya"].X = pm.footCops[0].x
	users["vasya"].Z = pm.footCops[0].z + 1.5
	pm.Step(0.1, users, cars) // approach -> dialogue
	encPersist := pm.ActiveEncounterFor("vasya")
	if encPersist == nil {
		t.Fatal("expected active encounter before non-dismissible check")
	}
	pm.Step(120.0, users, cars)
	if pm.ActiveEncounterFor("vasya") == nil || pm.footCops[0].state != CopStateDialogue {
		t.Fatal("expected foot police encounter NOT to expire over time")
	}
	pm.OnPlayerEnteredVehicle("vasya", "car_0")
	if pm.ActiveEncounterFor("vasya") == nil || pm.footCops[0].state != CopStateDialogue {
		t.Fatal("expected foot police encounter NOT to be dismissed when entering vehicle")
	}
	if _, err := pm.HandleDialogueChoice("vasya", encPersist.EncounterID, 0); err != nil {
		t.Fatalf("expected dialogue choice to still succeed: %v", err)
	}
	if pm.ActiveEncounterFor("vasya") != nil {
		t.Fatal("expected encounter resolved after HandleDialogueChoice")
	}

	// Verify disconnect cleans up active encounter
	pm.Step(16.0, map[string]*UserState{}, cars)
	users["vasya"].Mode = ModePedestrian
	users["vasya"].CarID = ""
	users["vasya"].X = pm.footCops[0].x
	users["vasya"].Z = pm.footCops[0].z + 1.5
	pm.Step(0.1, users, cars)
	if pm.ActiveEncounterFor("vasya") == nil {
		t.Fatal("expected active encounter before disconnect check")
	}
	pm.OnPlayerDisconnected("vasya")
	if pm.ActiveEncounterFor("vasya") != nil {
		t.Fatal("expected disconnect to clear active encounter")
	}
}

func TestPoliceManager_PoliceCarIgnoresUnder40KmhAndChasesOver40Kmh(t *testing.T) {
	pm, err := NewPoliceManager(loadWorldMapConfig())
	if err != nil {
		t.Fatalf("NewPoliceManager failed: %v", err)
	}

	// Place driver in car_0 within 15m of police_car_0 (23, 10) driving <= 40 km/h (11.11 m/s)
	users := map[string]*UserState{
		"vasya": {Username: "vasya", Mode: ModeDriving, CarID: "car_0", X: 23.0, Z: 25.0, Speed: 11.10, VZ: 11.10},
	}
	cars := map[string]*CarState{
		"car_0": {CarID: "car_0", Driver: "vasya", X: 23.0, Z: 25.0, Speed: 11.10, VZ: 11.10},
	}

	for i := 0; i < 20; i++ {
		out := pm.Step(0.05, users, cars)
		if len(out.ChaseEvents) != 0 {
			t.Fatalf("expected <= 40 km/h car not to trigger chase, got %+v", out.ChaseEvents)
		}
	}

	// Exceed 40 km/h (15.0 m/s = 54 km/h) -> chase MUST start!
	cars["car_0"].Speed = 15.0
	cars["car_0"].VZ = 15.0
	cars["car_0"].X = pm.policeCars[0].x
	cars["car_0"].Z = pm.policeCars[0].z + 15.0
	users["vasya"].X = cars["car_0"].X
	users["vasya"].Z = cars["car_0"].Z
	users["vasya"].Speed = 15.0
	users["vasya"].VZ = 15.0

	out := pm.Step(0.05, users, cars)
	if len(out.ChaseEvents) != 2 {
		t.Fatalf("expected both police cars to join chase on single speeder, got %+v", out.ChaseEvents)
	}
	for _, ev := range out.ChaseEvents {
		if ev.Status != ChaseStatusStarted || ev.TargetCarID != "car_0" {
			t.Fatalf("unexpected chase start event: %+v", ev)
		}
	}
	if !pm.policeCars[0].siren || !pm.policeCars[0].lights || pm.policeCars[0].state != PoliceCarStateChase ||
		!pm.policeCars[1].siren || !pm.policeCars[1].lights || pm.policeCars[1].state != PoliceCarStateChase {
		t.Fatalf("expected siren/lights/chase active on both police cars: %+v / %+v", pm.policeCars[0], pm.policeCars[1])
	}

	// Place target far ahead on straight road to verify police car matches standard car top speed (>= 44.0 m/s)
	cars["car_0"].X = pm.policeCars[0].x
	cars["car_0"].Z = pm.policeCars[0].z + 65.0
	cars["car_0"].Speed = 30.0
	cars["car_0"].VZ = 30.0
	maxSeenSpeed := 0.0
	for i := 0; i < 100; i++ {
		cars["car_0"].Z = pm.policeCars[0].z + 65.0
		users["vasya"].Z = cars["car_0"].Z
		pm.Step(0.05, users, cars)
		spd := math.Hypot(pm.policeCars[0].vx, pm.policeCars[0].vz)
		if spd > maxSeenSpeed {
			maxSeenSpeed = spd
		}
	}
	if maxSeenSpeed < 44.0 {
		t.Fatalf("expected chasing police car to reach >= 44.0 m/s (matching standard car top speed), got %v", maxSeenSpeed)
	}

	// Stop target car right next to police_car_0 -> triggers animated fine_stop, forced exit, officer walk, and traffic dialog
	cars["car_0"].X = pm.policeCars[0].x + 3.0
	cars["car_0"].Z = pm.policeCars[0].z + 3.0
	cars["car_0"].Speed = 0.0
	cars["car_0"].VX = 0.0
	cars["car_0"].VZ = 0.0
	users["vasya"].X = cars["car_0"].X
	users["vasya"].Z = cars["car_0"].Z
	users["vasya"].Speed = 0.0
	users["vasya"].VX = 0.0
	users["vasya"].VZ = 0.0

	var stoppedEvent *PoliceChaseEvent
	var approachingStop *OutboundPoliceFineStopMsg
	for i := 0; i < 20; i++ {
		cars["car_0"].X = pm.policeCars[0].x + 2.5
		cars["car_0"].Z = pm.policeCars[0].z + 2.5
		cars["car_0"].VX, cars["car_0"].VZ, cars["car_0"].Speed = 0, 0, 0
		users["vasya"].X = cars["car_0"].X
		users["vasya"].Z = cars["car_0"].Z
		res := pm.Step(0.05, users, cars)
		for _, ev := range res.ChaseEvents {
			if ev.Status == ChaseStatusStopped {
				e := ev
				stoppedEvent = &e
			}
		}
		for _, fs := range res.FineStopEvents {
			if fs.Stage == "approaching" {
				f := fs
				approachingStop = &f
			}
		}
		if stoppedEvent != nil {
			break
		}
	}
	if stoppedEvent == nil || stoppedEvent.Fine != 0 || stoppedEvent.Reason != "caught" {
		t.Fatalf("expected chase stopped with caught reason & fine=0 (dialog pending), got %+v", stoppedEvent)
	}
	if approachingStop == nil || cars["car_0"].Driver != "" || users["vasya"].Mode != ModePedestrian || !pm.IsUserInFineStop("vasya") {
		t.Fatalf("expected forced exit & approaching fine_stop, stop=%+v driver=%q mode=%s", approachingStop, cars["car_0"].Driver, users["vasya"].Mode)
	}
	if pm.policeCars[0].state != PoliceCarStateFineStop || pm.policeCars[0].siren || !pm.policeCars[0].lights {
		t.Fatalf("expected police_car_0 parked in fine_stop with lights=true siren=false: %+v", pm.policeCars[0])
	}

	// Step while officer walks up to detained vasya and starts traffic encounter
	var trafficEnc *OutboundPoliceEncounterStartMsg
	for i := 0; i < 120; i++ {
		res := pm.Step(0.05, users, cars)
		if len(res.EncounterStarts) > 0 {
			m := res.EncounterStarts[0].Msg
			trafficEnc = &m
			break
		}
	}
	if trafficEnc == nil || trafficEnc.EncounterKind != EncounterKindTraffic || trafficEnc.CarID != "car_0" {
		t.Fatalf("expected traffic encounter start for car_0, got %+v", trafficEnc)
	}
	choiceRes, err := pm.HandleDialogueChoice("vasya", trafficEnc.EncounterID, 0)
	if err != nil {
		t.Fatalf("HandleDialogueChoice traffic failed: %v", err)
	}
	if choiceRes.Fine <= 0 || !choiceRes.VehicleBlocked || choiceRes.VehicleBanSec != int(VehicleBanDurationSec) || !pm.IsVehicleBanned("car_0") {
		t.Fatalf("expected regular traffic option to impose 5-min car ban, got %+v", choiceRes)
	}

	// Advance past officer return, grace & cooldown and verify distance evasion (> 90m for 5s) with an unbanned car
	pm.SetVehicleBan("car_0", 0)
	pm.Step(10.0, map[string]*UserState{}, cars)
	users["vasya"].Mode = ModeDriving
	users["vasya"].CarID = "car_0"
	cars["car_0"].Driver = "vasya"
	cars["car_0"].X = pm.policeCars[0].x
	cars["car_0"].Z = pm.policeCars[0].z + 12.0
	cars["car_0"].Speed = 20.0
	cars["car_0"].VZ = 20.0
	users["vasya"].X = cars["car_0"].X
	users["vasya"].Z = cars["car_0"].Z
	startOut := pm.Step(0.05, users, cars)
	if len(startOut.ChaseEvents) == 0 || startOut.ChaseEvents[0].Status != ChaseStatusStarted {
		t.Fatalf("expected second chase to start, got %+v", startOut.ChaseEvents)
	}

	evadedCount := 0
	for i := 0; i < 360; i++ {
		cars["car_0"].X = pm.policeCars[0].x + 250.0
		cars["car_0"].Z = pm.policeCars[0].z
		users["vasya"].X = cars["car_0"].X
		users["vasya"].Z = cars["car_0"].Z
		res := pm.Step(0.05, users, cars)
		for _, ev := range res.ChaseEvents {
			if ev.Status == ChaseStatusEvaded && ev.Fine == 0 {
				evadedCount++
			}
		}
		if len(pm.activeChases) == 0 {
			break
		}
	}
	if evadedCount == 0 || len(pm.activeChases) != 0 {
		t.Fatalf("expected evasion event with fine=0 and cleared activeChases, got evadedCount=%d", evadedCount)
	}
}

func TestResolveVehiclePairCollision_HeavyPoliceDeflection(t *testing.T) {
	// 1. Head-on 3-circle collision: 4200 kg police car moving at +20 m/s along +Z vs stationary 1450 kg player car
	police := VehicleBody{
		X: 0, Z: 0, VX: 0, VZ: 20.0, Yaw: 0, Speed: 20.0,
		Mass:    PoliceCarMass,
		Inertia: PoliceCarMass * (CarWidth*CarWidth + CarLength*CarLength) / 12.0,
	}
	player := VehicleBody{
		X: 0, Z: 4.2, VX: 0, VZ: 0.0, Yaw: 0, Speed: 0.0,
		Mass:    PlayerCarDefaultMass,
		Inertia: PlayerCarDefaultMass * (CarWidth*CarWidth + CarLength*CarLength) / 12.0,
	}

	policeInitVZ := police.VZ
	playerInitVZ := player.VZ

	hit := ResolveVehiclePairCollision(&police, &player)
	if !hit {
		t.Fatal("expected head-on 3-circle collision to trigger")
	}

	dvPolice := math.Abs(police.VZ - policeInitVZ)
	dvPlayer := math.Abs(player.VZ - playerInitVZ)
	ratio := dvPlayer / dvPolice
	expectedRatio := PoliceCarMass / PlayerCarDefaultMass // ~2.89655

	if math.Abs(ratio-expectedRatio) > 0.05 {
		t.Fatalf("expected deflection ratio ~%.3f (4200/1450), got %.3f (dvPlayer=%.3f, dvPolice=%.3f)",
			expectedRatio, ratio, dvPlayer, dvPolice)
	}
	if dvPlayer <= 2.5*dvPolice {
		t.Fatalf("expected player deflection >> police deflection, got dvPlayer=%.3f dvPolice=%.3f", dvPlayer, dvPolice)
	}

	// 2. Off-center T-bone / corner collision verifies angular impulse also favors deflecting the lighter player car
	policeCorner := VehicleBody{
		X: 0, Z: 0, VX: 0, VZ: 18.0, Yaw: 0, Speed: 18.0,
		Mass:    PoliceCarMass,
		Inertia: PoliceCarMass * (CarWidth*CarWidth + CarLength*CarLength) / 12.0,
	}
	playerCorner := VehicleBody{
		X: 1.0, Z: 2.8, VX: 0, VZ: 0.0, Yaw: math.Pi * 0.5, Speed: 0.0,
		Mass:    PlayerCarDefaultMass,
		Inertia: PlayerCarDefaultMass * (CarWidth*CarWidth + CarLength*CarLength) / 12.0,
	}
	if !ResolveVehiclePairCollision(&policeCorner, &playerCorner) {
		t.Fatal("expected off-center collision to trigger")
	}
	if math.Abs(playerCorner.YawRate) <= math.Abs(policeCorner.YawRate)*2.0 {
		t.Fatalf("expected larger yaw-rate deflection on lighter player car: player=%v police=%v",
			playerCorner.YawRate, policeCorner.YawRate)
	}

	// 3. Step simulation emits vehicle_impulse and enforces 300ms per-pair cooldown
	pm, err := NewPoliceManager(loadWorldMapConfig())
	if err != nil {
		t.Fatalf("NewPoliceManager failed: %v", err)
	}
	pm.policeCars[0].x = 23.0
	pm.policeCars[0].z = 10.0
	pm.policeCars[0].yaw = 0
	pm.policeCars[0].vx = 0
	pm.policeCars[0].vz = 20.0
	pm.policeCars[0].speed = 20.0

	users := map[string]*UserState{
		"vasya": {Username: "vasya", Mode: ModeDriving, CarID: "car_1", X: 23.0, Z: 14.2},
	}
	cars := map[string]*CarState{
		"car_1": {CarID: "car_1", Driver: "vasya", X: 23.0, Z: 14.2, Yaw: 0, Speed: 0},
	}

	out1 := pm.Step(0.05, users, cars)
	if len(out1.ImpulseEvents) != 1 {
		t.Fatalf("expected 1 vehicle_impulse event on impact, got %d", len(out1.ImpulseEvents))
	}
	imp := out1.ImpulseEvents[0]
	if imp.PoliceMass != PoliceCarMass || imp.PlayerMass != PlayerCarDefaultMass || math.Hypot(imp.DVX, imp.DVZ) <= 5.0 {
		t.Fatalf("unexpected impulse event: %+v", imp)
	}

	// Immediate second overlap 50ms later (< 300ms cooldown) must suppress duplicate vehicle_impulse
	cars["car_1"].X = pm.policeCars[0].x
	cars["car_1"].Z = pm.policeCars[0].z + 3.8
	cars["car_1"].VX, cars["car_1"].VZ, cars["car_1"].Speed = 0, 0, 0
	out2 := pm.Step(0.05, users, cars)
	if len(out2.ImpulseEvents) != 0 {
		t.Fatalf("expected 300ms cooldown to suppress immediate duplicate impulse, got %+v", out2.ImpulseEvents)
	}
}

func simulatePlayerBrakingStep(car *CarState, user *UserState, brakeDecel, dt float64) {
	// Integrate realistic braking (brakeDecel + 0.002*v^2 aero drag) against current velocity
	spd := math.Hypot(car.VX, car.VZ)
	if spd > 0.001 {
		decel := (brakeDecel + 0.002*spd*spd) * dt
		if decel >= spd {
			car.VX = 0
			car.VZ = 0
		} else {
			scale := (spd - decel) / spd
			car.VX *= scale
			car.VZ *= scale
		}
	} else {
		car.VX = 0
		car.VZ = 0
	}
	car.X += car.VX * dt
	car.Z += car.VZ * dt
	car.Speed = car.VX*math.Sin(car.Yaw) + car.VZ*math.Cos(car.Yaw)
	if user != nil {
		user.X = car.X
		user.Z = car.Z
		user.VX = car.VX
		user.VZ = car.VZ
		user.Speed = car.Speed
	}
}

func TestPoliceManager_OpenRoadRealisticBrakingStopAndFine(t *testing.T) {
	cases := []struct {
		name           string
		startX         float64
		startZ         float64
		startYaw       float64
		startSpeed     float64
		coastBeforeSec float64
		brakeDecel     float64
		maxAllowedZ    float64
	}{
		{
			name:        "brake_31_4_ms2",
			startX:      23.0,
			startZ:      45.0,
			startSpeed:  12.0,
			brakeDecel:  31.4,
			maxAllowedZ: 85.0,
		},
		{
			name:        "brake_15_0_ms2",
			startX:      23.0,
			startZ:      45.0,
			startSpeed:  12.0,
			brakeDecel:  15.0,
			maxAllowedZ: 85.0,
		},
		{
			name:           "high_speed_chase_then_brake_31_4_ms2",
			startX:         23.0,
			startZ:         45.0,
			startSpeed:     28.0,
			coastBeforeSec: 1.5,
			brakeDecel:     31.4,
			maxAllowedZ:    140.0,
		},
		{
			name:        "close_range_12m_brake_31_4_ms2",
			startX:      23.0,
			startZ:      22.0,
			startSpeed:  12.0,
			brakeDecel:  31.4,
			maxAllowedZ: 60.0,
		},
		{
			name:        "head_on_opposite_yaw_brake_15_0_ms2",
			startX:      23.0,
			startZ:      45.0,
			startYaw:    math.Pi,
			startSpeed:  12.0,
			brakeDecel:  15.0,
			maxAllowedZ: 70.0,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pm, err := NewPoliceManager(loadWorldMapConfig())
			if err != nil {
				t.Fatalf("NewPoliceManager failed: %v", err)
			}

			initVX := tc.startSpeed * math.Sin(tc.startYaw)
			initVZ := tc.startSpeed * math.Cos(tc.startYaw)
			users := map[string]*UserState{
				"vasya": {
					Username: "vasya",
					Mode:     ModeDriving,
					CarID:    "car_0",
					X:        tc.startX,
					Z:        tc.startZ,
					Yaw:      tc.startYaw,
					VX:       initVX,
					VZ:       initVZ,
					Speed:    tc.startSpeed,
				},
			}
			cars := map[string]*CarState{
				"car_0": {
					CarID:  "car_0",
					Driver: "vasya",
					X:      tc.startX,
					Z:      tc.startZ,
					Yaw:    tc.startYaw,
					VX:     initVX,
					VZ:     initVZ,
					Speed:  tc.startSpeed,
				},
			}

			// Tick 1 triggers chase (both cars join single speeder)
			out0 := pm.Step(0.05, users, cars)
			if len(out0.ChaseEvents) != 2 || out0.ChaseEvents[0].Status != ChaseStatusStarted {
				t.Fatalf("expected chase started on tick 1 for both police cars, got %+v", out0.ChaseEvents)
			}

			var finalChase *PoliceChaseEvent
			maxZ := cars["car_0"].Z
			const dt = 0.05
			coastTicks := int(math.Round(tc.coastBeforeSec / dt))

			for tick := 1; tick <= 900; tick++ {
				if tick <= coastTicks {
					// Maintain fleeing speed briefly so police car builds chase speed
					cars["car_0"].VX = initVX
					cars["car_0"].VZ = initVZ
					cars["car_0"].Speed = tc.startSpeed
					cars["car_0"].X += cars["car_0"].VX * dt
					cars["car_0"].Z += cars["car_0"].VZ * dt
					users["vasya"].X = cars["car_0"].X
					users["vasya"].Z = cars["car_0"].Z
					users["vasya"].VX = cars["car_0"].VX
					users["vasya"].VZ = cars["car_0"].VZ
					users["vasya"].Speed = cars["car_0"].Speed
				} else {
					simulatePlayerBrakingStep(cars["car_0"], users["vasya"], tc.brakeDecel, dt)
				}

				out := pm.Step(dt, users, cars)
				if cars["car_0"].Z > maxZ {
					maxZ = cars["car_0"].Z
				}
				for _, ev := range out.ChaseEvents {
					if ev.Status == ChaseStatusStopped || ev.Status == ChaseStatusEvaded {
						e := ev
						finalChase = &e
						break
					}
				}
				if finalChase != nil {
					break
				}
			}

			if finalChase == nil {
				t.Fatalf("chase did not terminate within 45s (maxZ=%.2f, car=(%.2f,%.2f), police=(%.2f,%.2f))",
					maxZ, cars["car_0"].X, cars["car_0"].Z, pm.policeCars[0].x, pm.policeCars[0].z)
			}
			if finalChase.Status != ChaseStatusStopped || finalChase.Reason != "caught" || finalChase.Fine != 0 || !pm.IsUserInFineStop("vasya") {
				t.Fatalf("expected clean stop initiating fine_stop, got %+v (inFineStop=%v maxZ=%.2f car=(%.2f,%.2f) police=(%.2f,%.2f))",
					finalChase, pm.IsUserInFineStop("vasya"), maxZ, cars["car_0"].X, cars["car_0"].Z, pm.policeCars[0].x, pm.policeCars[0].z)
			}
			if maxZ >= tc.maxAllowedZ || maxZ >= 165.0 {
				t.Fatalf("car_0 was bulldozed too far (maxZ=%.2f >= %.2f)", maxZ, tc.maxAllowedZ)
			}
		})
	}
}

func TestPoliceManager_FleeingHighSpeedTargetChasedAndDeflected(t *testing.T) {
	pm, err := NewPoliceManager(loadWorldMapConfig())
	if err != nil {
		t.Fatalf("NewPoliceManager failed: %v", err)
	}

	users := map[string]*UserState{
		"vasya": {Username: "vasya", Mode: ModeDriving, CarID: "car_0", X: 23.0, Z: 45.0, VZ: 22.0, Speed: 22.0},
	}
	cars := map[string]*CarState{
		"car_0": {CarID: "car_0", Driver: "vasya", X: 23.0, Z: 45.0, VZ: 22.0, Speed: 22.0},
	}

	out0 := pm.Step(0.05, users, cars)
	if len(out0.ChaseEvents) != 2 || out0.ChaseEvents[0].Status != ChaseStatusStarted {
		t.Fatalf("expected chase started, got %+v", out0.ChaseEvents)
	}

	// Target flees at 22 m/s along road (+Z up to 110, then slight curve right) while police_car_0 pursues aggressively
	maxPoliceSpeed := 0.0
	var seenImpulse *VehicleImpulseEvent
	const dt = 0.05
	for tick := 0; tick < 200; tick++ {
		car := cars["car_0"]
		// Apply light driving cruise at ~22 m/s (with slight steering turn after Z > 80)
		spd := math.Hypot(car.VX, car.VZ)
		if spd < 22.0 {
			car.VX += math.Sin(car.Yaw) * 18.0 * dt
			car.VZ += math.Cos(car.Yaw) * 18.0 * dt
		}
		if car.Z > 80.0 && car.Yaw < math.Pi*0.5 {
			car.Yaw = math.Min(math.Pi*0.5, car.Yaw+1.2*dt)
			curSpd := math.Hypot(car.VX, car.VZ)
			car.VX = curSpd * math.Sin(car.Yaw)
			car.VZ = curSpd * math.Cos(car.Yaw)
		}
		car.X += car.VX * dt
		car.Z += car.VZ * dt
		car.Speed = car.VX*math.Sin(car.Yaw) + car.VZ*math.Cos(car.Yaw)
		users["vasya"].X = car.X
		users["vasya"].Z = car.Z
		users["vasya"].VX = car.VX
		users["vasya"].VZ = car.VZ
		users["vasya"].Speed = car.Speed

		out := pm.Step(dt, users, cars)
		pSpd := math.Hypot(pm.policeCars[0].vx, pm.policeCars[0].vz)
		if pSpd > maxPoliceSpeed {
			maxPoliceSpeed = pSpd
		}
		if len(out.ImpulseEvents) > 0 && seenImpulse == nil {
			ev := out.ImpulseEvents[0]
			seenImpulse = &ev
		}
		if seenImpulse != nil {
			break
		}
	}

	if maxPoliceSpeed < 30.0 {
		t.Fatalf("expected aggressive pursuit speed >= 30 m/s against fleeing target, got %.2f m/s", maxPoliceSpeed)
	}
	if seenImpulse == nil {
		t.Fatalf("expected police_car_0 to catch and collide/deflect fleeing target, maxPoliceSpeed=%.2f police=(%.2f,%.2f) target=(%.2f,%.2f) state=%s", maxPoliceSpeed, pm.policeCars[0].x, pm.policeCars[0].z, cars["car_0"].X, cars["car_0"].Z, pm.policeCars[0].state)
	}
	if math.Hypot(seenImpulse.DVX, seenImpulse.DVZ) <= 2.0 {
		t.Fatalf("expected substantial deflection impulse on fleeing car, got %+v", seenImpulse)
	}
}

func TestPoliceManager_DualPoliceSimultaneousCollisionAndParkedZeroVelocity(t *testing.T) {
	pm, err := NewPoliceManager(loadWorldMapConfig())
	if err != nil {
		t.Fatalf("NewPoliceManager failed: %v", err)
	}

	// Position police_car_0 (from -Z) and police_car_1 (from +Z) to collide simultaneously with car_0 in one 0.05s step
	pm.policeCars[0].x = 23.0
	pm.policeCars[0].z = 10.0
	pm.policeCars[0].yaw = 0.0
	pm.policeCars[0].vx = 0.0
	pm.policeCars[0].vz = 22.0
	pm.policeCars[0].speed = 22.0

	pm.policeCars[1].x = 23.0
	pm.policeCars[1].z = 18.8
	pm.policeCars[1].yaw = math.Pi
	pm.policeCars[1].vx = 0.0
	pm.policeCars[1].vz = -22.0
	pm.policeCars[1].speed = 22.0

	users := map[string]*UserState{
		"vasya": {Username: "vasya", Mode: ModeDriving, CarID: "car_0", X: 23.0, Z: 14.4},
	}
	cars := map[string]*CarState{
		"car_0": {CarID: "car_0", Driver: "vasya", X: 23.0, Z: 14.4, Yaw: 0.0},
		// Parked car overlapping police_car_0's forward path in a separate spot tested below
	}

	out := pm.Step(0.05, users, cars)
	if len(out.ImpulseEvents) != 2 {
		t.Fatalf("expected 2 separate vehicle_impulse events from dual simultaneous collision, got %d (%+v)",
			len(out.ImpulseEvents), out.ImpulseEvents)
	}
	seenPolice := map[string]bool{}
	for _, imp := range out.ImpulseEvents {
		if imp.CarID != "car_0" || imp.TargetUser != "vasya" {
			t.Fatalf("unexpected target in dual impulse: %+v", imp)
		}
		seenPolice[imp.PoliceCarID] = true
	}
	if !seenPolice["police_car_0"] || !seenPolice["police_car_1"] {
		t.Fatalf("expected impulses from both police_car_0 and police_car_1, got %+v", seenPolice)
	}

	// Immediate second overlap within 300ms suppresses both pairs independently
	pm.policeCars[0].z = 10.6
	pm.policeCars[0].vz = 18.0
	pm.policeCars[1].z = 18.2
	pm.policeCars[1].vz = -18.0
	cars["car_0"].Z = 14.4
	cars["car_0"].VX, cars["car_0"].VZ, cars["car_0"].Speed = 0, 0, 0
	outSuppressed := pm.Step(0.05, users, cars)
	if len(outSuppressed.ImpulseEvents) != 0 {
		t.Fatalf("expected both pairs suppressed within 300ms cooldown, got %+v", outSuppressed.ImpulseEvents)
	}

	// After 300ms elapses, both pairs can emit again
	pm.Step(0.30, map[string]*UserState{}, map[string]*CarState{})
	pm.policeCars[0].x, pm.policeCars[0].z, pm.policeCars[0].yaw = 23.0, 10.0, 0.0
	pm.policeCars[0].vx, pm.policeCars[0].vz, pm.policeCars[0].speed = 0.0, 22.0, 22.0
	pm.policeCars[1].x, pm.policeCars[1].z, pm.policeCars[1].yaw = 23.0, 18.8, math.Pi
	pm.policeCars[1].vx, pm.policeCars[1].vz, pm.policeCars[1].speed = 0.0, -22.0, 22.0
	cars["car_0"].X, cars["car_0"].Z = 23.0, 14.4
	cars["car_0"].VX, cars["car_0"].VZ, cars["car_0"].Speed = 0, 0, 0
	outReenabled := pm.Step(0.05, users, cars)
	if len(outReenabled.ImpulseEvents) != 2 {
		t.Fatalf("expected both pairs to re-emit after 300ms cooldown, got %+v", outReenabled.ImpulseEvents)
	}

	// Verify unoccupied parked car retains zero residual velocity after collision separation
	cars["car_parked"] = &CarState{CarID: "car_parked", Driver: "", X: 23.0, Z: 14.2, Yaw: 0.0}
	delete(cars, "car_0")
	pm.policeCars[0].x, pm.policeCars[0].z, pm.policeCars[0].yaw = 23.0, 10.0, 0.0
	pm.policeCars[0].vx, pm.policeCars[0].vz, pm.policeCars[0].speed = 0.0, 20.0, 20.0
	pm.policeCars[1].x, pm.policeCars[1].z = 110.5, -80.0
	outParked := pm.Step(0.05, map[string]*UserState{}, cars)
	if _, ok := outParked.ModifiedCars["car_parked"]; !ok {
		t.Fatalf("expected parked car collision separation to mark ModifiedCars")
	}
	parked := cars["car_parked"]
	if parked.VX != 0 || parked.VZ != 0 || parked.YawRate != 0 || parked.Speed != 0 {
		t.Fatalf("expected unoccupied parked car residual velocity zeroed, got vx=%v vz=%v yawRate=%v speed=%v",
			parked.VX, parked.VZ, parked.YawRate, parked.Speed)
	}
}

func TestPoliceManager_UnstuckRecoveryWhenPinnedAgainstWall(t *testing.T) {
	pm, err := NewPoliceManager(loadWorldMapConfig())
	if err != nil {
		t.Fatalf("NewPoliceManager failed: %v", err)
	}

	// Pin police_car_0 nose-first against the Z=165 boundary while target car is outside stop distance
	pm.policeCars[0].x = 23.0
	pm.policeCars[0].z = 162.55
	pm.policeCars[0].yaw = 0.0
	pm.policeCars[0].vx = 0.0
	pm.policeCars[0].vz = 0.0
	pm.policeCars[0].state = PoliceCarStateChase
	pm.policeCars[0].targetCarID = "car_0"
	pm.policeCars[0].targetUser = "vasya"
	pm.policeCars[0].siren = true
	pm.policeCars[0].lights = true
	pm.policeCars[0].chaseStartedAt = 0.0

	users := map[string]*UserState{
		"vasya": {Username: "vasya", Mode: ModeDriving, CarID: "car_0", X: 23.0, Z: 175.0},
	}
	cars := map[string]*CarState{
		"car_0": {CarID: "car_0", Driver: "vasya", X: 23.0, Z: 175.0},
	}

	triggeredUnstuck := false
	movedAwayFromWall := false
	for tick := 0; tick < 60; tick++ {
		pm.Step(0.05, users, cars)
		if pm.policeCars[0].unstuckSec > 0 {
			triggeredUnstuck = true
		}
		if pm.policeCars[0].z < 161.0 && math.Hypot(pm.policeCars[0].vx, pm.policeCars[0].vz) > 1.0 {
			movedAwayFromWall = true
		}
	}
	if !triggeredUnstuck {
		t.Fatalf("expected unstuck recovery to activate when pinned against wall > 1.5s")
	}
	if !movedAwayFromWall {
		t.Fatalf("expected police_car_0 to reverse/steer away from wall during unstuck recovery (z=%.2f, vx=%.2f, vz=%.2f)",
			pm.policeCars[0].z, pm.policeCars[0].vx, pm.policeCars[0].vz)
	}
}

func TestPoliceManager_TwoCarsSplitBetweenMultipleSpeeders(t *testing.T) {
	pm, err := NewPoliceManager(loadWorldMapConfig())
	if err != nil {
		t.Fatalf("NewPoliceManager failed: %v", err)
	}

	users := map[string]*UserState{
		"vasya": {Username: "vasya", Mode: ModeDriving, CarID: "car_0", X: pm.policeCars[0].x, Z: pm.policeCars[0].z + 15.0, Speed: 16.0, VZ: 16.0},
		"petya": {Username: "petya", Mode: ModeDriving, CarID: "car_1", X: pm.policeCars[1].x, Z: pm.policeCars[1].z + 15.0, Speed: 16.0, VZ: 16.0},
	}
	cars := map[string]*CarState{
		"car_0": {CarID: "car_0", Driver: "vasya", X: pm.policeCars[0].x, Z: pm.policeCars[0].z + 15.0, Speed: 16.0, VZ: 16.0},
		"car_1": {CarID: "car_1", Driver: "petya", X: pm.policeCars[1].x, Z: pm.policeCars[1].z + 15.0, Speed: 16.0, VZ: 16.0},
	}

	pm.Step(0.05, users, cars)
	if pm.policeCars[0].state != PoliceCarStateChase || pm.policeCars[1].state != PoliceCarStateChase {
		t.Fatalf("expected both police cars chasing, got %s and %s", pm.policeCars[0].state, pm.policeCars[1].state)
	}
	if pm.policeCars[0].targetUser == "" || pm.policeCars[1].targetUser == "" ||
		pm.policeCars[0].targetUser == pm.policeCars[1].targetUser {
		t.Fatalf("expected 2 police cars to split across vasya and petya, got %q and %q",
			pm.policeCars[0].targetUser, pm.policeCars[1].targetUser)
	}

	// Once petya disconnects, the freed police car immediately converges onto vasya
	pm.OnPlayerDisconnected("petya")
	delete(users, "petya")
	cars["car_1"].Driver = ""
	cars["car_1"].Speed, cars["car_1"].VZ = 0, 0
	pm.Step(0.05, users, cars)
	if pm.policeCars[0].targetUser != "vasya" || pm.policeCars[1].targetUser != "vasya" {
		t.Fatalf("expected both police cars to converge on remaining speeder vasya, got %q and %q",
			pm.policeCars[0].targetUser, pm.policeCars[1].targetUser)
	}
}

func TestPoliceManager_BumpPatrollingPoliceCarTriggersChase(t *testing.T) {
	pm, err := NewPoliceManager(loadWorldMapConfig())
	if err != nil {
		t.Fatalf("NewPoliceManager failed: %v", err)
	}

	// Even during post-evasion grace and <= 40 km/h speed, bumping a patrolling police car triggers chase!
	pm.chaseGraceUntil["vasya"] = pm.simTimeSec + 10.0
	pm.policeCars[0].x = 23.0
	pm.policeCars[0].z = 10.0
	pm.policeCars[0].yaw = 0.0
	pm.policeCars[0].vx = 0.0
	pm.policeCars[0].vz = 2.0
	pm.policeCars[0].speed = 2.0

	users := map[string]*UserState{
		"vasya": {Username: "vasya", Mode: ModeDriving, CarID: "car_0", X: 23.0, Z: 13.8, VZ: -5.0, Speed: -5.0},
	}
	cars := map[string]*CarState{
		"car_0": {CarID: "car_0", Driver: "vasya", X: 23.0, Z: 13.8, Yaw: 0.0, VZ: -5.0, Speed: -5.0},
	}

	out := pm.Step(0.05, users, cars)
	foundCollisionChase := false
	for _, ev := range out.ChaseEvents {
		if ev.Status == ChaseStatusStarted && ev.Reason == "collision" && ev.TargetUser == "vasya" {
			foundCollisionChase = true
		}
	}
	if !foundCollisionChase {
		t.Fatalf("expected low-speed bump into patrolling police car to start collision chase, got %+v", out.ChaseEvents)
	}

	// Stopping leads to traffic_collision dialogue scenario
	for i := 0; i < 15; i++ {
		cars["car_0"].X = pm.policeCars[0].x + 2.5
		cars["car_0"].Z = pm.policeCars[0].z + 2.5
		cars["car_0"].VX, cars["car_0"].VZ, cars["car_0"].Speed = 0, 0, 0
		users["vasya"].X, users["vasya"].Z = cars["car_0"].X, cars["car_0"].Z
		pm.Step(0.05, users, cars)
		if pm.IsUserInFineStop("vasya") {
			break
		}
	}
	if !pm.IsUserInFineStop("vasya") {
		t.Fatal("expected collision chase stop to enter fine_stop")
	}
	var colEnc *OutboundPoliceEncounterStartMsg
	for i := 0; i < 120; i++ {
		res := pm.Step(0.05, users, cars)
		if len(res.EncounterStarts) > 0 {
			m := res.EncounterStarts[0].Msg
			colEnc = &m
			break
		}
	}
	if colEnc == nil || colEnc.ScenarioID != "traffic_collision" || colEnc.EncounterKind != EncounterKindTraffic {
		t.Fatalf("expected traffic_collision scenario after collision stop, got %+v", colEnc)
	}
}

func TestPoliceManager_FootPursuitOnChasedCarExit(t *testing.T) {
	pm, err := NewPoliceManager(loadWorldMapConfig())
	if err != nil {
		t.Fatalf("NewPoliceManager failed: %v", err)
	}

	cop := pm.footCops[0]
	// Place player car near police_car_0 AND within 75m of cop[0]
	cars := map[string]*CarState{
		"car_0": {CarID: "car_0", Driver: "vasya", X: pm.policeCars[0].x, Z: pm.policeCars[0].z + 14.0, Speed: 18.0, VZ: 18.0},
	}
	users := map[string]*UserState{
		"vasya": {Username: "vasya", Mode: ModeDriving, CarID: "car_0", X: cars["car_0"].X, Z: cars["car_0"].Z, Speed: 18.0, VZ: 18.0},
	}
	pm.Step(0.05, users, cars) // Start car chase

	// Player exits the chased car ~12m away from foot cop 0
	exitX, exitZ := cop.x+12.0, cop.z
	cars["car_0"].Driver = ""
	cars["car_0"].Speed, cars["car_0"].VX, cars["car_0"].VZ = 0, 0, 0
	users["vasya"].Mode = ModePedestrian
	users["vasya"].CarID = ""
	users["vasya"].X = exitX
	users["vasya"].Z = exitZ
	exitEvents := pm.OnPlayerExitedVehicle("vasya", "car_0", exitX, exitZ)
	if len(exitEvents) == 0 || exitEvents[0].Reason != "target_exited" {
		t.Fatalf("expected car chase ended with target_exited, got %+v", exitEvents)
	}

	pm.Step(0.05, users, cars)
	if cop.state != CopStateChase || cop.targetUser != "vasya" || cop.anim != AnimRun {
		t.Fatalf("expected nearby foot cop to pursue on foot (chase/run), got state=%s target=%q anim=%s", cop.state, cop.targetUser, cop.anim)
	}

	// Step until foot cop catches stationary vasya and opens traffic_foot_escape dialogue
	var footFineStop *OutboundPoliceFineStopMsg
	var footEnc *OutboundPoliceEncounterStartMsg
	for i := 0; i < 60; i++ {
		res := pm.Step(0.05, users, cars)
		for _, fs := range res.FineStopEvents {
			f := fs
			footFineStop = &f
		}
		if len(res.EncounterStarts) > 0 {
			m := res.EncounterStarts[0].Msg
			footEnc = &m
			break
		}
	}
	if footFineStop == nil || footFineStop.Stage != "dialogue" || footFineStop.CarID != "car_0" {
		t.Fatalf("expected foot-pursuit catch fine_stop dialogue stage for car_0, got %+v", footFineStop)
	}
	if footEnc == nil || footEnc.ScenarioID != "traffic_foot_escape" || footEnc.EncounterKind != EncounterKindTraffic {
		t.Fatalf("expected traffic_foot_escape scenario, got %+v", footEnc)
	}

	// Choosing 66666 leaves car_0 unblocked
	res, err := pm.HandleDialogueChoice("vasya", footEnc.EncounterID, 3)
	if err != nil {
		t.Fatalf("66666 choice failed: %v", err)
	}
	if res.Fine != PoliceMaxFineNoBan || res.VehicleBlocked || pm.IsVehicleBanned("car_0") {
		t.Fatalf("expected 66666 option to keep car_0 unblocked, got %+v", res)
	}

	// Second exit pursuit: verify 1-minute max foot pursuit duration timeout gives up cleanly
	pm.Step(16.0, map[string]*UserState{}, cars)
	cars["car_0"].Driver = "petya"
	cars["car_0"].X, cars["car_0"].Z = pm.policeCars[0].x, pm.policeCars[0].z+12.0
	cars["car_0"].Speed, cars["car_0"].VZ = 18.0, 18.0
	users["petya"] = &UserState{Username: "petya", Mode: ModeDriving, CarID: "car_0", X: cars["car_0"].X, Z: cars["car_0"].Z, Speed: 18.0, VZ: 18.0}
	pm.Step(0.05, users, cars)

	cars["car_0"].Driver = ""
	cars["car_0"].Speed, cars["car_0"].VZ = 0, 0
	users["petya"].Mode = ModePedestrian
	users["petya"].CarID = ""
	users["petya"].X = cop.x + 15.0
	users["petya"].Z = cop.z
	pm.OnPlayerExitedVehicle("petya", "car_0", users["petya"].X, users["petya"].Z)
	pm.Step(0.05, users, cars)
	if cop.state != CopStateChase {
		t.Fatalf("expected cop chasing petya before 60s expiry, got %s", cop.state)
	}
	// Keep petya out of reach past 60s
	for i := 0; i < 121; i++ {
		users["petya"].X = cop.x + 25.0
		users["petya"].Z = cop.z
		pm.Step(0.5, users, cars)
	}
	if cop.state != CopStatePatrol || pm.ActiveEncounterFor("petya") != nil {
		t.Fatalf("expected 1-minute foot pursuit to expire cleanly back to patrol, got state=%s enc=%v", cop.state, pm.ActiveEncounterFor("petya"))
	}
}

func TestPoliceManager_FineStopOfficerWalk66666Vs5MinBanAndDisconnectBan(t *testing.T) {
	pm, err := NewPoliceManager(loadWorldMapConfig())
	if err != nil {
		t.Fatalf("NewPoliceManager failed: %v", err)
	}

	users := map[string]*UserState{
		"vasya": {Username: "vasya", Mode: ModeDriving, CarID: "car_0", X: pm.policeCars[0].x, Z: pm.policeCars[0].z + 12.0, Speed: 18.0, VZ: 18.0},
	}
	cars := map[string]*CarState{
		"car_0": {CarID: "car_0", Driver: "vasya", X: pm.policeCars[0].x, Z: pm.policeCars[0].z + 12.0, Speed: 18.0, VZ: 18.0},
	}
	pm.Step(0.05, users, cars)
	for i := 0; i < 15; i++ {
		cars["car_0"].X, cars["car_0"].Z = pm.policeCars[0].x+3.5, pm.policeCars[0].z+1.0
		cars["car_0"].VX, cars["car_0"].VZ, cars["car_0"].Speed = 0, 0, 0
		users["vasya"].X, users["vasya"].Z = cars["car_0"].X, cars["car_0"].Z
		pm.Step(0.05, users, cars)
		if pm.IsUserInFineStop("vasya") {
			break
		}
	}
	if !pm.IsUserInFineStop("vasya") {
		t.Fatal("expected fine_stop to start")
	}

	// Before choice, disconnect must impose 5-min car ban and remove spawned DPS officer
	snapMid := pm.Snapshot()
	hasCarOfficer := false
	for _, c := range snapMid.FootCops {
		if strings.HasPrefix(c.ID, "dps_") {
			hasCarOfficer = true
		}
	}
	if !hasCarOfficer {
		t.Fatal("expected dynamic dps officer spawned during fine_stop")
	}

	pm.OnPlayerDisconnected("vasya")
	if !pm.IsVehicleBanned("car_0") || pm.IsUserInFineStop("vasya") {
		t.Fatalf("expected disconnect mid-fine-stop to ban car_0 and clear activeFineStop")
	}
	snapAfterDisc := pm.Snapshot()
	for _, c := range snapAfterDisc.FootCops {
		if strings.HasPrefix(c.ID, "dps_") {
			t.Fatalf("expected dynamic dps officer removed on disconnect, still found %+v", c)
		}
	}
}
