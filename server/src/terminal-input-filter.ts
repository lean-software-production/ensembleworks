/**
 * Strip browser-generated terminal *device reports* from client input before
 * it reaches the shared tmux PTY.
 *
 * Why: the terminal gateway fans one PTY out to N browsers, each running its
 * own xterm.js. When a device-attributes / status query appears in the
 * broadcast output, every browser auto-replies and all N replies fan back
 * into the single PTY as {type:'input'}. tmux (the authoritative inner
 * emulator) consumes at most one; the surplus lands at the shell prompt as
 * literal garbage like `?1;2c>0;276;0c`. tmux already pins its own
 * capabilities (deploy/tmux-ensembleworks.conf), so these browser reports are
 * always surplus and safe to drop.
 *
 * Design: targeted, per-occurrence removal of a small closed set of report
 * sequences — NOT a broad "nuke all CSI" regex — so mouse reports
 * (CSI < … M/m, CSI M …) and bracketed-paste (CSI 200~/201~) can never be
 * caught. See terminal-input-filter.test.ts for the preserved-input cases.
 *
 * OSC color reports are deliberately let through. An earlier version of this
 * filter also removed OSC 10/11/4 replies, which broke every TUI that asks the
 * terminal whether it is light or dark: opencode queries `\e]11;?`, our white
 * canvas terminal answered `\e]11;rgb:ffff/ffff/ffff`, the filter ate it, and
 * opencode resolved even an explicitly-chosen light theme to its DARK variant
 * (verified by bisect — restoring that one pattern flips the rendering back and
 * forth). Two things make OSC the exception:
 *
 *  - Apps genuinely need the answer. Nothing else tells a program the
 *    terminal's background color; tmux does not synthesize one.
 *  - The surplus copies are harmless. DA1/DA2/DECRPM payloads are printable,
 *    so extra replies echo at the shell prompt as literal garbage
 *    (`1;2c0;276;0c`, `2026;2$y`). An OSC reply is wrapped in \e] … ST/BEL,
 *    which readline consumes whole — firing OSC 10/11 queries at two attached
 *    browsers with the replies passing through leaves the prompt clean.
 *
 * So for OSC the cure was strictly worse than the disease. The remaining
 * stripped classes all fail that second test — their surplus really does
 * surface as garbage — which is why they stay.
 *
 * Accepted limitations (YAGNI):
 *  - A reply split across two WebSocket input frames could still slip
 *    through. In practice xterm emits each auto-reply in a single onData
 *    call, so it arrives intact in one frame — same worst case as today.
 *  - We drop browser device-reports unconditionally, including the first one
 *    tmux's attach probe might otherwise consume. tmux tolerates a silent
 *    outer terminal (probe timeout + its pinned RGB override), so truecolor
 *    and behaviour are unaffected. If tmux feature-detection ever regresses,
 *    the escalation is to synthesize exactly one reply per query (Approach C).
 *  - Focus in/out (CSI I / CSI O) are out of scope and intentionally NOT
 *    stripped: they are single bytes that rarely surface as visible garbage.
 *  - DECRPM capability replies (mode 2026 synchronized output, 2004 bracketed
 *    paste, 1004 focus reporting) are still stripped, so apps that probe for
 *    those features get silence and fall back. They cannot simply be let
 *    through like OSC: their surplus copies DO echo as prompt garbage. Fixing
 *    that properly needs Approach C (one authoritative reply per query) rather
 *    than a filter.
 */

// Each pattern targets one class of host-directed device report. `g` flag so
// every occurrence anywhere in the chunk is removed (a reply may be
// concatenated with real keystrokes in one frame).
const REPORT_PATTERNS: RegExp[] = [
	// Primary Device Attributes (DA1) reply — CSI ? … c   e.g. \e[?1;2c
	/\x1b\[\?[0-9;]*c/g,
	// Secondary Device Attributes (DA2) reply — CSI > … c   e.g. \e[>0;276;0c
	/\x1b\[>[0-9;]*c/g,
	// Tertiary Device Attributes (DA3) reply — DCS ! | … ST
	/\x1bP!\|[0-9A-Fa-f]*\x1b\\/g,
	// DSR / cursor-position report — CSI … R   (plain, e.g. \e[24;80R)
	// The negative lookahead spares modified F3, which xterm.js encodes into the
	// same shape: ESC [1;<mod>R for mod 2..8 (@xterm/xterm Keyboard.ts, keyCode
	// 114). That is real host-bound input and must never be dropped. The cost is
	// that a genuine CPR for row 1, columns 2..8 also survives — the right way to
	// resolve an unavoidable ambiguity, since leaking a rare report is far
	// cheaper than silently eating a keystroke. (Unmodified F3 is ESC O R, which
	// this pattern never matched.)
	/\x1b\[(?!1;[2-8]R)[0-9;]*R/g,
	// DSR private status report — CSI ? … n   (e.g. \e[?1;0n)
	/\x1b\[\?[0-9;]*n/g,
	// DECRPM mode report — CSI ? … $ y   (e.g. \e[?2026;2$y)
	/\x1b\[\?[0-9;]*\$y/g,
	// XTVERSION reply — DCS > | … ST
	/\x1bP>\|[^\x1b]*\x1b\\/g,
	// NOT stripped: OSC color reports (OSC 10/11/4 … ; rgb:…). See the
	// "OSC color reports are deliberately let through" note above.
]

export function stripTerminalReports(data: string): string {
	let out = data
	for (const re of REPORT_PATTERNS) out = out.replace(re, '')
	return out
}
