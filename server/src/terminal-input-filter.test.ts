// Run: bun test server/src/terminal-input-filter.test.ts
// Locks stripTerminalReports: browser-generated device-report escape
// sequences (DA1/DA2/DA3, DSR/CPR, DECRPM, XTVERSION, OSC color reports)
// are removed from client input, while real keystrokes, mouse reports and
// bracketed-paste are preserved. Pure, network-free.
import { describe, expect, test } from 'bun:test'
import { stripTerminalReports } from './terminal-input-filter.ts'

describe('stripTerminalReports — removes device reports', () => {
  test('the exact DA1+DA2 pair from the bug report → ""', () => {
    expect(stripTerminalReports('\x1b[?1;2c\x1b[>0;276;0c')).toBe('')
  })
  test('DA1 reply alone', () => {
    expect(stripTerminalReports('\x1b[?1;2c')).toBe('')
  })
  test('DA2 reply alone', () => {
    expect(stripTerminalReports('\x1b[>0;276;0c')).toBe('')
  })
  test('DA3 reply (DCS ! | … ST)', () => {
    expect(stripTerminalReports('\x1bP!|00000000\x1b\\')).toBe('')
  })
  test('DSR cursor-position report (CSI … R)', () => {
    expect(stripTerminalReports('\x1b[24;80R')).toBe('')
  })
  test('DSR private report (CSI ? … n)', () => {
    expect(stripTerminalReports('\x1b[?1;0n')).toBe('')
  })
  test('DECRPM mode report (CSI ? … $ y)', () => {
    expect(stripTerminalReports('\x1b[?2026;2$y')).toBe('')
  })
  test('XTVERSION reply (DCS > | … ST)', () => {
    expect(stripTerminalReports('\x1bP>|tmux 3.5\x1b\\')).toBe('')
  })
  test('OSC 11 color report (ST-terminated)', () => {
    expect(stripTerminalReports('\x1b]11;rgb:0000/0000/0000\x1b\\')).toBe('')
  })
  test('OSC 10 color report (BEL-terminated)', () => {
    expect(stripTerminalReports('\x1b]10;rgb:ffff/ffff/ffff\x07')).toBe('')
  })
  test('OSC 4 palette color report', () => {
    expect(stripTerminalReports('\x1b]4;1;rgb:ffff/0000/0000\x07')).toBe('')
  })
})

describe('stripTerminalReports — preserves real input', () => {
  test('ordinary keystrokes + Enter unchanged', () => {
    expect(stripTerminalReports('ls -la\r')).toBe('ls -la\r')
  })
  test('Ctrl-C unchanged', () => {
    expect(stripTerminalReports('\x03')).toBe('\x03')
  })
  test('arrow key (CSI A) unchanged', () => {
    expect(stripTerminalReports('\x1b[A')).toBe('\x1b[A')
  })
  test('SGR mouse report (CSI < … M) unchanged', () => {
    expect(stripTerminalReports('\x1b[<0;10;20M')).toBe('\x1b[<0;10;20M')
  })
  test('SGR mouse release (CSI < … m) unchanged', () => {
    expect(stripTerminalReports('\x1b[<0;10;20m')).toBe('\x1b[<0;10;20m')
  })
  test('legacy mouse report (CSI M …) unchanged', () => {
    expect(stripTerminalReports('\x1b[M !!')).toBe('\x1b[M !!')
  })
  test('bracketed-paste payload unchanged', () => {
    expect(stripTerminalReports('\x1b[200~hello\x1b[201~')).toBe('\x1b[200~hello\x1b[201~')
  })
  test('empty string', () => {
    expect(stripTerminalReports('')).toBe('')
  })
})

describe('stripTerminalReports — mixed frames', () => {
  test('report embedded between keystrokes is removed, keystrokes survive', () => {
    expect(stripTerminalReports('a\x1b[?1;2cb')).toBe('ab')
  })
  test('DA1+DA2 surrounded by real input', () => {
    expect(stripTerminalReports('x\x1b[?1;2c\x1b[>0;276;0cy')).toBe('xy')
  })
  test('a real command after a stray reply', () => {
    expect(stripTerminalReports('\x1b[?1;2cwhoami\r')).toBe('whoami\r')
  })
})
