package game

import (
	"errors"
	"net"
	"os"
	"sync"
	"time"

	"github.com/fasthttp/websocket"
)

const (
	defaultSendBufferSize    = 512
	defaultInactivityTimeout = 30 * time.Second
	defaultWriteTimeout      = 5 * time.Second
	maxMessageSize           = 64 * 1024 // 64 KB
)

// Client represents an active WebSocket connection with a verified username.
type Client struct {
	Username          string
	conn              *websocket.Conn
	hub               *Hub
	send              chan []byte
	inactivityTimeout time.Duration
	writeTimeout      time.Duration
	closeOnce         sync.Once
	termOnce          sync.Once
	termReason        string
}

// ClientConfig holds configuration for the client connection.
type ClientConfig struct {
	InactivityTimeout time.Duration
	WriteTimeout      time.Duration
	SendBufferSize    int
}

// NewClient initializes a new Client instance.
func NewClient(username string, conn *websocket.Conn, hub *Hub, cfg ClientConfig) *Client {
	inactivity := cfg.InactivityTimeout
	if inactivity <= 0 {
		inactivity = defaultInactivityTimeout
	}
	writeTimeout := cfg.WriteTimeout
	if writeTimeout <= 0 {
		writeTimeout = defaultWriteTimeout
	}
	bufSize := cfg.SendBufferSize
	if bufSize <= 0 {
		bufSize = defaultSendBufferSize
	}

	return &Client{
		Username:          username,
		conn:              conn,
		hub:               hub,
		send:              make(chan []byte, bufSize),
		inactivityTimeout: inactivity,
		writeTimeout:      writeTimeout,
	}
}

// CloseSocket closes the underlying network connection idempotently.
func (c *Client) CloseSocket() {
	c.closeOnce.Do(func() {
		_ = c.conn.Close()
	})
}

// Terminate records the terminal reason atomically and unregisters the client.
func (c *Client) Terminate(reason string) {
	c.termOnce.Do(func() {
		c.termReason = reason
		c.CloseSocket()
		c.hub.Unregister(c, reason)
	})
}

// sendDirect queues a message via Hub to avoid racing with channel closure.
func (c *Client) sendDirect(data []byte) {
	c.hub.SendDirect(c, data)
}

// ReadPump handles incoming WebSocket frames, validates application messages,
// refreshes the inactivity deadline on valid messages, and forwards events to the hub.
func (c *Client) ReadPump() {
	defer func() {
		c.Terminate(ReasonLeft)
	}()

	c.conn.SetReadLimit(maxMessageSize)

	// Set initial read deadline
	_ = c.conn.SetReadDeadline(time.Now().Add(c.inactivityTimeout))

	// Do NOT refresh application read deadline on protocol pings
	c.conn.SetPingHandler(func(appData string) error {
		return c.conn.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(c.writeTimeout))
	})

	for {
		msgType, payload, err := c.conn.ReadMessage()
		if err != nil {
			reason := ReasonLeft
			var netErr net.Error
			if errors.Is(err, os.ErrDeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
				reason = ReasonInactivity
			}
			c.Terminate(reason)
			return
		}

		// Only accept binary messages (MsgPack format)
		if msgType != websocket.BinaryMessage {
			errMsg, _ := MarshalMsgPack(OutboundErrorMsg{
				Type:    TypeError,
				Message: "expected binary msgpack message",
			})
			c.sendDirect(errMsg)
			continue
		}

		// Parse envelope to inspect message type and mode
		env, err := ParseEnvelope(payload)
		if err != nil {
			errMsg, _ := MarshalMsgPack(OutboundErrorMsg{
				Type:    TypeError,
				Message: err.Error(),
			})
			c.sendDirect(errMsg)
			continue
		}

		switch env.Type {
		case TypeMove:
			switch env.Mode {
			case ModePedestrian:
				out, err := ParsePedestrianMove(payload, c.Username)
				if err != nil {
					errMsg, _ := MarshalMsgPack(OutboundErrorMsg{Type: TypeError, Message: err.Error()})
					c.sendDirect(errMsg)
					continue
				}

				// Valid application message: refresh inactivity deadline
				_ = c.conn.SetReadDeadline(time.Now().Add(c.inactivityTimeout))
				data, _ := MarshalMsgPack(out)
				c.hub.BroadcastPedestrianMove(c, out, data) // updates state and excludes sender

			case ModeDriving:
				out, err := ParseDrivingMove(payload, c.Username)
				if err != nil {
					errMsg, _ := MarshalMsgPack(OutboundErrorMsg{Type: TypeError, Message: err.Error()})
					c.sendDirect(errMsg)
					continue
				}

				// Valid application message: refresh inactivity deadline
				_ = c.conn.SetReadDeadline(time.Now().Add(c.inactivityTimeout))
				data, _ := MarshalMsgPack(out)
				c.hub.BroadcastDrivingMove(c, out, data) // updates state and excludes sender

			default:
				errMsg, _ := MarshalMsgPack(OutboundErrorMsg{
					Type:    TypeError,
					Message: "invalid move mode: must be pedestrian or driving",
				})
				c.sendDirect(errMsg)
			}

		case TypeChat:
			out, err := ParseChat(payload, c.Username)
			if err != nil {
				errMsg, _ := MarshalMsgPack(OutboundErrorMsg{Type: TypeError, Message: err.Error()})
				c.sendDirect(errMsg)
				continue
			}

			// Valid application message: refresh inactivity deadline
			_ = c.conn.SetReadDeadline(time.Now().Add(c.inactivityTimeout))
			data, _ := MarshalMsgPack(out)
			c.hub.Broadcast(c, false, data) // include sender for chat display & speech bubbles

		case TypePing:
			_ = c.conn.SetReadDeadline(time.Now().Add(c.inactivityTimeout))
			pongMsg, _ := MarshalMsgPack(map[string]interface{}{"type": TypePong})
			c.sendDirect(pongMsg)

		case TypeRegister:
			errMsg, _ := MarshalMsgPack(OutboundErrorMsg{
				Type:    TypeError,
				Message: "already registered",
			})
			c.sendDirect(errMsg)

		case TypeJoin, TypeLeave:
			errMsg, _ := MarshalMsgPack(OutboundErrorMsg{
				Type:    TypeError,
				Message: "join and leave message types are server reserved",
			})
			c.sendDirect(errMsg)

		default:
			errMsg, _ := MarshalMsgPack(OutboundErrorMsg{
				Type:    TypeError,
				Message: "unknown message type",
			})
			c.sendDirect(errMsg)
		}
	}
}

// WritePump pumps messages from the hub to the WebSocket connection.
func (c *Client) WritePump() {
	defer func() {
		c.Terminate(ReasonLeft)
	}()

	for data := range c.send {
		_ = c.conn.SetWriteDeadline(time.Now().Add(c.writeTimeout))
		err := c.conn.WriteMessage(websocket.BinaryMessage, data)
		if err != nil {
			c.Terminate(ReasonLeft)
			return
		}
	}

	// Send channel was closed by the Hub
	_ = c.conn.SetWriteDeadline(time.Now().Add(c.writeTimeout))
	_ = c.conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
	c.CloseSocket()
}
