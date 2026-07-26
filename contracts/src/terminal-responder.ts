/**
 * Server-only streaming transformer: the connector-side half of the
 * terminal-identity contract. Scans OUTBOUND pty bytes (app → renderers)
 * for device queries, removes them from browser-bound output, and produces
 * the profile's replies for the connector to write back into the pty.
 *
 * Parses QUERIES only, never replies — so the CPR-vs-modified-F3 reply
 * ambiguity (field report §8) cannot occur here by construction.
 *
 * NEVER export through contracts' root barrel (browser bundles).
 * Spec: docs/superpowers/specs/2026-07-26-terminal-fanin-design.md.
 */
import { CAPABILITY_PROFILE, oscColorReply, TRACKED_MODES } from './terminal-identity.js'

export interface ResponderResult {
	live: Uint8Array
	history: Uint8Array
	replies: Uint8Array[]
}

export interface QueryResponder {
	process(chunk: Uint8Array): ResponderResult
	flush(reason: 'attach' | 'snapshot' | 'exit'): Uint8Array
}

// Internally we work on latin1 strings: escape sequences are pure ASCII and
// latin1 round-trips every byte value, so UTF-8 payload bytes pass through
// bit-identical.
const toLatin1 = (b: Uint8Array): string => {
	let s = ''
	for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!)
	return s
}
const fromLatin1 = (s: string): Uint8Array => {
	const b = new Uint8Array(s.length)
	for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff
	return b
}

// One alternation of every sequence the matrix gives a disposition for.
// Groups: [1] CSI body for queries/DECSET/DECRST/DECSTR, [2] OSC 10/11 body.
// RIS (\x1bc) matches via the bare alternative.
const SEQ_RE =
	// biome-ignore lint: deliberate control chars — this is a terminal protocol scanner
	/\x1b\[(0?c|>[0-9;]*c|=[0-9;]*c|5n|6n|\?[0-9;]+\$p|>0?q|\?u|\?[0-9;]+[hl]|!p)|\x1b\](1[01];[^\x07\x1b]*)(?:\x07|\x1b\\)|\x1bc/g

interface Sink {
	live: string
	history: string
	replies: string[]
}

/** Dispositions for one matched sequence. Tasks 3–5 extend this switch. */
function handle(body: string | undefined, osc: string | undefined, whole: string, out: Sink, backend: 'tmux' | 'pty'): void {
	if (osc !== undefined) {
		out.live += whole // Task 4 replaces this branch
		out.history += whole
		return
	}
	if (body === undefined) {
		// bare \x1bc = RIS; Task 3 resets tracked modes. Pass through (it must
		// still reset the renderers).
		out.live += whole
		out.history += whole
		return
	}
	if (body === 'c' || body === '0c') {
		out.replies.push(CAPABILITY_PROFILE.da1)
		return // scrubbed
	}
	if (body.startsWith('>') && body.endsWith('c')) {
		out.replies.push(CAPABILITY_PROFILE.da2)
		return
	}
	if (body.startsWith('=') && body.endsWith('c')) return // DA3: scrub, no answer
	if (body === '5n') {
		out.replies.push(CAPABILITY_PROFILE.dsrOk)
		return
	}
	if (body === '6n') {
		// CPR — Task 5 makes this backend-dependent; until then scrub.
		if (backend === 'pty') {
			out.live += whole
			out.history += whole
		}
		return
	}
	if (body.endsWith('q')) return // XTVERSION: scrub, no answer
	if (body === '?u') return // kitty keyboard probe: scrub, no answer
	// DECRQM / DECSET / DECRST / DECSTR — Task 3 implements; pass through.
	out.live += whole
	out.history += whole
}

export function createQueryResponder(opts: { backend: 'tmux' | 'pty' }): QueryResponder {
	let carry = ''
	return {
		process(chunk: Uint8Array): ResponderResult {
			const s = carry + toLatin1(chunk)
			carry = '' // Task 5 implements real carry splitting
			const out: Sink = { live: '', history: '', replies: [] }
			let last = 0
			SEQ_RE.lastIndex = 0
			for (let m = SEQ_RE.exec(s); m !== null; m = SEQ_RE.exec(s)) {
				const plain = s.slice(last, m.index)
				out.live += plain
				out.history += plain
				handle(m[1], m[2], m[0], out, opts.backend)
				last = SEQ_RE.lastIndex
			}
			const tail = s.slice(last)
			out.live += tail
			out.history += tail
			return {
				live: fromLatin1(out.live),
				history: fromLatin1(out.history),
				replies: out.replies.map(fromLatin1),
			}
		},
		flush(): Uint8Array {
			const pending = carry
			carry = ''
			return fromLatin1(pending)
		},
	}
}
