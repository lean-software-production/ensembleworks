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

	test('DECRQM with malformed or oversized params is scrubbed without answer', () => {
		const out = run('tmux', '\x1b[?2004;2026$p\x1b[?99999999999999999999$p')
		expect(out.replies).toEqual([])
		expect(out.live).toBe('')
	})
})

describe('OSC 10/11 (spec decision 4: pin queries, pass setters)', () => {
	test('query form answered with canonical colours, both BEL and ST terminators', () => {
		const st = run('tmux', '\x1b]11;?\x1b\\')
		expect(st.replies).toEqual(['\x1b]11;rgb:ffff/ffff/ffff\x1b\\'])
		expect(st.live).toBe('')
		const bel = run('tmux', '\x1b]10;?\x07')
		expect(bel.replies).toEqual(['\x1b]10;rgb:0f0f/1717/2a2a\x1b\\'])
		expect(bel.live).toBe('')
	})

	test('setter form passes through untouched and is not answered', () => {
		const out = run('tmux', '\x1b]11;#1a1a2e\x07plain')
		expect(out.live).toBe('\x1b]11;#1a1a2e\x07plain')
		expect(out.replies).toEqual([])
	})

	test('OSC 4 passes through entirely (phase 2, not handled)', () => {
		const out = run('tmux', '\x1b]4;0;?\x07')
		expect(out.live).toBe('\x1b]4;0;?\x07')
		expect(out.replies).toEqual([])
	})
})

describe('carry buffer + flush lifecycle (spec: connector integration)', () => {
	test('a query split at EVERY byte boundary is still recognised once', () => {
		const q = '\x1b[?2004$p'
		for (let cut = 1; cut < q.length; cut++) {
			const out = run('tmux', 'a' + q.slice(0, cut), q.slice(cut) + 'b')
			expect(out.live).toBe('ab')
			expect(out.replies).toEqual(['\x1b[?2004;2$y'])
		}
	})

	test('a split OSC query spanning three chunks is recognised', () => {
		const out = run('tmux', 'x\x1b]1', '1;', '?\x1b\\y')
		expect(out.live).toBe('xy')
		expect(out.replies).toEqual(['\x1b]11;rgb:ffff/ffff/ffff\x1b\\'])
	})

	test('an OSC query with ST terminator split at EVERY byte boundary is still recognised once', () => {
		const q = '\x1b]11;?\x1b\\'
		for (let cut = 1; cut < q.length; cut++) {
			const out = run('tmux', 'a' + q.slice(0, cut), q.slice(cut) + 'b')
			expect(out.live).toBe('ab')
			expect(out.replies).toEqual(['\x1b]11;rgb:ffff/ffff/ffff\x1b\\'])
		}
	})

	test('incomplete prefix with no further output is returned by flush, not lost', () => {
		const r = createQueryResponder({ backend: 'tmux' })
		const res = r.process(enc.encode('tail\x1b[?20'))
		expect(dec.decode(res.live)).toBe('tail')
		expect(dec.decode(r.flush('attach'))).toBe('\x1b[?20')
		// after flush the carry is gone
		expect(dec.decode(r.flush('exit'))).toBe('')
	})

	test('lone ESC then plain text is not swallowed', () => {
		const out = run('tmux', 'a\x1b', 'plain')
		expect(out.live).toBe('a\x1bplain')
	})

	test('malformed over-long candidate is flushed as ordinary output at the 64-byte bound', () => {
		const junk = '\x1b]11;' + 'x'.repeat(80) // no terminator
		const out = run('tmux', junk, 'end\x07')
		expect(out.live).toBe(junk + 'end\x07')
		expect(out.replies).toEqual([])
	})

	test('CPR: scrubbed unanswered on tmux backend, passes through on pty backend', () => {
		expect(run('tmux', 'a\x1b[6nb').live).toBe('ab')
		expect(run('pty', 'a\x1b[6nb').live).toBe('a\x1b[6nb')
		expect(run('pty', 'a\x1b[6nb').replies).toEqual([])
	})
})
