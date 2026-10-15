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

type cmdSendDirect struct {
	client *Client
	data   []byte
}

// Hub maintains the set of active clients and broadcasts messages via a single ordered command loop.
type Hub struct {
	clients map[string]*Client
	cmdCh   chan hubCmd

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// NewHub creates and starts a new Hub instance.
func NewHub(parentCtx context.Context) *Hub {
	ctx, cancel := context.WithCancel(parentCtx)
	h := &Hub{
		clients: make(map[string]*Client),
		cmdCh:   make(chan hubCmd, 2048),
		ctx:     ctx,
		cancel:  cancel,
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

			case *cmdUnregister:
				existing, exists := h.clients[c.client.Username]
				if !exists || existing != c.client {
					// Idempotent: already removed or replaced by a new connection
					continue
				}

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
				delete(h.clients, sc.Username)
				close(sc.send)
				sc.CloseSocket()

				leaveMsg, _ := msgpack.Marshal(OutboundLeaveMsg{
					Type:   TypeLeave,
					User:   sc.Username,
					Reason: "slow consumer",
				})

				for _, remaining := range h.clients {
					select {
					case remaining.send <- leaveMsg:
					default:
						nextSlow = append(nextSlow, remaining)
					}
				}
			}
		}
		slowClients = nextSlow
	}
}
