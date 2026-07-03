// Package session owns tmux-backed terminal sessions: one pty per session,
// fanned out to every attached channel sink, with the resize-authority and
// scrollback semantics of server/src/terminal-gateway.ts.
//
// Concurrency invariants (the Node gateway got these free from its single
// thread; here they are explicit — spike spec §3):
//   - get-or-create holds the manager mutex: concurrent Attach for a new
//     session spawns exactly one pty.
//   - attached + ring replay + channel subscription happen atomically under
//     the session mutex, so live read-loop output can neither interleave
//     into the replay nor be dropped between replay and subscribe.
//   - Input/Resize are serialized per session by the same mutex.
package session

import (
	"fmt"
	"io"
	"sync"

	"github.com/lean-software-production/ensembleworks/gateway-go/protocol"
)

const (
	minCols, maxCols = 20, 500
	minRows, maxRows = 5, 200
	scrollbackLimit  = 256 * 1024
)

type Pty interface {
	io.ReadWriter
	Resize(cols, rows int) error
	Close() error
}

type PtyFactory func(sessionID string, cols, rows int) (Pty, error)

// Sink is one attached viewer (a relay channel). Implementations must be
// safe to call from the session read-loop goroutine.
type Sink interface {
	SendMsg(inner protocol.Inner)
	SendOutput(payload []byte)
	Close()
}

type sessionState struct {
	mu        sync.Mutex
	id        string
	pty       Pty
	cols, rows int
	ring      [][]byte
	ringBytes int
	channels  map[uint32]Sink
	gone      bool
}

type Manager struct {
	mu       sync.Mutex
	spawn    PtyFactory
	sessions map[string]*sessionState
}

func NewManager(spawn PtyFactory) *Manager {
	return &Manager{spawn: spawn, sessions: make(map[string]*sessionState)}
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func (m *Manager) getOrCreate(id string, cols, rows int) (*sessionState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.sessions[id]; ok {
		return s, nil
	}
	cols, rows = clamp(cols, minCols, maxCols), clamp(rows, minRows, maxRows)
	pty, err := m.spawn(id, cols, rows)
	if err != nil {
		return nil, err
	}
	s := &sessionState{id: id, pty: pty, cols: cols, rows: rows, channels: make(map[uint32]Sink)}
	m.sessions[id] = s
	go m.readLoop(s)
	return s, nil
}

func (m *Manager) readLoop(s *sessionState) {
	buf := make([]byte, 32*1024)
	for {
		n, err := s.pty.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			s.mu.Lock()
			s.ring = append(s.ring, chunk)
			s.ringBytes += len(chunk)
			for s.ringBytes > scrollbackLimit && len(s.ring) > 1 {
				s.ringBytes -= len(s.ring[0])
				s.ring = s.ring[1:]
			}
			for _, sink := range s.channels {
				sink.SendOutput(chunk)
			}
			s.mu.Unlock()
		}
		if err != nil {
			s.mu.Lock()
			s.gone = true
			for _, sink := range s.channels {
				sink.SendMsg(protocol.Inner{Type: "exit"})
				sink.Close()
			}
			s.channels = make(map[uint32]Sink)
			s.mu.Unlock()
			m.mu.Lock()
			if m.sessions[s.id] == s {
				delete(m.sessions, s.id)
			}
			m.mu.Unlock()
			return
		}
	}
}

func (m *Manager) Attach(sessionID string, channelID uint32, cols, rows int, sink Sink) error {
	s, err := m.getOrCreate(sessionID, cols, rows)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.gone {
		return fmt.Errorf("session %s has exited", sessionID)
	}
	// attached carries the SESSION's current size — a newcomer's requested
	// grid must not resize existing viewers (spike spec §2).
	sink.SendMsg(protocol.Inner{Type: "attached", Cols: s.cols, Rows: s.rows})
	for _, chunk := range s.ring {
		sink.SendOutput(chunk)
	}
	s.channels[channelID] = sink
	return nil
}

func (m *Manager) Input(sessionID string, channelID uint32, data string) {
	if s := m.lookup(sessionID); s != nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		if _, attached := s.channels[channelID]; attached && !s.gone {
			_, _ = s.pty.Write([]byte(data))
		}
	}
}

func (m *Manager) Resize(sessionID string, cols, rows int) {
	s := m.lookup(sessionID)
	if s == nil {
		return
	}
	cols, rows = clamp(cols, minCols, maxCols), clamp(rows, minRows, maxRows)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.gone || (cols == s.cols && rows == s.rows) {
		return // dedup: no pty call, no broadcast (client grid logic relies on this)
	}
	s.cols, s.rows = cols, rows
	_ = s.pty.Resize(cols, rows)
	for _, sink := range s.channels {
		sink.SendMsg(protocol.Inner{Type: "resize", Cols: cols, Rows: rows})
	}
}

func (m *Manager) Detach(sessionID string, channelID uint32) {
	if s := m.lookup(sessionID); s != nil {
		s.mu.Lock()
		delete(s.channels, channelID)
		s.mu.Unlock()
	}
}

// DetachAll drops every viewer (relay disconnect). The ptys stay running —
// tmux sessions must survive connector↔canvas link failures.
func (m *Manager) DetachAll() {
	m.mu.Lock()
	all := make([]*sessionState, 0, len(m.sessions))
	for _, s := range m.sessions {
		all = append(all, s)
	}
	m.mu.Unlock()
	for _, s := range all {
		s.mu.Lock()
		for _, sink := range s.channels {
			sink.Close()
		}
		s.channels = make(map[uint32]Sink)
		s.mu.Unlock()
	}
}

func (m *Manager) lookup(id string) *sessionState {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id]
}
