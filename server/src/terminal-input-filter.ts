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
	/\x1b\[[0-9;]*R/g,
	// DSR private status report — CSI ? … n   (e.g. \e[?1;0n)
	/\x1b\[\?[0-9;]*n/g,
	// DECRPM mode report — CSI ? … $ y   (e.g. \e[?2026;2$y)
	/\x1b\[\?[0-9;]*\$y/g,
	// XTVERSION reply — DCS > | … ST
	/\x1bP>\|[^\x1b]*\x1b\\/g,
	// OSC color reports (OSC 10/11/4 … ; rgb:…), terminated by ST or BEL.
	// Constrained to the OSC numbers we actually see from color queries so
	// this never eats an unrelated OSC.
	/\x1b\](?:10|11|4;[0-9]+);[^\x07\x1b]*(?:\x07|\x1b\\)/g,
]

export function stripTerminalReports(data: string): string {
	let out = data
	for (const re of REPORT_PATTERNS) out = out.replace(re, '')
	return out
}
