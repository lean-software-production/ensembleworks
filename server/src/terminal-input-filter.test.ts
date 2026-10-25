// Run: bun src/terminal-input-filter.test.ts   (from server/)
// Locks stripTerminalReports: browser-generated device-report escape
// sequences (DA1/DA2/DA3, DSR/CPR, DECRPM, XTVERSION, OSC color reports)
// are removed from client input, while real keystrokes, mouse reports and
// bracketed-paste are preserved. Pure, network-free.
import assert from 'node:assert/strict'
import { stripTerminalReports } from './terminal-input-filter.ts'

// --- removes device reports ---
assert.equal(
	stripTerminalReports('\x1b[?1;2c\x1b[>0;276;0c'),
	'',
	'the exact DA1+DA2 pair from the bug report → ""',
)
assert.equal(stripTerminalReports('\x1b[?1;2c'), '', 'DA1 reply alone')
assert.equal(stripTerminalReports('\x1b[>0;276;0c'), '', 'DA2 reply alone')
assert.equal(stripTerminalReports('\x1bP!|00000000\x1b\\'), '', 'DA3 reply (DCS ! | … ST)')
assert.equal(stripTerminalReports('\x1b[24;80R'), '', 'DSR cursor-position report (CSI … R)')
assert.equal(stripTerminalReports('\x1b[?1;0n'), '', 'DSR private report (CSI ? … n)')
assert.equal(stripTerminalReports('\x1b[?2026;2$y'), '', 'DECRPM mode report (CSI ? … $ y)')
assert.equal(stripTerminalReports('\x1bP>|tmux 3.5\x1b\\'), '', 'XTVERSION reply (DCS > | … ST)')

// --- preserves OSC color reports ---
// These are browser-generated reports like the ones above, but they must NOT
// be stripped, for two independently verified reasons:
//
//  1. Apps need them. A TUI learns whether the terminal is light or dark by
//     asking OSC 11 ("\e]11;?") and reading the reply. Dropping it left
//     opencode resolving every theme to its DARK variant on our white-
//     background canvas terminals — a light theme rendered black. Observed
//     directly: the browser answered "\e]11;rgb:ffff/ffff/ffff" and the
//     filter ate it.
//  2. Their surplus copies are harmless. Unlike DA1/DA2/DECRPM — whose
//     payloads are printable and echo at the shell prompt as literal garbage
//     ("1;2c0;276;0c", "2026;2$y") — an OSC reply is wrapped in \e] … ST/BEL,
//     which readline consumes whole. Verified by firing OSC 10/11 queries via
//     tmux passthrough at two attached browsers with these replies passing
//     through: the prompt stayed clean.
//
// So the fan-in surplus this filter exists to remove simply does not manifest
// for OSC, while the cost of removing it is a visibly broken TUI.
assert.equal(
	stripTerminalReports('\x1b]11;rgb:ffff/ffff/ffff\x1b\\'),
	'\x1b]11;rgb:ffff/ffff/ffff\x1b\\',
	'OSC 11 background-color report (ST-terminated) preserved',
)
assert.equal(
	stripTerminalReports('\x1b]10;rgb:0f0f/1717/2a2a\x07'),
	'\x1b]10;rgb:0f0f/1717/2a2a\x07',
	'OSC 10 foreground-color report (BEL-terminated) preserved',
)
assert.equal(
	stripTerminalReports('\x1b]4;1;rgb:ffff/0000/0000\x07'),
	'\x1b]4;1;rgb:ffff/0000/0000\x07',
	'OSC 4 palette-color report preserved',
)
assert.equal(
	stripTerminalReports('\x1b[?1;2c\x1b]11;rgb:ffff/ffff/ffff\x1b\\'),
	'\x1b]11;rgb:ffff/ffff/ffff\x1b\\',
	'DA1 stripped, OSC color report in the same frame preserved',
)

// --- preserves real input ---
assert.equal(stripTerminalReports('ls -la\r'), 'ls -la\r', 'ordinary keystrokes + Enter unchanged')
assert.equal(stripTerminalReports('\x03'), '\x03', 'Ctrl-C unchanged')
assert.equal(stripTerminalReports('\x1b[A'), '\x1b[A', 'arrow key (CSI A) unchanged')
// Modified F3 collides with the CPR shape: xterm.js encodes F3-with-modifier as
// ESC [1;<mod>R (Keyboard.ts keyCode 114), mod = 2..8. Real host-bound input, must survive.
assert.equal(stripTerminalReports('\x1bOR'), '\x1bOR', 'unmodified F3 (SS3 R) unchanged')
assert.equal(stripTerminalReports('\x1b[1;2R'), '\x1b[1;2R', 'Shift+F3 (CSI 1;2 R) unchanged')
assert.equal(stripTerminalReports('\x1b[1;5R'), '\x1b[1;5R', 'Ctrl+F3 (CSI 1;5 R) unchanged')
assert.equal(stripTerminalReports('\x1b[1;8R'), '\x1b[1;8R', 'Ctrl+Shift+Alt+F3 (CSI 1;8 R) unchanged')
assert.equal(
	stripTerminalReports('\x1b[24;80R\x1b[1;2R'),
	'\x1b[1;2R',
	'CPR stripped, modified F3 in the same frame preserved',
)
assert.equal(
	stripTerminalReports('\x1b[<0;10;20M'),
	'\x1b[<0;10;20M',
	'SGR mouse report (CSI < … M) unchanged',
)
assert.equal(
	stripTerminalReports('\x1b[<0;10;20m'),
	'\x1b[<0;10;20m',
	'SGR mouse release (CSI < … m) unchanged',
)
assert.equal(
	stripTerminalReports('\x1b[M !!'),
	'\x1b[M !!',
	'legacy mouse report (CSI M …) unchanged',
)
assert.equal(
	stripTerminalReports('\x1b[200~hello\x1b[201~'),
	'\x1b[200~hello\x1b[201~',
	'bracketed-paste payload unchanged',
)
assert.equal(stripTerminalReports(''), '', 'empty string')

// --- mixed frames ---
assert.equal(
	stripTerminalReports('a\x1b[?1;2cb'),
	'ab',
	'report embedded between keystrokes is removed, keystrokes survive',
)
assert.equal(
	stripTerminalReports('x\x1b[?1;2c\x1b[>0;276;0cy'),
	'xy',
	'DA1+DA2 surrounded by real input',
)
assert.equal(
	stripTerminalReports('\x1b[?1;2cwhoami\r'),
	'whoami\r',
	'a real command after a stray reply',
)

console.log('ok: stripTerminalReports removes device reports and preserves real input')
