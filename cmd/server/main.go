package main

import (
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"nabka/pkg/game"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	addr := ":" + port

	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	cfg := game.ServerConfig{
		Addr:                addr,
		InactivityTimeout:   30 * time.Second,
		WriteTimeout:        5 * time.Second,
		SendBufferSize:      512,
		RegistrationTimeout: 5 * time.Second,
		AllowAllOrigins:     true,
	}

	server := game.NewServer(cfg)

	slog.Info("Starting multiplayer WebSocket game server",
		"addr", addr,
		"endpoint", "/ws",
		"inactivity_timeout", cfg.InactivityTimeout,
		"format", "msgpack",
	)

	if err := server.Start(); err != nil {
		slog.Error("Failed to start server", "error", err)
		os.Exit(1)
	}

	// Wait for termination signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	sig := <-sigCh

	slog.Info("Received signal, initiating graceful shutdown...", "signal", sig.String())

	if err := server.Shutdown(); err != nil {
		slog.Error("Error during shutdown", "error", err)
		os.Exit(1)
	}

	slog.Info("Server stopped successfully")
}
