package game

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/fasthttp/websocket"
	"github.com/valyala/fasthttp"
)

// ServerConfig configures the game WebSocket server.
type ServerConfig struct {
	Addr                string
	InactivityTimeout   time.Duration
	WriteTimeout        time.Duration
	SendBufferSize      int
	RegistrationTimeout time.Duration
	AllowAllOrigins     bool
}

// Server manages the fasthttp HTTP listener, WebSocket upgrader, and Hub.
type Server struct {
	config   ServerConfig
	hub      *Hub
	upgrader websocket.FastHTTPUpgrader
	fastSrv  *fasthttp.Server

	ctx            context.Context
	cancel         context.CancelFunc
	wg             sync.WaitGroup
	connWg         sync.WaitGroup
	connMu         sync.Mutex
	isShuttingDown bool

	ln net.Listener
	mu sync.Mutex
}

// NewServer initializes a new Server.
func NewServer(cfg ServerConfig) *Server {
	if cfg.InactivityTimeout <= 0 {
		cfg.InactivityTimeout = 30 * time.Second
	}
	if cfg.WriteTimeout <= 0 {
		cfg.WriteTimeout = 5 * time.Second
	}
	if cfg.SendBufferSize <= 0 {
		cfg.SendBufferSize = 512
	}
	if cfg.RegistrationTimeout <= 0 {
		cfg.RegistrationTimeout = 5 * time.Second
	}

	ctx, cancel := context.WithCancel(context.Background())
	hub := NewHub(ctx)

	s := &Server{
		config: cfg,
		hub:    hub,
		ctx:    ctx,
		cancel: cancel,
	}

	s.upgrader = websocket.FastHTTPUpgrader{
		CheckOrigin: func(ctx *fasthttp.RequestCtx) bool {
			if cfg.AllowAllOrigins {
				return true
			}
			return true
		},
		ReadBufferSize:  64 * 1024,
		WriteBufferSize: 64 * 1024,
	}

	s.fastSrv = &fasthttp.Server{
		Handler:           s.HandleRequest,
		KeepHijackedConns: true, // Required so conn.Close() terminates hijacked transport
	}

	return s
}

// Hub returns the underlying Hub.
func (s *Server) Hub() *Hub {
	return s.hub
}

// HandleRequest routes incoming HTTP requests to WebSocket upgrading.
func (s *Server) HandleRequest(ctx *fasthttp.RequestCtx) {
	path := string(ctx.Path())
	if path != "/ws" {
		ctx.SetStatusCode(fasthttp.StatusNotFound)
		ctx.SetBodyString("Not Found")
		return
	}

	queryUser := string(ctx.QueryArgs().Peek("username"))
	if queryUser != "" {
		validName, err := ValidateUsername(queryUser)
		if err != nil {
			ctx.SetStatusCode(fasthttp.StatusBadRequest)
			ctx.SetBodyString(fmt.Sprintf("invalid username: %v", err))
			return
		}

		err = s.upgrader.Upgrade(ctx, func(conn *websocket.Conn) {
			s.connMu.Lock()
			if s.isShuttingDown {
				s.connMu.Unlock()
				_ = conn.Close()
				return
			}
			s.connWg.Add(1)
			s.connMu.Unlock()
			defer s.connWg.Done()

			s.handleRegisteredConnection(conn, validName)
		})
		if err != nil {
			ctx.SetStatusCode(fasthttp.StatusBadRequest)
		}
		return
	}

	// Username not in query param: upgrade and await initial registration payload
	err := s.upgrader.Upgrade(ctx, func(conn *websocket.Conn) {
		s.connMu.Lock()
		if s.isShuttingDown {
			s.connMu.Unlock()
			_ = conn.Close()
			return
		}
		s.connWg.Add(1)
		s.connMu.Unlock()
		defer s.connWg.Done()

		s.handleUnregisteredConnection(conn)
	})
	if err != nil {
		ctx.SetStatusCode(fasthttp.StatusBadRequest)
	}
}

// handleRegisteredConnection runs for clients with validated username.
func (s *Server) handleRegisteredConnection(conn *websocket.Conn, username string) {
	client := NewClient(username, conn, s.hub, ClientConfig{
		InactivityTimeout: s.config.InactivityTimeout,
		WriteTimeout:      s.config.WriteTimeout,
		SendBufferSize:    s.config.SendBufferSize,
	})

	if !s.hub.Register(client) {
		// Second user with the same username rejected
		_ = conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(4409, "username already taken"),
			time.Now().Add(s.config.WriteTimeout),
		)
		client.CloseSocket()
		return
	}

	var writers sync.WaitGroup
	writers.Add(1)
	go func() {
		defer writers.Done()
		client.WritePump()
	}()

	client.ReadPump()
	writers.Wait()
}

// handleUnregisteredConnection waits for an immediate initial registration msgpack message.
func (s *Server) handleUnregisteredConnection(conn *websocket.Conn) {
	conn.SetReadLimit(maxMessageSize)
	_ = conn.SetReadDeadline(time.Now().Add(s.config.RegistrationTimeout))

	msgType, payload, err := conn.ReadMessage()
	if err != nil {
		_ = conn.Close()
		return
	}

	if msgType != websocket.BinaryMessage {
		_ = conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "expected binary msgpack registration"),
			time.Now().Add(s.config.WriteTimeout),
		)
		_ = conn.Close()
		return
	}

	username, err := ParseRegister(payload)
	if err != nil {
		_ = conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.ClosePolicyViolation, err.Error()),
			time.Now().Add(s.config.WriteTimeout),
		)
		_ = conn.Close()
		return
	}

	s.handleRegisteredConnection(conn, username)
}

// Start begins serving on the configured address.
func (s *Server) Start() error {
	ln, err := net.Listen("tcp", s.config.Addr)
	if err != nil {
		return err
	}

	s.mu.Lock()
	s.ln = ln
	s.mu.Unlock()

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		_ = s.fastSrv.Serve(ln)
	}()

	return nil
}

// ServeListener serves on a pre-created listener (useful for tests).
func (s *Server) ServeListener(ln net.Listener) error {
	s.mu.Lock()
	s.ln = ln
	s.mu.Unlock()

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		_ = s.fastSrv.Serve(ln)
	}()

	return nil
}

// Addr returns the listener address.
func (s *Server) Addr() net.Addr {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ln != nil {
		return s.ln.Addr()
	}
	return nil
}

// Shutdown gracefully shuts down the server, active connections, and hub.
func (s *Server) Shutdown() error {
	s.connMu.Lock()
	s.isShuttingDown = true
	s.connMu.Unlock()

	s.cancel()

	var err error
	if s.fastSrv != nil {
		err = s.fastSrv.Shutdown()
	}

	s.hub.Stop()
	s.connWg.Wait()
	s.wg.Wait()

	s.mu.Lock()
	if s.ln != nil {
		_ = s.ln.Close()
	}
	s.mu.Unlock()

	return err
}

// ErrDuplicateUsername is returned when trying to register an already taken username.
var ErrDuplicateUsername = errors.New("username already taken")
