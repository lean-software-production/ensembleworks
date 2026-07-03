package session

import (
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lean-software-production/ensembleworks/gateway-go/protocol"
)

// stubPty echoes writes back as output and records resizes.
type stubPty struct {
	mu      sync.Mutex
	out     chan []byte
	resizes []([2]int)
	closed  bool
}

func newStubPty() *stubPty { return &stubPty{out: make(chan []byte, 64)} }

func (p *stubPty) Read(b []byte) (int, error) {
	chunk, ok := <-p.out
	if !ok {
		return 0, io.EOF
	}
	return copy(b, chunk), nil
}
func (p *stubPty) Write(b []byte) (int, error) { p.out <- append([]byte("echo:"), b...); return len(b), nil }
func (p *stubPty) Resize(cols, rows int) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.resizes = append(p.resizes, [2]int{cols, rows})
	return nil
}
func (p *stubPty) Close() error { p.closed = true; close(p.out); return nil }

// recSink records everything, thread-safely.
type recSink struct {
	mu     sync.Mutex
	msgs   []protocol.Inner
	output strings.Builder
	closed bool
}

func (s *recSink) SendMsg(m protocol.Inner)  { s.mu.Lock(); s.msgs = append(s.msgs, m); s.mu.Unlock() }
func (s *recSink) SendOutput(p []byte)       { s.mu.Lock(); s.output.Write(p); s.mu.Unlock() }
func (s *recSink) Close()                    { s.mu.Lock(); s.closed = true; s.mu.Unlock() }
func (s *recSink) firstMsg() protocol.Inner  { s.mu.Lock(); defer s.mu.Unlock(); return s.msgs[0] }
func (s *recSink) allMsgs() []protocol.Inner { s.mu.Lock(); defer s.mu.Unlock(); return append([]protocol.Inner{}, s.msgs...) }
func (s *recSink) out() string               { s.mu.Lock(); defer s.mu.Unlock(); return s.output.String() }

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met within 2s")
}

func TestAttachEchoAndReplay(t *testing.T) {
	var spawned int
	m := NewManager(func(id string, cols, rows int) (Pty, error) { spawned++; return newStubPty(), nil })

	s1 := &recSink{}
	if err := m.Attach("t1", 1, 80, 24, s1); err != nil {
		t.Fatal(err)
	}
	if got := s1.firstMsg(); got.Type != "attached" || got.Cols != 80 || got.Rows != 24 {
		t.Fatalf("attached: %+v", got)
	}

	m.Input("t1", 1, "hi")
	waitFor(t, func() bool { return strings.Contains(s1.out(), "echo:hi") })

	// Second viewer with a silly requested size: attached carries the SESSION
	// size, no resize occurs, and the ring replays earlier output.
	s2 := &recSink{}
	if err := m.Attach("t1", 2, 999, 999, s2); err != nil {
		t.Fatal(err)
	}
	if spawned != 1 {
		t.Fatalf("second attach must not respawn: %d", spawned)
	}
	if got := s2.firstMsg(); got.Cols != 80 || got.Rows != 24 {
		t.Fatalf("attached must carry session size: %+v", got)
	}
	waitFor(t, func() bool { return strings.Contains(s2.out(), "echo:hi") })
}

func TestResizeClampDedupBroadcast(t *testing.T) {
	pty := newStubPty()
	m := NewManager(func(string, int, int) (Pty, error) { return pty, nil })
	s1, s2 := &recSink{}, &recSink{}
	m.Attach("t1", 1, 80, 24, s1)
	m.Attach("t1", 2, 80, 24, s2)

	m.Resize("t1", 80, 24) // dedup: identical → no pty resize, no broadcast
	m.Resize("t1", 1000, 1) // clamp → 500x5, broadcast to both
	waitFor(t, func() bool {
		for _, msg := range s2.allMsgs() {
			if msg.Type == "resize" && msg.Cols == 500 && msg.Rows == 5 {
				return true
			}
		}
		return false
	})
	pty.mu.Lock()
	defer pty.mu.Unlock()
	if len(pty.resizes) != 1 || pty.resizes[0] != [2]int{500, 5} {
		t.Fatalf("pty resizes: %v", pty.resizes)
	}
}

func TestConcurrentAttachSpawnsOnce(t *testing.T) {
	var mu sync.Mutex
	spawned := 0
	m := NewManager(func(string, int, int) (Pty, error) {
		mu.Lock()
		spawned++
		mu.Unlock()
		return newStubPty(), nil
	})
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(ch uint32) {
			defer wg.Done()
			m.Attach("race", ch, 80, 24, &recSink{})
		}(uint32(i + 1))
	}
	wg.Wait()
	if spawned != 1 {
		t.Fatalf("concurrent attach spawned %d ptys", spawned)
	}
}

func TestPtyExitBroadcastsExitAndForgets(t *testing.T) {
	pty := newStubPty()
	spawnCount := 0
	m := NewManager(func(string, int, int) (Pty, error) { spawnCount++; return pty, nil })
	s1 := &recSink{}
	m.Attach("t1", 1, 80, 24, s1)
	pty.Close() // EOF → exit broadcast, session forgotten
	waitFor(t, func() bool {
		for _, msg := range s1.allMsgs() {
			if msg.Type == "exit" {
				return true
			}
		}
		return false
	})
	waitFor(t, func() bool { s1.mu.Lock(); defer s1.mu.Unlock(); return s1.closed })
	// Re-attach spawns fresh (tmux new -A semantics live in the factory).
	m.Attach("t1", 2, 80, 24, &recSink{})
	if spawnCount != 2 {
		t.Fatalf("expected respawn after exit, got %d spawns", spawnCount)
	}
}

func TestDetachAllLeavesPtyRunning(t *testing.T) {
	pty := newStubPty()
	m := NewManager(func(string, int, int) (Pty, error) { return pty, nil })
	s1 := &recSink{}
	m.Attach("t1", 1, 80, 24, s1)
	m.DetachAll()
	if pty.closed {
		t.Fatal("DetachAll must never kill the pty — tmux survives relay drops")
	}
	waitFor(t, func() bool { s1.mu.Lock(); defer s1.mu.Unlock(); return s1.closed })
}
