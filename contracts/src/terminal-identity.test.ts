import { describe, expect, test } from 'bun:test'
import {
	CAPABILITY_PROFILE,
	oscColorReply,
	TERMINAL_CANONICAL_COLORS,
	TRACKED_MODES,
} from './terminal-identity.js'

describe('terminal-identity constants', () => {
	test('canonical colours match the paper terminal theme', () => {
		expect(TERMINAL_CANONICAL_COLORS.background).toBe('#fff')
		expect(TERMINAL_CANONICAL_COLORS.foreground).toBe('#0f172a')
	})

	test('pinned identity replies', () => {
		expect(CAPABILITY_PROFILE.da1).toBe('\x1b[?1;2c')
		expect(CAPABILITY_PROFILE.da2).toBe('\x1b[>0;276;0c')
		expect(CAPABILITY_PROFILE.dsrOk).toBe('\x1b[0n')
	})

	test('DECRPM initial states: tracked modes reset, 1004 unsupported', () => {
		expect(CAPABILITY_PROFILE.modes[2004]).toBe(2)
		expect(CAPABILITY_PROFILE.modes[2026]).toBe(2)
		expect(CAPABILITY_PROFILE.modes[1016]).toBe(2)
		expect(CAPABILITY_PROFILE.modes[1004]).toBe(0)
		expect(TRACKED_MODES).toEqual([2004, 2026, 1016])
	})

	test('OSC colour replies use 16-bit doubled rgb with ST terminator', () => {
		expect(oscColorReply(11)).toBe('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')
		expect(oscColorReply(10)).toBe('\x1b]10;rgb:0f0f/1717/2a2a\x1b\\')
	})
})
