import { describe, expect, test } from 'bun:test'
import { createQueryResponder } from './terminal-responder.js'

const enc = new TextEncoder()
const dec = new TextDecoder()
const run = (backend: 'tmux' | 'pty', ...chunks: string[]) => {
	const r = createQueryResponder({ backend })
	const out = { live: '', history: '', replies: [] as string[] }
	for (const c of chunks) {
		const res = r.process(enc.encode(c))
		out.live += dec.decode(res.live)
		out.history += dec.decode(res.history)
		out.replies.push(...res.replies.map((b) => dec.decode(b)))
	}
	return { ...out, responder: r }
}

describe('stateless queries (spec matrix rows DA1/DA2/DA3/DSR/XTVERSION/kitty)', () => {
	test('DA1 bare and with param 0: scrubbed from both streams, answered from profile', () => {
		for (const q of ['\x1b[c', '\x1b[0c']) {
			const out = run('tmux', `before${q}after`)
			expect(out.live).toBe('beforeafter')
			expect(out.history).toBe('beforeafter')
			expect(out.replies).toEqual(['\x1b[?1;2c'])
		}
	})

	test('DA2 scrubbed + answered; DA3 and XTVERSION and kitty scrubbed, unanswered', () => {
		const out = run('tmux', 'a\x1b[>cb\x1b[=cc\x1b[>0qd\x1b[?ue')
		expect(out.live).toBe('abcde')
		expect(out.replies).toEqual(['\x1b[>0;276;0c'])
	})

	test('DSR-5 answered ok; ordinary output and SGR sequences untouched', () => {
		const out = run('tmux', '\x1b[31mred\x1b[0m\x1b[5n')
		expect(out.live).toBe('\x1b[31mred\x1b[0m')
		expect(out.replies).toEqual(['\x1b[0n'])
	})

	test('multiple queries in one chunk each get one reply, in stream order', () => {
		const out = run('tmux', '\x1b[c mid \x1b[5n')
		expect(out.live).toBe(' mid ')
		expect(out.replies).toEqual(['\x1b[?1;2c', '\x1b[0n'])
	})

	test('DA-reply-shaped bytes are NOT treated as queries (we parse queries only)', () => {
		// A reply travelling outbound would only occur if tmux echoed one; the
		// responder must not answer replies. \x1b[?1;2c has prefix ? — no query
		// matcher covers it.
		const out = run('tmux', '\x1b[?1;2c')
		expect(out.replies).toEqual([])
	})
})

describe('DECRQM tracked state + 1004 stripping (spec decisions 5 and 6)', () => {
	test('initial states: tracked modes reset(2), 1004 and unknown not recognised(0)', () => {
		const out = run('tmux', '\x1b[?2004$p\x1b[?1004$p\x1b[?2027$p')
		expect(out.replies).toEqual(['\x1b[?2004;2$y', '\x1b[?1004;0$y', '\x1b[?2027;0$y'])
		expect(out.live).toBe('')
	})

	test('DECSET flips tracked mode to set(1); DECRST back to reset(2); sequences pass through', () => {
		const out = run('tmux', '\x1b[?2004h\x1b[?2004$p\x1b[?2004l\x1b[?2004$p')
		expect(out.replies).toEqual(['\x1b[?2004;1$y', '\x1b[?2004;2$y'])
		expect(out.live).toBe('\x1b[?2004h\x1b[?2004l')
	})

	test('RIS and DECSTR reset tracked modes to initial', () => {
		const out = run('tmux', '\x1b[?2026h\x1bc\x1b[?2026$p')
		expect(out.replies).toEqual(['\x1b[?2026;2$y'])
		const out2 = run('tmux', '\x1b[?2026h\x1b[!p\x1b[?2026$p')
		expect(out2.replies).toEqual(['\x1b[?2026;2$y'])
	})

	test('?1004 stripped from DECSET, other params in the same sequence preserved', () => {
		const out = run('tmux', '\x1b[?1004h\x1b[?1004;2004h\x1b[?2004;1004;2026h')
		expect(out.live).toBe('\x1b[?2004h\x1b[?2004;2026h')
	})

	test('DECSET of an untracked mode passes through and does not change answers', () => {
		const out = run('tmux', '\x1b[?25h\x1b[?2027$p')
		expect(out.live).toBe('\x1b[?25h')
		expect(out.replies).toEqual(['\x1b[?2027;0$y'])
	})
})
