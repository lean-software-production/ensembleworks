// termgw — EnsembleWorks remote terminal connector (spike).
// Dials the canvas sync server and serves tmux-backed terminal sessions
// over the relay. See docs/superpowers/specs/2026-07-03-remote-devcontainer-terminal-spike-design.md
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/lean-software-production/ensembleworks/gateway-go/relay"
	"github.com/lean-software-production/ensembleworks/gateway-go/session"
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	canvasURL := os.Getenv("CANVAS_URL")
	if canvasURL == "" {
		log.Fatal("CANVAS_URL is required (e.g. https://canvas.example.com or http://ash:8788)")
	}
	hostname, _ := os.Hostname()
	gatewayID := envOr("GATEWAY_ID", hostname)
	cfg := relay.Config{
		CanvasURL:            canvasURL,
		GatewayID:            gatewayID,
		Label:                envOr("GATEWAY_LABEL", gatewayID),
		CFAccessClientID:     os.Getenv("CF_ACCESS_CLIENT_ID"),
		CFAccessClientSecret: os.Getenv("CF_ACCESS_CLIENT_SECRET"),
		Manager:              session.NewManager(session.TmuxFactory(envOr("TMUX_CONF", "/usr/local/share/termgw/tmux.conf"))),
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := relay.Run(ctx, cfg); err != nil && ctx.Err() == nil {
		log.Fatal(err)
	}
}
