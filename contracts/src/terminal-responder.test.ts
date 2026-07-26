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
