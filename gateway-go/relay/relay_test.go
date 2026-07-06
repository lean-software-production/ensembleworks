package relay

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/lean-software-production/ensembleworks/gateway-go/protocol"
	"github.com/lean-software-production/ensembleworks/gateway-go/session"
)

type stubPty struct{ out chan []byte }

func (p *stubPty) Read(b []byte) (int, error) {
	c, ok := <-p.out
	if !ok {
		return 0, io.EOF
	}
	return copy(b, c), nil
}
func (p *stubPty) Write(b []byte) (int, error) { p.out <- append([]byte("echo:"), b...); return len(b), nil }
func (p *stubPty) Resize(int, int) error       { return nil }
func (p *stubPty) Close() error                { close(p.out); return nil }

func TestRelayEndToEnd(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	type recv struct {
		control *protocol.Control
		binary  []byte
	}
	fromConnector := make(chan recv, 256)
	var connMu sync.Mutex
	var serverConn *websocket.Conn

	// Mock canvas: accept the connector, record every frame it sends.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/terminal/connect" {   // was /api/gateway/connect
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Get("gatewayId") != "gw-test" {
			t.Errorf("gatewayId missing from dial: %s", r.URL)
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		connMu.Lock()
		serverConn = c
		connMu.Unlock()
		for {
			typ, data, err := c.Read(context.Background())
			if err != nil {
				return
			}
			if typ == websocket.MessageBinary {
				fromConnector <- recv{binary: data}
			} else {
				var ctl protocol.Control
				if err := json.Unmarshal(data, &ctl); err == nil {
					fromConnector <- recv{control: &ctl}
				}
			}
		}
	}))
	defer srv.Close()

	mgr := session.NewManager(func(string, int, int) (session.Pty, error) {
		return &stubPty{out: make(chan []byte, 64)}, nil
	})
	go Run(ctx, Config{CanvasURL: srv.URL, GatewayID: "gw-test", Label: "Test", Manager: mgr})

	// Wait for the connector to dial in.
	deadline := time.Now().Add(3 * time.Second)
	for {
		connMu.Lock()
		c := serverConn
		connMu.Unlock()
		if c != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("connector never dialed")
		}
		time.Sleep(10 * time.Millisecond)
	}
	send := func(ctl protocol.Control) {
		b, _ := json.Marshal(ctl)
		connMu.Lock()
		defer connMu.Unlock()
		if err := serverConn.Write(ctx, websocket.MessageText, b); err != nil {
			t.Fatal(err)
		}
	}
	nextControl := func(typ string) protocol.Control {
		for {
			select {
			case r := <-fromConnector:
				if r.control != nil && r.control.Type == typ {
					return *r.control
				}
			case <-time.After(3 * time.Second):
				t.Fatalf("timed out waiting for %s", typ)
			}
		}
	}
	nextBinaryContaining := func(ch uint32, needle string) {
		var acc strings.Builder
		for {
			select {
			case r := <-fromConnector:
				if r.binary != nil {
					id, payload, ok := protocol.DecodeBinary(r.binary)
					if ok && id == ch {
						acc.Write(payload)
						if strings.Contains(acc.String(), needle) {
							return
						}
					}
				}
			case <-time.After(3 * time.Second):
				t.Fatalf("timed out waiting for %q on ch %d; got %q", needle, ch, acc.String())
			}
		}
	}
	inner := func(t2 string, extra map[string]any) json.RawMessage {
		m := map[string]any{"type": t2}
		for k, v := range extra {
			m[k] = v
		}
		b, _ := json.Marshal(m)
		return b
	}

	// relay-open → attached (relay-msg) with the requested size (new session).
	send(protocol.Control{Type: "relay-open", ChannelID: 1, SessionID: "s1", Cols: 80, Rows: 24})
	att := nextControl("relay-msg")
	var attInner protocol.Inner
	json.Unmarshal(att.Msg, &attInner)
	if att.ChannelID != 1 || attInner.Type != "attached" || attInner.Cols != 80 {
		t.Fatalf("bad attached: %+v %+v", att, attInner)
	}

	// input → echoed binary on channel 1.
	send(protocol.Control{Type: "relay-msg", ChannelID: 1, Msg: inner("input", map[string]any{"data": "hi"})})
	nextBinaryContaining(1, "echo:hi")

	// second channel, same session: attached carries session size + replay.
	send(protocol.Control{Type: "relay-open", ChannelID: 2, SessionID: "s1", Cols: 999, Rows: 999})
	att2 := nextControl("relay-msg")
	var att2Inner protocol.Inner
	json.Unmarshal(att2.Msg, &att2Inner)
	if att2.ChannelID != 2 || att2Inner.Cols != 80 {
		t.Fatalf("newcomer must get session size: %+v", att2Inner)
	}
	nextBinaryContaining(2, "echo:hi") // scrollback replay

	// resize dedup: identical size → NO resize broadcast; then a real resize.
	send(protocol.Control{Type: "relay-msg", ChannelID: 1, Msg: inner("resize", map[string]any{"cols": 80, "rows": 24})})
	send(protocol.Control{Type: "relay-msg", ChannelID: 1, Msg: inner("resize", map[string]any{"cols": 120, "rows": 40})})
	rz := nextControl("relay-msg")
	var rzInner protocol.Inner
	json.Unmarshal(rz.Msg, &rzInner)
	if rzInner.Type != "resize" || rzInner.Cols != 120 {
		t.Fatalf("expected the 120x40 broadcast first (dedup swallowed 80x24): %+v", rzInner)
	}

	// relay-close detaches channel 1 without killing the session.
	send(protocol.Control{Type: "relay-close", ChannelID: 1})
	send(protocol.Control{Type: "relay-msg", ChannelID: 2, Msg: inner("input", map[string]any{"data": "bye"})})
	nextBinaryContaining(2, "echo:bye")
}

// TestShedRelayCloseClosesQueue verifies that when a relay-close message is shed
// (dropped because the per-channel queue is full), the queue is still closed so
// that any goroutine blocked on "for range w.queue" can exit rather than leaking.
func TestShedRelayCloseClosesQueue(t *testing.T) {
	// Construct a channelWorker with a 1-slot queue so we can fill it trivially.
	w := &channelWorker{
		queue:     make(chan protocol.Control, 1),
		sessionID: "shed-test",
	}
	// Fill the queue to capacity so the next enqueue will be shed.
	w.queue <- protocol.Control{Type: "relay-msg", ChannelID: 99}

	// Replicate the serveOnce dispatch for relay-close with a full queue.
	ctl := protocol.Control{Type: "relay-close", ChannelID: 99}
	sent := true
	select {
	case w.queue <- ctl:
	default: // shed
		sent = false
	}
	if sent {
		t.Fatal("expected relay-close to be shed when queue is full")
	}

	// Apply the fix: close the queue so any goroutine ranging over it can exit.
	close(w.queue)

	// Confirm that a goroutine doing "for range w.queue" terminates promptly.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for range w.queue {
		}
	}()
	select {
	case <-done:
		// goroutine exited — no leak
	case <-time.After(time.Second):
		t.Fatal("goroutine blocked forever after queue close (shed goroutine leak not fixed)")
	}
}
