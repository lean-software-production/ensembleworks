// Package relay maintains the single outbound WS to the canvas
// (/api/gateway/connect — connecting IS registering) and demuxes relay
// channels onto the session manager. Messages are processed per-channel
// FIFO: the read loop enqueues onto a per-channel goroutine, so
// relay-open → relay-msg{resize} ordering survives concurrency (spec §3).
package relay

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/lean-software-production/ensembleworks/gateway-go/protocol"
	"github.com/lean-software-production/ensembleworks/gateway-go/session"
)

type Config struct {
	CanvasURL            string // http(s)://host — scheme is rewritten to ws(s)
	GatewayID            string
	Label                string
	CFAccessClientID     string
	CFAccessClientSecret string
	Manager              *session.Manager
}

// wsWriter serializes writes to the shared WS (coder/websocket allows one
// concurrent writer).
type wsWriter struct {
	mu   sync.Mutex
	conn *websocket.Conn
	ctx  context.Context
}

func (w *wsWriter) text(b []byte) {
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.conn.Write(w.ctx, websocket.MessageText, b)
}
func (w *wsWriter) binary(b []byte) {
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.conn.Write(w.ctx, websocket.MessageBinary, b)
}

// channelSink implements session.Sink for one relay channel.
type channelSink struct {
	id     uint32
	writer *wsWriter
}

func (s *channelSink) SendMsg(inner protocol.Inner) {
	if b, err := protocol.WrapMsg(s.id, inner); err == nil {
		s.writer.text(b)
	}
}
func (s *channelSink) SendOutput(payload []byte) {
	s.writer.binary(protocol.EncodeBinary(s.id, payload))
}
func (s *channelSink) Close() {
	s.writer.text(protocol.RelayClosed(s.id))
}

// channelWorker gives each channel a FIFO queue + goroutine.
type channelWorker struct {
	queue     chan protocol.Control
	sessionID string
}

func dialURL(cfg Config) (string, error) {
	u, err := url.Parse(cfg.CanvasURL)
	if err != nil {
		return "", err
	}
	u.Scheme = map[string]string{"http": "ws", "https": "wss"}[u.Scheme]
	if u.Scheme == "" {
		return "", fmt.Errorf("CANVAS_URL must be http(s)://…, got %q", cfg.CanvasURL)
	}
	u.Path = strings.TrimSuffix(u.Path, "/") + "/api/gateway/connect"
	q := u.Query()
	q.Set("gatewayId", cfg.GatewayID)
	q.Set("label", cfg.Label)
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// Run dials, serves one connection, and reconnects with jittered exponential
// backoff (1s base, 30s cap) until ctx is done. Sessions (tmux) survive
// disconnects; only viewers are detached.
func Run(ctx context.Context, cfg Config) error {
	target, err := dialURL(cfg)
	if err != nil {
		return err
	}
	attempt := 0
	for {
		if err := serveOnce(ctx, cfg, target); err != nil && ctx.Err() == nil {
			log.Printf("[relay] connection lost: %v", err)
		}
		cfg.Manager.DetachAll()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		attempt++
		backoff := time.Duration(1<<min(attempt-1, 5)) * time.Second // 1..32s → capped below
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
		jitter := time.Duration(float64(backoff) * (0.8 + 0.4*rand.Float64()))
		log.Printf("[relay] reconnecting in %s", jitter.Round(time.Millisecond))
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(jitter):
		}
	}
}

func serveOnce(ctx context.Context, cfg Config, target string) error {
	opts := &websocket.DialOptions{}
	if cfg.CFAccessClientID != "" {
		opts.HTTPHeader = http.Header{
			"CF-Access-Client-Id":     []string{cfg.CFAccessClientID},
			"CF-Access-Client-Secret": []string{cfg.CFAccessClientSecret},
		}
	}
	conn, _, err := websocket.Dial(ctx, target, opts)
	if err != nil {
		return err
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	conn.SetReadLimit(1 << 20)
	log.Printf("[relay] connected to %s as %s", cfg.CanvasURL, cfg.GatewayID)

	writer := &wsWriter{conn: conn, ctx: ctx}
	workers := make(map[uint32]*channelWorker)
	defer func() {
		for _, w := range workers {
			close(w.queue)
		}
	}()

	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		if typ == websocket.MessageBinary {
			continue // canvas→connector is all text
		}
		var ctl protocol.Control
		if json.Unmarshal(data, &ctl) != nil {
			continue
		}
		switch ctl.Type {
		case "relay-open":
			w := &channelWorker{queue: make(chan protocol.Control, 64), sessionID: ctl.SessionID}
			workers[ctl.ChannelID] = w
			go runChannel(cfg.Manager, ctl.ChannelID, w, writer)
			w.queue <- ctl // the open action itself is the first queue item
		case "relay-msg", "relay-close":
			if w, ok := workers[ctl.ChannelID]; ok {
				select {
				case w.queue <- ctl:
				default: // shed rather than block the shared read loop
				}
				if ctl.Type == "relay-close" {
					delete(workers, ctl.ChannelID)
				}
			}
		}
	}
}

func runChannel(mgr *session.Manager, channelID uint32, w *channelWorker, writer *wsWriter) {
	for ctl := range w.queue {
		switch ctl.Type {
		case "relay-open":
			sink := &channelSink{id: channelID, writer: writer}
			if err := mgr.Attach(w.sessionID, channelID, ctl.Cols, ctl.Rows, sink); err != nil {
				log.Printf("[relay] attach %s failed: %v", w.sessionID, err)
				writer.text(protocol.RelayClosed(channelID))
				return
			}
		case "relay-msg":
			var inner protocol.Inner
			if json.Unmarshal(ctl.Msg, &inner) != nil {
				continue
			}
			switch inner.Type {
			case "input":
				mgr.Input(w.sessionID, channelID, inner.Data)
			case "resize":
				mgr.Resize(w.sessionID, inner.Cols, inner.Rows)
			}
		case "relay-close":
			mgr.Detach(w.sessionID, channelID)
			return
		}
	}
	mgr.Detach(w.sessionID, channelID)
}
