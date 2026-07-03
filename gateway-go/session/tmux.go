package session

import (
	"os"
	"os/exec"

	"github.com/creack/pty"
)

const tmuxPrefix = "canvas-" // must match terminal-gateway.ts TMUX_PREFIX

type tmuxPty struct{ f *os.File }

func (p *tmuxPty) Read(b []byte) (int, error)  { return p.f.Read(b) }
func (p *tmuxPty) Write(b []byte) (int, error) { return p.f.Write(b) }
func (p *tmuxPty) Resize(cols, rows int) error {
	return pty.Setsize(p.f, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}
func (p *tmuxPty) Close() error { return p.f.Close() }

// TmuxFactory spawns `tmux new-session -A -s canvas-<id>` — `-A` attaches
// when the session exists, so a connector restart reattaches to surviving
// sessions. `-f` is passed only when tmuxConf exists (matches the Node
// gateway's existence-check behaviour; missing conf silently degrades
// clipboard/status-bar, never crashes).
func TmuxFactory(tmuxConf string) PtyFactory {
	return func(id string, cols, rows int) (Pty, error) {
		args := []string{}
		if tmuxConf != "" {
			if _, err := os.Stat(tmuxConf); err == nil {
				args = append(args, "-f", tmuxConf)
			}
		}
		args = append(args, "new-session", "-A", "-s", tmuxPrefix+id)
		cmd := exec.Command("tmux", args...)
		cmd.Env = append(os.Environ(), "TERM=xterm-256color")
		f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
		if err != nil {
			return nil, err
		}
		return &tmuxPty{f: f}, nil
	}
}
