package game

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/vmihailenco/msgpack/v5"
)

type hubCmd any

const defaultSessionTTL = 5 * time.Minute

type userSession struct {
	token    string
	lastSeen time.Time
}

// AccountState holds authoritative persistent player economy state.
type AccountState struct {
	Money int64
}

func generateSessionToken() (string, error) {
	b := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

type cmdRegister struct {
	client *Client
	token  string
	result chan bool
}

type cmdSetSessionTTL struct {
	ttl    time.Duration
	result chan struct{}
}

type cmdUnregister struct {
	client *Client
	reason string
}

type cmdBroadcast struct {
	sender        *Client
	excludeSender bool
	data          []byte
}

type cmdMovePedestrian struct {
	sender *Client
	move   *OutboundPedestrianMoveMsg
	data   []byte
}

type cmdMoveDriving struct {
	sender *Client
	move   *OutboundDrivingMoveMsg
	data   []byte
}

type cmdSendDirect struct {
	client *Client
	data   []byte
}

type cmdSnapshot struct {
	result chan HubSnapshot
}

type cmdCannonFire struct {
	sender *Client
}

type cmdTriggerNoon struct {
	result chan struct{}
}

type cmdTickNoon struct {
	result chan bool
}

type cmdSetNowFunc struct {
	fn     func() time.Time
	result chan struct{}
}

type cmdStepSimulation struct {
	dt     float64
	result chan struct{}
}

type cmdSetSimAutoTick struct {
	enabled bool
	result  chan struct{}
}

type cmdPoliceDialogueChoice struct {
	sender *Client
	choice *PoliceDialogueChoiceRequest
}

// HubSnapshot contains an immutable copy of cars, users, accounts, and police state.
type HubSnapshot struct {
	Cars     map[string]CarState
	Users    map[string]UserState
	Accounts map[string]int64
	Police   PoliceSnapshot
}

type fortressCoords struct {
	x      float64
	z      float64
	radius float64
}

// Hub maintains the set of active clients, tracks world state (cars, users, accounts, police), and broadcasts messages via an actor loop.
type Hub struct {
	sequence       uint64
	policeSeq      uint64
	started        time.Time
	clients        map[string]*Client
	cars           map[string]*CarState
	users          map[string]*UserState
	accounts       map[string]*AccountState
	sessions       map[string]*userSession
	sessionTTL     time.Duration
	allowedCars    map[string]struct{}
	fortress       fortressCoords
	cannonCooldown time.Duration
	lastCannonFire map[string]time.Time
	noonFiredDate  string
	nowFunc        func() time.Time
	police         *PoliceManager
	simAutoTick    bool
	cmdCh          chan hubCmd

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func vladivostokDateAndNoon(now time.Time) (dateStr string, todayNoonUtc time.Time) {
	utc := now.UTC()
	vvoTime := utc.Add(10 * time.Hour)
	year, month, day := vvoTime.Date()
	dateStr = fmt.Sprintf("%04d-%02d-%02d", year, month, day)
	todayNoonUtc = time.Date(year, month, day, 2, 0, 0, 0, time.UTC)
	return dateStr, todayNoonUtc
}

func nextVladivostokNoonDelay(now time.Time) time.Duration {
	_, todayNoonUtc := vladivostokDateAndNoon(now)
	target := todayNoonUtc
	if !now.Before(todayNoonUtc) {
		target = todayNoonUtc.AddDate(0, 0, 1)
	}
	d := target.Sub(now)
	if d <= 0 {
		d = time.Second
	}
	return d
}

// NewHub creates and starts a new Hub instance.
func NewHub(parentCtx context.Context, allowedCars ...string) *Hub {
	ctx, cancel := context.WithCancel(parentCtx)
	worldCfg := loadWorldMapConfig()
	allowedMap := make(map[string]struct{})
	if len(allowedCars) > 0 {
		for _, c := range allowedCars {
			if !strings.HasPrefix(c, "police_car") {
				allowedMap[c] = struct{}{}
			}
		}
	} else {
		// Default to world vehicles defined in world_map.json (never police cars)
		allowedMap["car_0"] = struct{}{}
		allowedMap["car_1"] = struct{}{}
		allowedMap["car_2"] = struct{}{}
		allowedMap["car_3"] = struct{}{}
		allowedMap["car_4"] = struct{}{}
		for _, id := range worldCfg.vehicleIDs {
			if !strings.HasPrefix(id, "police_car") {
				allowedMap[id] = struct{}{}
			}
		}
	}

	pm, err := NewPoliceManager(worldCfg)
	if err != nil {
		panic(fmt.Sprintf("failed to initialize police manager: %v", err))
	}

	h := &Hub{
		started:        time.Now(),
		clients:        make(map[string]*Client),
		cars:           make(map[string]*CarState),
		users:          make(map[string]*UserState),
		accounts:       make(map[string]*AccountState),
		sessions:       make(map[string]*userSession),
		sessionTTL:     defaultSessionTTL,
		allowedCars:    allowedMap,
		fortress:       worldCfg.fortress,
		cannonCooldown: 2 * time.Second,
		lastCannonFire: make(map[string]time.Time),
		police:         pm,
		simAutoTick:    true,
		cmdCh:          make(chan hubCmd, 2048),
		ctx:            ctx,
		cancel:         cancel,
	}
	h.wg.Add(1)
	go h.run()
	return h
}

// SetSessionTTL overrides session reservation duration safely via the actor loop (useful for tests).
func (h *Hub) SetSessionTTL(ttl time.Duration) {
	res := make(chan struct{})
	select {
	case h.cmdCh <- &cmdSetSessionTTL{ttl: ttl, result: res}:
		select {
		case <-res:
		case <-h.ctx.Done():
		}
	case <-h.ctx.Done():
	}
}

// Register attempts to add a client to the hub and broadcasts join if successful.
// Accepts an optional session token for reconnecting users.
func (h *Hub) Register(client *Client, token ...string) bool {
	resCh := make(chan bool, 1)
	tok := ""
	if len(token) > 0 {
		tok = strings.TrimSpace(token[0])
	} else if client != nil {
		tok = strings.TrimSpace(client.SessionToken)
	}
	req := &cmdRegister{
		client: client,
		token:  tok,
		result: resCh,
	}

	select {
	case h.cmdCh <- req:
	case <-h.ctx.Done():
		return false
	}

	select {
	case ok := <-resCh:
		return ok
	case <-h.ctx.Done():
		return false
	}
}

// Unregister removes a client and broadcasts a leave event if the client was registered.
func (h *Hub) Unregister(client *Client, reason string) {
	req := &cmdUnregister{
		client: client,
		reason: reason,
	}

	select {
	case h.cmdCh <- req:
	case <-h.ctx.Done():
	}
}

// Broadcast dispatches pre-encoded data to clients.
func (h *Hub) Broadcast(sender *Client, excludeSender bool, data []byte) {
	req := &cmdBroadcast{
		sender:        sender,
		excludeSender: excludeSender,
		data:          data,
	}

	select {
	case h.cmdCh <- req:
	case <-h.ctx.Done():
	}
}

// BroadcastPedestrianMove records the player's last seen pedestrian position and broadcasts it.
func (h *Hub) BroadcastPedestrianMove(sender *Client, move *OutboundPedestrianMoveMsg, data []byte) {
	req := &cmdMovePedestrian{
		sender: sender,
		move:   move,
		data:   data,
	}

	select {
	case h.cmdCh <- req:
	case <-h.ctx.Done():
	}
}

// BroadcastDrivingMove records the vehicle and driver positions and broadcasts it.
func (h *Hub) BroadcastDrivingMove(sender *Client, move *OutboundDrivingMoveMsg, data []byte) {
	req := &cmdMoveDriving{
		sender: sender,
		move:   move,
		data:   data,
	}

	select {
	case h.cmdCh <- req:
	case <-h.ctx.Done():
	}
}

// Snapshot returns an immutable copy of all tracked cars, active users, accounts, and police state.
func (h *Hub) Snapshot() HubSnapshot {
	emptySnap := func() HubSnapshot {
		return HubSnapshot{
			Cars:     make(map[string]CarState),
			Users:    make(map[string]UserState),
			Accounts: make(map[string]int64),
			Police: PoliceSnapshot{
				FootCops:         make([]PoliceFootCopState, 0),
				PoliceCars:       make([]PoliceCarState, 0),
				ActiveEncounters: make(map[string]OutboundPoliceEncounterStartMsg),
			},
		}
	}
	select {
	case <-h.ctx.Done():
		return emptySnap()
	default:
	}

	resCh := make(chan HubSnapshot, 1)
	req := &cmdSnapshot{result: resCh}

	select {
	case h.cmdCh <- req:
		select {
		case snap := <-resCh:
			return snap
		case <-h.ctx.Done():
			return emptySnap()
		}
	case <-h.ctx.Done():
		return emptySnap()
	}
}

// SendDirect queues a message to a specific client safely through the Hub actor.
func (h *Hub) SendDirect(client *Client, data []byte) {
	req := &cmdSendDirect{
		client: client,
		data:   data,
	}

	select {
	case h.cmdCh <- req:
	case <-h.ctx.Done():
	}
}

// RequestCannonFire forwards a client request to fire the fortress cannon into the Hub actor.
func (h *Hub) RequestCannonFire(sender *Client) {
	req := &cmdCannonFire{sender: sender}
	select {
	case h.cmdCh <- req:
	case <-h.ctx.Done():
	}
}

// TriggerNoonCannon triggers a noon cannon broadcast explicitly (primarily for tests).
func (h *Hub) TriggerNoonCannon() {
	res := make(chan struct{})
	select {
	case h.cmdCh <- &cmdTriggerNoon{result: res}:
		select {
		case <-res:
		case <-h.ctx.Done():
		}
	case <-h.ctx.Done():
	}
}

// SetNowFunc injects a custom clock for simulation testing.
func (h *Hub) SetNowFunc(fn func() time.Time) {
	res := make(chan struct{})
	select {
	case h.cmdCh <- &cmdSetNowFunc{fn: fn, result: res}:
		select {
		case <-res:
		case <-h.ctx.Done():
		}
	case <-h.ctx.Done():
	}
}

// StepSimulation synchronously advances the police simulation by dt seconds inside the Hub actor.
func (h *Hub) StepSimulation(dt float64) {
	res := make(chan struct{})
	select {
	case h.cmdCh <- &cmdStepSimulation{dt: dt, result: res}:
		select {
		case <-res:
		case <-h.ctx.Done():
		}
	case <-h.ctx.Done():
	}
}

// SetSimAutoTick enables or disables the background 20 Hz simulation ticker (useful for deterministic tests).
func (h *Hub) SetSimAutoTick(enabled bool) {
	res := make(chan struct{})
	select {
	case h.cmdCh <- &cmdSetSimAutoTick{enabled: enabled, result: res}:
		select {
		case <-res:
		case <-h.ctx.Done():
		}
	case <-h.ctx.Done():
	}
}

// SubmitPoliceDialogueChoice forwards a validated police dialogue option selection into the Hub actor.
func (h *Hub) SubmitPoliceDialogueChoice(sender *Client, choice *PoliceDialogueChoiceRequest) {
	req := &cmdPoliceDialogueChoice{
		sender: sender,
		choice: choice,
	}
	select {
	case h.cmdCh <- req:
	case <-h.ctx.Done():
	}
}

// TickNoon evaluates whether noon cannon should fire according to the clock and broadcasts if due.
// Returns true if the noon event fired, false otherwise (useful for deterministic tests).
func (h *Hub) TickNoon() bool {
	res := make(chan bool, 1)
	select {
	case h.cmdCh <- &cmdTickNoon{result: res}:
		select {
		case fired := <-res:
			return fired
		case <-h.ctx.Done():
			return false
		}
	case <-h.ctx.Done():
		return false
	}
}

// evaluateNoonTransition checks if a noon cannon broadcast is due for the given time.
// If due and not yet fired for today's Vladivostok date, it marks the date and returns true.
// Must be called from the actor loop.
func (h *Hub) evaluateNoonTransition(now time.Time) bool {
	dateStr, todayNoonUtc := vladivostokDateAndNoon(now)
	if h.noonFiredDate == dateStr {
		return false
	}
	if now.Before(todayNoonUtc) {
		return false
	}
	if now.After(todayNoonUtc.Add(60 * time.Second)) {
		return false
	}
	h.noonFiredDate = dateStr
	return true
}

func (h *Hub) now() time.Time {
	if h.nowFunc != nil {
		return h.nowFunc()
	}
	return time.Now()
}

// Stop terminates the hub event loop and cleans up.
func (h *Hub) Stop() {
	h.cancel()
	h.wg.Wait()
}

// run is the single-threaded actor loop owning the clients map.
func (h *Hub) run() {
	defer h.wg.Done()

	cleanTicker := time.NewTicker(time.Minute)
	defer cleanTicker.Stop()

	simTicker := time.NewTicker(50 * time.Millisecond)
	defer simTicker.Stop()

	noonTimer := time.NewTimer(nextVladivostokNoonDelay(h.now()))
	defer noonTimer.Stop()

	for {
		select {
		case <-h.ctx.Done():
			for _, client := range h.clients {
				close(client.send)
				client.CloseSocket()
			}
			h.clients = make(map[string]*Client)
			return

		case <-cleanTicker.C:
			now := h.now()
			for uname, sess := range h.sessions {
				if _, online := h.clients[uname]; !online {
					if h.sessionTTL <= 0 || now.Sub(sess.lastSeen) > h.sessionTTL {
						delete(h.sessions, uname)
						delete(h.lastCannonFire, uname)
						delete(h.accounts, uname)
						h.police.CleanupExpiredUser(uname)
					}
				}
			}

		case <-simTicker.C:
			if h.simAutoTick {
				h.stepSimulationLocked(0.05)
			}

		case <-noonTimer.C:
			now := h.now()
			if h.evaluateNoonTransition(now) {
				noonMsg, _ := msgpack.Marshal(OutboundCannonShotMsg{
					Type:   TypeCannonShot,
					User:   "",
					Reason: "noon",
				})
				h.broadcastData(noonMsg, nil)
			}
			noonTimer.Reset(nextVladivostokNoonDelay(h.now()))

		case cmd := <-h.cmdCh:
			switch c := cmd.(type) {
			case *cmdRegister:
				sess, hasSession := h.sessions[c.client.Username]
				existingClient, isConnected := h.clients[c.client.Username]

				now := h.now()
				if hasSession && !isConnected && (h.sessionTTL <= 0 || now.Sub(sess.lastSeen) > h.sessionTTL) {
					delete(h.sessions, c.client.Username)
					delete(h.lastCannonFire, c.client.Username)
					delete(h.accounts, c.client.Username)
					h.police.CleanupExpiredUser(c.client.Username)
					hasSession = false
					sess = nil
				}

				isReconnection := false
				var assignedToken string

				if isConnected {
					// Client with this username is currently connected.
					// Check if incoming client provides matching session token.
					if hasSession && c.token != "" && sess.token == c.token {
						// Authorized replacement of existing connection
						isReconnection = true
						assignedToken = sess.token
						sess.lastSeen = now
						c.client.SessionToken = assignedToken

						// Atomically replace client in map before terminating old client
						oldClient := existingClient
						h.clients[c.client.Username] = c.client
						oldClient.TerminateReplaced(4408, "session replaced from another connection")
						close(oldClient.send)
					} else {
						// Name in active use and token missing or invalid
						c.result <- false
						continue
					}
				} else {
					// Username not currently connected
					if hasSession {
						if c.token != "" && sess.token == c.token {
							// Authorized returning player
							isReconnection = true
							assignedToken = sess.token
							sess.lastSeen = now
							c.client.SessionToken = assignedToken
						} else {
							// Disconnected name is reserved under an active session within sessionTTL;
							// missing or mismatched token is rejected
							c.result <- false
							continue
						}
					} else {
						// Brand new user, session expired, or connecting without token after disconnect: generate new token
						tok, err := generateSessionToken()
						if err != nil {
							c.result <- false
							continue
						}
						assignedToken = tok
						h.sessions[c.client.Username] = &userSession{
							token:    assignedToken,
							lastSeen: now,
						}
						c.client.SessionToken = assignedToken
					}

					h.clients[c.client.Username] = c.client
				}

				c.result <- true

				acct := h.ensureAccountLocked(c.client.Username)

				// 1. Send personalized join message with session token, roster, and authoritative money
				roster := make([]string, 0, len(h.clients))
				for u := range h.clients {
					roster = append(roster, u)
				}
				selfJoinMsg, _ := msgpack.Marshal(OutboundJoinMsg{
					Type:   TypeJoin,
					User:   c.client.Username,
					Token:  assignedToken,
					Roster: roster,
					Money:  Int64Ptr(acct.Money),
				})
				select {
				case c.client.send <- selfJoinMsg:
				default:
				}

				// 2. Broadcast join WITHOUT token to other clients if not an in-place connection replacement
				if !isReconnection || !isConnected {
					broadcastJoinMsg, _ := msgpack.Marshal(OutboundJoinMsg{
						Type: TypeJoin,
						User: c.client.Username,
					})
					h.broadcastData(broadcastJoinMsg, c.client)
				}

				// Verify newcomer survived join broadcast (in case it was evicted as a slow consumer)
				if existing, ok := h.clients[c.client.Username]; !ok || existing != c.client {
					continue
				}

				baselineFailed := false

				// Send all currently tracked car positions to the newly joined client
				for _, car := range h.cars {
					carMsg, err := msgpack.Marshal(OutboundDrivingMoveMsg{
						Username:     car.Driver, // "" if parked, or driver username
						Type:         TypeMove,
						Mode:         ModeDriving,
						CarID:        car.CarID,
						X:            car.X,
						Y:            car.Y,
						Z:            car.Z,
						Speed:        car.Speed,
						VX:           car.VX,
						VZ:           car.VZ,
						YawRate:      car.YawRate,
						Sequence:     car.Sequence,
						SampleTimeMS: car.SampleTimeMS,
						Yaw:          car.Yaw,
						Drift:        car.Drift,
						Lights:       car.Lights,
					})
					if err == nil {
						select {
						case c.client.send <- carMsg:
						default:
							baselineFailed = true
							break
						}
					}
					if baselineFailed {
						break
					}
				}

				if baselineFailed {
					h.removeClientLocked(c.client, "slow consumer")
					continue
				}

				// Send all other connected users' last seen positions to the newly joined client
				for uname, userState := range h.users {
					if uname == c.client.Username {
						continue
					}
					var userMsg []byte
					var err error
					if userState.Mode == ModeDriving {
						userMsg, err = msgpack.Marshal(OutboundDrivingMoveMsg{
							Username:     userState.Username,
							Type:         TypeMove,
							Mode:         ModeDriving,
							CarID:        userState.CarID,
							X:            userState.X,
							Y:            userState.Y,
							Z:            userState.Z,
							Speed:        userState.Speed,
							VX:           userState.VX,
							VZ:           userState.VZ,
							YawRate:      userState.YawRate,
							Sequence:     userState.Sequence,
							SampleTimeMS: userState.SampleTimeMS,
							Yaw:          userState.Yaw,
							Drift:        userState.Drift,
							Lights:       userState.Lights,
						})
					} else {
						userMsg, err = msgpack.Marshal(OutboundPedestrianMoveMsg{
							Username: userState.Username,
							Type:     TypeMove,
							Mode:     ModePedestrian,
							X:        userState.X,
							Y:        userState.Y,
							Z:        userState.Z,
							VX:       userState.VX,
							VZ:       userState.VZ,
							Yaw:      userState.Yaw,
							Anim:     userState.Anim,
						})
					}
					if err == nil {
						select {
						case c.client.send <- userMsg:
						default:
							baselineFailed = true
							break
						}
					}
					if baselineFailed {
						break
					}
				}

				if baselineFailed {
					h.removeClientLocked(c.client, "slow consumer")
					continue
				}

				// 5. Send current authoritative police_state baseline
				if policeMsg, err := msgpack.Marshal(h.police.StateMsg(h.policeSeq)); err == nil {
					select {
					case c.client.send <- policeMsg:
					default:
						baselineFailed = true
					}
				}
				if baselineFailed {
					h.removeClientLocked(c.client, "slow consumer")
					continue
				}

				// 6. Re-send unresolved fine stop and police encounter if preserved across 4408 replacement
				if fs := h.police.ActiveFineStopFor(c.client.Username); fs != nil {
					if fsMsg, err := msgpack.Marshal(*fs); err == nil {
						select {
						case c.client.send <- fsMsg:
						default:
							baselineFailed = true
						}
					}
				}
				if baselineFailed {
					h.removeClientLocked(c.client, "slow consumer")
					continue
				}

				if enc := h.police.ActiveEncounterFor(c.client.Username); enc != nil {
					if encMsg, err := msgpack.Marshal(*enc); err == nil {
						select {
						case c.client.send <- encMsg:
						default:
							baselineFailed = true
						}
					}
				}
				if baselineFailed {
					h.removeClientLocked(c.client, "slow consumer")
					continue
				}

			case *cmdUnregister:
				existing, exists := h.clients[c.client.Username]
				if !exists || existing != c.client {
					// Idempotent: already removed or replaced by a new connection
					continue
				}

				if sess, has := h.sessions[c.client.Username]; has {
					sess.lastSeen = h.now()
				}

				releasedCar, chaseEvents := h.cleanupUserStateLocked(c.client.Username)

				delete(h.clients, c.client.Username)
				close(c.client.send)
				c.client.CloseSocket()

				// Broadcast leave to remaining clients
				leaveMsg, _ := msgpack.Marshal(OutboundLeaveMsg{
					Type:   TypeLeave,
					User:   c.client.Username,
					Reason: c.reason,
				})
				h.broadcastData(leaveMsg, nil)

				if releasedCar != nil {
					h.broadcastCarStateLocked(releasedCar)
				}
				for _, ce := range chaseEvents {
					if data, err := msgpack.Marshal(ce); err == nil {
						h.broadcastData(data, nil)
					}
				}

			case *cmdMovePedestrian:
				if existing, ok := h.clients[c.sender.Username]; !ok || existing != c.sender {
					continue
				}

				if h.police.IsUserInFineStop(c.sender.Username) {
					// Keep detained player pinned at the fine-stop position until the encounter resolves
					continue
				}

				// If user was previously driving a car, release that car as parked
				var prevCar *CarState
				if prev, ok := h.users[c.sender.Username]; ok && prev.Mode == ModeDriving && prev.CarID != "" {
					if car, carExists := h.cars[prev.CarID]; carExists && car.Driver == c.sender.Username {
						car.Driver = ""
						car.Speed = 0
						car.VX, car.VZ, car.YawRate = 0, 0, 0
						car.Drift = false
						prevCar = car
					}
				}

				h.users[c.sender.Username] = &UserState{
					Username: c.sender.Username,
					Mode:     ModePedestrian,
					X:        c.move.X,
					Y:        c.move.Y,
					Z:        c.move.Z,
					VX:       c.move.VX,
					VZ:       c.move.VZ,
					Yaw:      c.move.Yaw,
					Anim:     c.move.Anim,
				}

				h.broadcastData(c.data, c.sender)

				if prevCar != nil {
					h.broadcastCarStateLocked(prevCar)
					chaseEvents := h.police.OnPlayerExitedVehicle(c.sender.Username, prevCar.CarID, c.move.X, c.move.Z)
					for _, ce := range chaseEvents {
						h.broadcastChaseEventLocked(ce)
					}
				}

			case *cmdMoveDriving:
				if existing, ok := h.clients[c.sender.Username]; !ok || existing != c.sender {
					continue
				}

				if strings.HasPrefix(c.move.CarID, "police_car") {
					errMsg, _ := msgpack.Marshal(OutboundErrorMsg{
						Type:    TypeError,
						Message: "cannot drive police vehicle",
						Op:      TypeMove,
					})
					select {
					case c.sender.send <- errMsg:
					default:
					}
					continue
				}

				// 1. Validate vehicle ID against allowed world vehicles
				if _, ok := h.allowedCars[c.move.CarID]; !ok {
					continue
				}

				// 1b. Enforce police fine-stop detention, unresolved police dialog lock, and 5-minute vehicle bans
				if h.police.IsUserInFineStop(c.sender.Username) {
					if c.move.CarID == h.police.FineStopCarForUser(c.sender.Username) {
						// Ignore stale in-flight driving frame right after forced exit
						continue
					}
					errMsg, _ := msgpack.Marshal(OutboundErrorMsg{
						Type:    TypeError,
						Message: "нельзя сесть в машину во время общения с полицией",
						Op:      TypeMove,
					})
					select {
					case c.sender.send <- errMsg:
					default:
					}
					continue
				}
				if h.police.ActiveEncounterFor(c.sender.Username) != nil {
					errMsg, _ := msgpack.Marshal(OutboundErrorMsg{
						Type:    TypeError,
						Message: "нельзя сесть в машину во время общения с полицией",
						Op:      TypeMove,
					})
					select {
					case c.sender.send <- errMsg:
					default:
					}
					continue
				}
				if h.police.IsCarInFineStop(c.move.CarID) {
					errMsg, _ := msgpack.Marshal(OutboundErrorMsg{
						Type:    TypeError,
						Message: "машина на проверке у ДПС",
						Op:      TypeMove,
					})
					select {
					case c.sender.send <- errMsg:
					default:
					}
					continue
				}
				if remSec := h.police.VehicleBanRemainingSec(c.move.CarID); remSec > 0 {
					errMsg, _ := msgpack.Marshal(OutboundErrorMsg{
						Type:    TypeError,
						Message: fmt.Sprintf("%s (%s)", VehicleBanReasonText, formatDurationMMSS(remSec)),
						Op:      TypeMove,
					})
					select {
					case c.sender.send <- errMsg:
					default:
					}
					if trackedCar, ok := h.cars[c.move.CarID]; ok && trackedCar != nil {
						if carMsg, err := msgpack.Marshal(OutboundDrivingMoveMsg{
							Username:     trackedCar.Driver,
							Type:         TypeMove,
							Mode:         ModeDriving,
							CarID:        trackedCar.CarID,
							X:            trackedCar.X,
							Y:            trackedCar.Y,
							Z:            trackedCar.Z,
							Speed:        trackedCar.Speed,
							VX:           trackedCar.VX,
							VZ:           trackedCar.VZ,
							YawRate:      trackedCar.YawRate,
							Sequence:     trackedCar.Sequence,
							SampleTimeMS: trackedCar.SampleTimeMS,
							Yaw:          trackedCar.Yaw,
							Drift:        trackedCar.Drift,
							Lights:       trackedCar.Lights,
						}); err == nil {
							select {
							case c.sender.send <- carMsg:
							default:
							}
						}
					}
					continue
				}

				// 2. Reject conflicting drivers before replacing vehicle state
				if currentCar, exists := h.cars[c.move.CarID]; exists {
					if currentCar.Driver != "" && currentCar.Driver != c.sender.Username {
						if _, driverActive := h.clients[currentCar.Driver]; driverActive {
							if uState, uExists := h.users[currentCar.Driver]; uExists && uState.Mode == ModeDriving && uState.CarID == c.move.CarID {
								// Car is currently occupied by another active player!
								// Send direct authoritative vehicle update to the losing client so they exit/reconcile immediately
								rejectMsg, err := msgpack.Marshal(OutboundDrivingMoveMsg{
									Username:     currentCar.Driver,
									Type:         TypeMove,
									Mode:         ModeDriving,
									CarID:        currentCar.CarID,
									X:            currentCar.X,
									Y:            currentCar.Y,
									Z:            currentCar.Z,
									Speed:        currentCar.Speed,
									VX:           currentCar.VX,
									VZ:           currentCar.VZ,
									YawRate:      currentCar.YawRate,
									Sequence:     currentCar.Sequence,
									SampleTimeMS: currentCar.SampleTimeMS,
									Yaw:          currentCar.Yaw,
									Drift:        currentCar.Drift,
									Lights:       currentCar.Lights,
								})
								if err == nil {
									select {
									case c.sender.send <- rejectMsg:
									default:
									}
								}
								continue
							}
						}
					}
				}

				// If user was driving a different car earlier, release the previous one
				var prevCar *CarState
				if prev, ok := h.users[c.sender.Username]; ok && prev.Mode == ModeDriving && prev.CarID != "" && prev.CarID != c.move.CarID {
					if pCar, carExists := h.cars[prev.CarID]; carExists && pCar.Driver == c.sender.Username {
						pCar.Driver = ""
						pCar.Speed = 0
						pCar.VX, pCar.VZ, pCar.YawRate = 0, 0, 0
						pCar.Drift = false
						prevCar = pCar
					}
				}

				h.sequence++
				c.move.Sequence = h.sequence
				c.move.SampleTimeMS = math.Max(0, float64(h.now().Sub(h.started))/float64(time.Millisecond))
				c.data, _ = msgpack.Marshal(c.move)
				h.cars[c.move.CarID] = &CarState{
					CarID:        c.move.CarID,
					X:            c.move.X,
					Y:            c.move.Y,
					Z:            c.move.Z,
					Speed:        c.move.Speed,
					VX:           c.move.VX,
					VZ:           c.move.VZ,
					YawRate:      c.move.YawRate,
					Sequence:     c.move.Sequence,
					SampleTimeMS: c.move.SampleTimeMS,
					Yaw:          c.move.Yaw,
					Drift:        c.move.Drift,
					Lights:       c.move.Lights,
					Driver:       c.sender.Username,
				}

				h.users[c.sender.Username] = &UserState{
					Username:     c.sender.Username,
					Mode:         ModeDriving,
					CarID:        c.move.CarID,
					X:            c.move.X,
					Y:            c.move.Y,
					Z:            c.move.Z,
					Speed:        c.move.Speed,
					VX:           c.move.VX,
					VZ:           c.move.VZ,
					YawRate:      c.move.YawRate,
					Sequence:     c.move.Sequence,
					SampleTimeMS: c.move.SampleTimeMS,
					Yaw:          c.move.Yaw,
					Drift:        c.move.Drift,
					Lights:       c.move.Lights,
				}

				h.broadcastData(c.data, c.sender)
				h.police.OnPlayerEnteredVehicle(c.sender.Username, c.move.CarID)

				if prevCar != nil {
					h.broadcastCarStateLocked(prevCar)
				}

			case *cmdSnapshot:
				carsCopy := make(map[string]CarState, len(h.cars))
				for k, v := range h.cars {
					carsCopy[k] = *v
				}
				usersCopy := make(map[string]UserState, len(h.users))
				for k, v := range h.users {
					usersCopy[k] = *v
				}
				accountsCopy := make(map[string]int64, len(h.accounts))
				for k, v := range h.accounts {
					accountsCopy[k] = v.Money
				}
				c.result <- HubSnapshot{
					Cars:     carsCopy,
					Users:    usersCopy,
					Accounts: accountsCopy,
					Police:   h.police.Snapshot(),
				}

			case *cmdStepSimulation:
				h.stepSimulationLocked(c.dt)
				close(c.result)

			case *cmdSetSimAutoTick:
				h.simAutoTick = c.enabled
				close(c.result)

			case *cmdPoliceDialogueChoice:
				existing, ok := h.clients[c.sender.Username]
				if !ok || existing != c.sender {
					continue
				}
				res, err := h.police.HandleDialogueChoice(c.sender.Username, c.choice.EncounterID, c.choice.OptionIndex)
				if err != nil {
					errMsg, _ := msgpack.Marshal(OutboundErrorMsg{
						Type:    TypeError,
						Message: err.Error(),
						Op:      TypePoliceDialogueChoice,
					})
					select {
					case c.sender.send <- errMsg:
					default:
					}
					continue
				}
				var newMoney int64
				if res.Fine != 0 {
					balReason := "police_fine"
					sourceID := res.CopID
					if res.EncounterKind == EncounterKindTraffic {
						balReason = "speeding_fine"
						if res.PoliceCarID != "" {
							sourceID = res.PoliceCarID
						}
					}
					newMoney = h.applyBalanceDeltaLocked(c.sender.Username, -res.Fine, balReason, sourceID)
				} else {
					newMoney = h.ensureAccountLocked(c.sender.Username).Money
				}
				if resBytes, err := msgpack.Marshal(OutboundPoliceEncounterResultMsg{
					Type:           TypePoliceEncounterResult,
					EncounterID:    res.EncounterID,
					CopID:          res.CopID,
					CopName:        res.CopName,
					ScenarioID:     res.ScenarioID,
					TargetUser:     res.TargetUser,
					OptionIndex:    res.OptionIndex,
					ReplyText:      res.ReplyText,
					Fine:           res.Fine,
					Money:          newMoney,
					CarID:          res.CarID,
					VehicleBlocked: res.VehicleBlocked,
					VehicleBanSec:  res.VehicleBanSec,
				}); err == nil {
					h.broadcastData(resBytes, nil)
				}
				if len(h.clients) > 0 {
					h.policeSeq++
					if stateData, err := msgpack.Marshal(h.police.StateMsg(h.policeSeq)); err == nil {
						h.broadcastData(stateData, nil)
					}
				}

			case *cmdBroadcast:
				if c.sender != nil {
					// Verify sender is still registered
					if existing, ok := h.clients[c.sender.Username]; !ok || existing != c.sender {
						continue
					}
				}
				var exclude *Client
				if c.excludeSender {
					exclude = c.sender
				}
				h.broadcastData(c.data, exclude)

			case *cmdSetSessionTTL:
				h.sessionTTL = c.ttl
				close(c.result)

			case *cmdTriggerNoon:
				now := h.now()
				dateStr, _ := vladivostokDateAndNoon(now)
				h.noonFiredDate = dateStr
				noonMsg, _ := msgpack.Marshal(OutboundCannonShotMsg{
					Type:   TypeCannonShot,
					User:   "",
					Reason: "noon",
				})
				h.broadcastData(noonMsg, nil)
				close(c.result)

			case *cmdTickNoon:
				now := h.now()
				fired := h.evaluateNoonTransition(now)
				if fired {
					noonMsg, _ := msgpack.Marshal(OutboundCannonShotMsg{
						Type:   TypeCannonShot,
						User:   "",
						Reason: "noon",
					})
					h.broadcastData(noonMsg, nil)
				}
				c.result <- fired

			case *cmdSetNowFunc:
				h.nowFunc = c.fn
				noonTimer.Stop()
				noonTimer.Reset(nextVladivostokNoonDelay(h.now()))
				close(c.result)

			case *cmdCannonFire:
				existing, ok := h.clients[c.sender.Username]
				if !ok || existing != c.sender {
					continue
				}

				uState, uExists := h.users[c.sender.Username]
				if !uExists {
					errMsg, _ := msgpack.Marshal(OutboundErrorMsg{
						Type:    TypeError,
						Message: "player position not established",
						Op:      TypeCannonFire,
					})
					select {
					case c.sender.send <- errMsg:
					default:
					}
					continue
				}

				if uState.Mode != ModePedestrian {
					errMsg, _ := msgpack.Marshal(OutboundErrorMsg{
						Type:    TypeError,
						Message: "cannot fire cannon while driving",
						Op:      TypeCannonFire,
					})
					select {
					case c.sender.send <- errMsg:
					default:
					}
					continue
				}

				dx := uState.X - h.fortress.x
				dz := uState.Z - h.fortress.z
				maxDist := h.fortress.radius + 1.5 // 7.5m with tolerance
				if (dx*dx + dz*dz) > (maxDist * maxDist) {
					errMsg, _ := msgpack.Marshal(OutboundErrorMsg{
						Type:    TypeError,
						Message: "too far from fortress cannon",
						Op:      TypeCannonFire,
					})
					select {
					case c.sender.send <- errMsg:
					default:
					}
					continue
				}

				now := h.now()
				if last, ok := h.lastCannonFire[c.sender.Username]; ok {
					if now.Sub(last) < h.cannonCooldown {
						errMsg, _ := msgpack.Marshal(OutboundErrorMsg{
							Type:    TypeError,
							Message: "cannon is cooling down",
							Op:      TypeCannonFire,
						})
						select {
						case c.sender.send <- errMsg:
						default:
						}
						continue
					}
				}

				h.lastCannonFire[c.sender.Username] = now
				shotMsg, _ := msgpack.Marshal(OutboundCannonShotMsg{
					Type:   TypeCannonShot,
					User:   c.sender.Username,
					Reason: "fortress",
				})
				h.broadcastData(shotMsg, nil)

			case *cmdSendDirect:
				if existing, ok := h.clients[c.client.Username]; ok && existing == c.client {
					select {
					case c.client.send <- c.data:
					default:
						// Buffer full, drop message or let slow consumer path handle
					}
				}
			}
		}
	}
}

func (h *Hub) ensureAccountLocked(username string) *AccountState {
	if acct, ok := h.accounts[username]; ok {
		return acct
	}
	acct := &AccountState{Money: DefaultInitialMoney}
	h.accounts[username] = acct
	return acct
}

func (h *Hub) applyBalanceDeltaLocked(username string, delta int64, reason, sourceID string) int64 {
	acct := h.ensureAccountLocked(username)
	acct.Money += delta
	if msgBytes, err := msgpack.Marshal(OutboundBalanceUpdateMsg{
		Type:     TypeBalanceUpdate,
		Username: username,
		Money:    acct.Money,
		Delta:    delta,
		Reason:   reason,
		SourceID: sourceID,
	}); err == nil {
		h.broadcastData(msgBytes, nil)
	}
	return acct.Money
}

func (h *Hub) buildChaseMsgLocked(ce PoliceChaseEvent) OutboundPoliceChaseMsg {
	var money int64
	if ce.TargetUser != "" {
		if ce.Fine != 0 {
			money = h.applyBalanceDeltaLocked(ce.TargetUser, -ce.Fine, "speeding_fine", ce.PoliceCarID)
		} else if acct, ok := h.accounts[ce.TargetUser]; ok {
			money = acct.Money
		} else {
			money = DefaultInitialMoney
		}
	}
	return OutboundPoliceChaseMsg{
		Type:        TypePoliceChase,
		PoliceCarID: ce.PoliceCarID,
		TargetCarID: ce.TargetCarID,
		TargetUser:  ce.TargetUser,
		Status:      ce.Status,
		Reason:      ce.Reason,
		Fine:        ce.Fine,
		Money:       money,
	}
}

func (h *Hub) broadcastChaseEventLocked(ce PoliceChaseEvent) {
	msg := h.buildChaseMsgLocked(ce)
	if data, err := msgpack.Marshal(msg); err == nil {
		h.broadcastData(data, nil)
	}
}

func formatDurationMMSS(sec float64) string {
	total := int(math.Ceil(math.Max(0, sec)))
	return fmt.Sprintf("%d:%02d", total/60, total%60)
}

func (h *Hub) stepSimulationLocked(dt float64) {
	if dt <= 0 || !IsFinite(dt) {
		return
	}
	res := h.police.Step(dt, h.users, h.cars)

	for _, cid := range res.ForcedExitCars {
		if car := h.cars[cid]; car != nil {
			h.broadcastCarStateLocked(car)
		}
	}

	for _, uname := range res.ForcedExitUsers {
		if u := h.users[uname]; u != nil {
			if userMsg, err := msgpack.Marshal(OutboundPedestrianMoveMsg{
				Username: u.Username,
				Type:     TypeMove,
				Mode:     ModePedestrian,
				X:        u.X,
				Y:        u.Y,
				Z:        u.Z,
				VX:       u.VX,
				VZ:       u.VZ,
				Yaw:      u.Yaw,
				Anim:     u.Anim,
			}); err == nil {
				h.broadcastData(userMsg, h.clients[uname])
			}
		}
	}

	for _, ce := range res.ChaseEvents {
		h.broadcastChaseEventLocked(ce)
	}

	for _, fs := range res.FineStopEvents {
		if data, err := msgpack.Marshal(fs); err == nil {
			h.broadcastData(data, nil)
		}
	}

	for _, ev := range res.EncounterStarts {
		if targetClient, ok := h.clients[ev.Msg.TargetUser]; ok {
			if data, err := msgpack.Marshal(ev.Msg); err == nil {
				select {
				case targetClient.send <- data:
				default:
				}
			}
		}
	}

	for _, ie := range res.ImpulseEvents {
		h.sequence++
		if data, err := msgpack.Marshal(OutboundVehicleImpulseMsg{
			Type:        TypeVehicleImpulse,
			PoliceCarID: ie.PoliceCarID,
			CarID:       ie.CarID,
			TargetUser:  ie.TargetUser,
			DVX:         ie.DVX,
			DVZ:         ie.DVZ,
			DYawRate:    ie.DYawRate,
			PoliceMass:  ie.PoliceMass,
			PlayerMass:  ie.PlayerMass,
			Sequence:    h.sequence,
		}); err == nil {
			h.broadcastData(data, nil)
		}
	}

	if len(h.clients) > 0 {
		h.policeSeq++
		if stateData, err := msgpack.Marshal(h.police.StateMsg(h.policeSeq)); err == nil {
			h.broadcastData(stateData, nil)
		}
	}
}

// cleanupUserStateLocked releases any car occupied by username, cleans up police interactions,
// and deletes user state. Returns the released CarState (if any) and any ended chase messages.
// Must be called from the actor loop.
func (h *Hub) cleanupUserStateLocked(username string) (*CarState, []OutboundPoliceChaseMsg) {
	var releasedCar *CarState
	if prev, ok := h.users[username]; ok {
		if prev.Mode == ModeDriving && prev.CarID != "" {
			if car, carExists := h.cars[prev.CarID]; carExists && car.Driver == username {
				car.Driver = ""
				car.Speed = 0
				car.VX, car.VZ, car.YawRate = 0, 0, 0
				car.Drift = false
				releasedCar = car
			}
		}
		delete(h.users, username)
	}
	chaseEvents := h.police.OnPlayerDisconnected(username)
	var chaseMsgs []OutboundPoliceChaseMsg
	if len(chaseEvents) > 0 {
		var money int64 = DefaultInitialMoney
		if acct, ok := h.accounts[username]; ok {
			money = acct.Money
		}
		for _, ce := range chaseEvents {
			chaseMsgs = append(chaseMsgs, OutboundPoliceChaseMsg{
				Type:        TypePoliceChase,
				PoliceCarID: ce.PoliceCarID,
				TargetCarID: ce.TargetCarID,
				TargetUser:  ce.TargetUser,
				Status:      ce.Status,
				Reason:      ce.Reason,
				Fine:        0,
				Money:       money,
			})
		}
	}
	return releasedCar, chaseMsgs
}

// broadcastCarStateLocked publishes authoritative car state (e.g. parked) to all clients.
func (h *Hub) broadcastCarStateLocked(car *CarState) {
	carMsg, err := msgpack.Marshal(OutboundDrivingMoveMsg{
		Username:     car.Driver, // "" when parked
		Type:         TypeMove,
		Mode:         ModeDriving,
		CarID:        car.CarID,
		X:            car.X,
		Y:            car.Y,
		Z:            car.Z,
		Speed:        car.Speed,
		VX:           car.VX,
		VZ:           car.VZ,
		YawRate:      car.YawRate,
		Sequence:     car.Sequence,
		SampleTimeMS: car.SampleTimeMS,
		Yaw:          car.Yaw,
		Drift:        car.Drift,
		Lights:       car.Lights,
	})
	if err == nil {
		h.broadcastData(carMsg, nil)
	}
}

// removeClientLocked cleans up user state, deletes the client, closes channels, and broadcasts leave.
// Must be called from the actor loop.
func (h *Hub) removeClientLocked(client *Client, reason string) {
	existing, ok := h.clients[client.Username]
	if !ok || existing != client {
		return
	}

	if sess, has := h.sessions[client.Username]; has {
		sess.lastSeen = h.now()
	}

	releasedCar, chaseEvents := h.cleanupUserStateLocked(client.Username)
	delete(h.clients, client.Username)
	close(client.send)
	client.CloseSocket()

	leaveMsg, _ := msgpack.Marshal(OutboundLeaveMsg{
		Type:   TypeLeave,
		User:   client.Username,
		Reason: reason,
	})
	h.broadcastData(leaveMsg, nil)

	if releasedCar != nil {
		h.broadcastCarStateLocked(releasedCar)
	}
	for _, ce := range chaseEvents {
		if data, err := msgpack.Marshal(ce); err == nil {
			h.broadcastData(data, nil)
		}
	}
}

// broadcastData sends data to all matching clients, evicting slow consumers iteratively.
func (h *Hub) broadcastData(data []byte, exclude *Client) {
	var slowClients []*Client

	for _, client := range h.clients {
		if exclude != nil && client == exclude {
			continue
		}
		select {
		case client.send <- data:
		default:
			slowClients = append(slowClients, client)
		}
	}

	// Iteratively evict slow consumers to prevent blocking the hub
	for len(slowClients) > 0 {
		var nextSlow []*Client
		for _, sc := range slowClients {
			if existing, ok := h.clients[sc.Username]; ok && existing == sc {
				if sess, has := h.sessions[sc.Username]; has {
					sess.lastSeen = h.now()
				}
				releasedCar, chaseEvents := h.cleanupUserStateLocked(sc.Username)
				delete(h.clients, sc.Username)
				close(sc.send)
				sc.CloseSocket()

				leaveMsg, _ := msgpack.Marshal(OutboundLeaveMsg{
					Type:   TypeLeave,
					User:   sc.Username,
					Reason: "slow consumer",
				})

				var parkedCarMsg []byte
				if releasedCar != nil {
					parkedCarMsg, _ = msgpack.Marshal(OutboundDrivingMoveMsg{
						Username:     releasedCar.Driver, // ""
						Type:         TypeMove,
						Mode:         ModeDriving,
						CarID:        releasedCar.CarID,
						X:            releasedCar.X,
						Y:            releasedCar.Y,
						Z:            releasedCar.Z,
						Speed:        releasedCar.Speed,
						VX:           releasedCar.VX,
						VZ:           releasedCar.VZ,
						YawRate:      releasedCar.YawRate,
						Sequence:     releasedCar.Sequence,
						SampleTimeMS: releasedCar.SampleTimeMS,
						Yaw:          releasedCar.Yaw,
						Drift:        releasedCar.Drift,
						Lights:       releasedCar.Lights,
					})
				}

				var chasePayloads [][]byte
				for _, ce := range chaseEvents {
					if b, err := msgpack.Marshal(ce); err == nil {
						chasePayloads = append(chasePayloads, b)
					}
				}

				for _, remaining := range h.clients {
					select {
					case remaining.send <- leaveMsg:
					default:
						nextSlow = append(nextSlow, remaining)
						continue
					}
					if len(parkedCarMsg) > 0 {
						select {
						case remaining.send <- parkedCarMsg:
						default:
							nextSlow = append(nextSlow, remaining)
							continue
						}
					}
					for _, cp := range chasePayloads {
						stalled := false
						select {
						case remaining.send <- cp:
						default:
							nextSlow = append(nextSlow, remaining)
							stalled = true
						}
						if stalled {
							break
						}
					}
				}
			}
		}
		slowClients = nextSlow
	}
}
