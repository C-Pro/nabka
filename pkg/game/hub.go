package game

import (
	"context"
	"sync"

	"github.com/vmihailenco/msgpack/v5"
)

type hubCmd any

type cmdRegister struct {
	client *Client
	result chan bool
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

// HubSnapshot contains an immutable copy of cars and users states.
type HubSnapshot struct {
	Cars  map[string]CarState
	Users map[string]UserState
}

// Hub maintains the set of active clients, tracks world state (cars and users), and broadcasts messages via an actor loop.
type Hub struct {
	clients     map[string]*Client
	cars        map[string]*CarState
	users       map[string]*UserState
	allowedCars map[string]struct{}
	cmdCh       chan hubCmd

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// NewHub creates and starts a new Hub instance.
func NewHub(parentCtx context.Context, allowedCars ...string) *Hub {
	ctx, cancel := context.WithCancel(parentCtx)
	allowedMap := make(map[string]struct{})
	if len(allowedCars) > 0 {
		for _, c := range allowedCars {
			allowedMap[c] = struct{}{}
		}
	} else {
		// Default to world vehicles defined in world_map.json
		allowedMap["car_0"] = struct{}{}
		allowedMap["car_1"] = struct{}{}
		allowedMap["car_2"] = struct{}{}
		allowedMap["car_3"] = struct{}{}
		allowedMap["car_4"] = struct{}{}
	}

	h := &Hub{
		clients:     make(map[string]*Client),
		cars:        make(map[string]*CarState),
		users:       make(map[string]*UserState),
		allowedCars: allowedMap,
		cmdCh:       make(chan hubCmd, 2048),
		ctx:         ctx,
		cancel:      cancel,
	}
	h.wg.Add(1)
	go h.run()
	return h
}

// Register attempts to add a client to the hub and broadcasts join if successful.
func (h *Hub) Register(client *Client) bool {
	resCh := make(chan bool, 1)
	req := &cmdRegister{
		client: client,
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

// Snapshot returns an immutable copy of all tracked cars and active users.
func (h *Hub) Snapshot() HubSnapshot {
	select {
	case <-h.ctx.Done():
		return HubSnapshot{
			Cars:  make(map[string]CarState),
			Users: make(map[string]UserState),
		}
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
			return HubSnapshot{
				Cars:  make(map[string]CarState),
				Users: make(map[string]UserState),
			}
		}
	case <-h.ctx.Done():
		return HubSnapshot{
			Cars:  make(map[string]CarState),
			Users: make(map[string]UserState),
		}
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

// Stop terminates the hub event loop and cleans up.
func (h *Hub) Stop() {
	h.cancel()
	h.wg.Wait()
}

// run is the single-threaded actor loop owning the clients map.
func (h *Hub) run() {
	defer h.wg.Done()

	for {
		select {
		case <-h.ctx.Done():
			for _, client := range h.clients {
				close(client.send)
				client.CloseSocket()
			}
			h.clients = make(map[string]*Client)
			return

		case cmd := <-h.cmdCh:
			switch c := cmd.(type) {
			case *cmdRegister:
				if _, exists := h.clients[c.client.Username]; exists {
					c.result <- false
					continue
				}

				h.clients[c.client.Username] = c.client
				c.result <- true

				// Broadcast join to all connected clients including the newcomer
				joinMsg, _ := msgpack.Marshal(OutboundJoinMsg{
					Type: TypeJoin,
					User: c.client.Username,
				})
				h.broadcastData(joinMsg, nil)

				// Verify newcomer survived join broadcast (in case it was evicted as a slow consumer)
				if existing, ok := h.clients[c.client.Username]; !ok || existing != c.client {
					continue
				}

				baselineFailed := false

				// Send all currently tracked car positions to the newly joined client
				for _, car := range h.cars {
					carMsg, err := msgpack.Marshal(OutboundDrivingMoveMsg{
						Username: car.Driver, // "" if parked, or driver username
						Type:     TypeMove,
						Mode:     ModeDriving,
						CarID:    car.CarID,
						X:        car.X,
						Y:        car.Y,
						Z:        car.Z,
						Speed:    car.Speed,
						Yaw:      car.Yaw,
						Drift:    car.Drift,
						Lights:   car.Lights,
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
							Username: userState.Username,
							Type:     TypeMove,
							Mode:     ModeDriving,
							CarID:    userState.CarID,
							X:        userState.X,
							Y:        userState.Y,
							Z:        userState.Z,
							Speed:    userState.Speed,
							Yaw:      userState.Yaw,
							Drift:    userState.Drift,
							Lights:   userState.Lights,
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

			case *cmdUnregister:
				existing, exists := h.clients[c.client.Username]
				if !exists || existing != c.client {
					// Idempotent: already removed or replaced by a new connection
					continue
				}

				releasedCar := h.cleanupUserStateLocked(c.client.Username)

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

			case *cmdMovePedestrian:
				if existing, ok := h.clients[c.sender.Username]; !ok || existing != c.sender {
					continue
				}

				// If user was previously driving a car, release that car as parked
				var prevCar *CarState
				if prev, ok := h.users[c.sender.Username]; ok && prev.Mode == ModeDriving && prev.CarID != "" {
					if car, carExists := h.cars[prev.CarID]; carExists && car.Driver == c.sender.Username {
						car.Driver = ""
						car.Speed = 0
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
				}

			case *cmdMoveDriving:
				if existing, ok := h.clients[c.sender.Username]; !ok || existing != c.sender {
					continue
				}

				// 1. Validate vehicle ID against allowed world vehicles
				if _, ok := h.allowedCars[c.move.CarID]; !ok {
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
									Username: currentCar.Driver,
									Type:     TypeMove,
									Mode:     ModeDriving,
									CarID:    currentCar.CarID,
									X:        currentCar.X,
									Y:        currentCar.Y,
									Z:        currentCar.Z,
									Speed:    currentCar.Speed,
									Yaw:      currentCar.Yaw,
									Drift:    currentCar.Drift,
									Lights:   currentCar.Lights,
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
						pCar.Drift = false
						prevCar = pCar
					}
				}

				h.cars[c.move.CarID] = &CarState{
					CarID:  c.move.CarID,
					X:      c.move.X,
					Y:      c.move.Y,
					Z:      c.move.Z,
					Speed:  c.move.Speed,
					Yaw:    c.move.Yaw,
					Drift:  c.move.Drift,
					Lights: c.move.Lights,
					Driver: c.sender.Username,
				}

				h.users[c.sender.Username] = &UserState{
					Username: c.sender.Username,
					Mode:     ModeDriving,
					CarID:    c.move.CarID,
					X:        c.move.X,
					Y:        c.move.Y,
					Z:        c.move.Z,
					Speed:    c.move.Speed,
					Yaw:      c.move.Yaw,
					Drift:    c.move.Drift,
					Lights:   c.move.Lights,
				}

				h.broadcastData(c.data, c.sender)

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
				c.result <- HubSnapshot{
					Cars:  carsCopy,
					Users: usersCopy,
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

// cleanupUserStateLocked releases any car occupied by username and deletes user state.
// Returns the released CarState (if any) so caller can broadcast its parked state.
// Must be called from the actor loop.
func (h *Hub) cleanupUserStateLocked(username string) *CarState {
	var releasedCar *CarState
	if prev, ok := h.users[username]; ok {
		if prev.Mode == ModeDriving && prev.CarID != "" {
			if car, carExists := h.cars[prev.CarID]; carExists && car.Driver == username {
				car.Driver = ""
				car.Speed = 0
				car.Drift = false
				releasedCar = car
			}
		}
		delete(h.users, username)
	}
	return releasedCar
}

// broadcastCarStateLocked publishes authoritative car state (e.g. parked) to all clients.
func (h *Hub) broadcastCarStateLocked(car *CarState) {
	carMsg, err := msgpack.Marshal(OutboundDrivingMoveMsg{
		Username: car.Driver, // "" when parked
		Type:     TypeMove,
		Mode:     ModeDriving,
		CarID:    car.CarID,
		X:        car.X,
		Y:        car.Y,
		Z:        car.Z,
		Speed:    car.Speed,
		Yaw:      car.Yaw,
		Drift:    car.Drift,
		Lights:   car.Lights,
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

	releasedCar := h.cleanupUserStateLocked(client.Username)
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
				releasedCar := h.cleanupUserStateLocked(sc.Username)
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
						Username: releasedCar.Driver, // ""
						Type:     TypeMove,
						Mode:     ModeDriving,
						CarID:    releasedCar.CarID,
						X:        releasedCar.X,
						Y:        releasedCar.Y,
						Z:        releasedCar.Z,
						Speed:    releasedCar.Speed,
						Yaw:      releasedCar.Yaw,
						Drift:    releasedCar.Drift,
						Lights:   releasedCar.Lights,
					})
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
						}
					}
				}
			}
		}
		slowClients = nextSlow
	}
}
