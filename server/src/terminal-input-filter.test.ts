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
assert.equal(
	stripTerminalReports('\x1b]11;rgb:0000/0000/0000\x1b\\'),
	'',
	'OSC 11 color report (ST-terminated)',
)
assert.equal(
	stripTerminalReports('\x1b]10;rgb:ffff/ffff/ffff\x07'),
	'',
	'OSC 10 color report (BEL-terminated)',
)
assert.equal(
	stripTerminalReports('\x1b]4;1;rgb:ffff/0000/0000\x07'),
	'',
	'OSC 4 palette color report',
)

// --- preserves real input ---
assert.equal(stripTerminalReports('ls -la\r'), 'ls -la\r', 'ordinary keystrokes + Enter unchanged')
assert.equal(stripTerminalReports('\x03'), '\x03', 'Ctrl-C unchanged')
assert.equal(stripTerminalReports('\x1b[A'), '\x1b[A', 'arrow key (CSI A) unchanged')
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
