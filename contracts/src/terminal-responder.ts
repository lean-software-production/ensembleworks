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

const MAX_CARRY = 64

/** Longest tail of s that could be the prefix of a recognisable sequence.
 *  Empty string when the tail is definitely ordinary output. */
function pendingPrefix(s: string): string {
	const esc = s.lastIndexOf('\x1b')
	if (esc === -1) return ''
	const tail = s.slice(esc)
	if (tail.length > MAX_CARRY) return ''
	// Could this still grow into a match? Candidate prefixes:
	//   \x1b            (could become CSI or OSC or RIS — but bare \x1bc
	//                    already matched; a lone trailing ESC must be held)
	//   \x1b[ + params  (no final byte yet)
	//   \x1b]1, \x1b]10, \x1b]11;payload (no BEL/ST yet), incl. trailing \x1b
	//   of an unfinished ST
	// biome-ignore lint: control chars deliberate
	const partial = /^\x1b$|^\x1b\[[0-9;?>=!$]*$|^\x1b\](?:1[01]?)?$|^\x1b\]1[01];[^\x07\x1b]*\x1b?$/
	return partial.test(tail) ? tail : ''
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

class ResponderState {
	modes: Map<number, 0 | 1 | 2>

	constructor() {
		this.modes = new Map(Object.entries(CAPABILITY_PROFILE.modes).map(([k, v]) => [Number(k), v]))
	}

	reset(): void {
		for (const m of TRACKED_MODES) this.modes.set(m, 2)
	}

	decrqmReply(mode: number): string {
		const state = this.modes.get(mode) ?? 0
		return `\x1b[?${mode};${state}$y`
	}

	/** DECSET/DECRST: update tracked bits; return the sequence to forward
	 *  with ?1004 removed (empty string when 1004 was the only mode). */
	modeSequence(body: string): string {
		const set = body.endsWith('h')
		const params = body.slice(1, -1).split(';').map(Number)
		for (const p of params) {
			if ((TRACKED_MODES as readonly number[]).includes(p)) this.modes.set(p, set ? 1 : 2)
		}
		const kept = params.filter((p) => p !== 1004)
		if (kept.length === 0) return ''
		return `\x1b[?${kept.join(';')}${set ? 'h' : 'l'}`
	}
}

/** Dispositions for one matched sequence. Tasks 3–5 extend this switch. */
function handle(body: string | undefined, osc: string | undefined, whole: string, out: Sink, state: ResponderState, backend: 'tmux' | 'pty'): void {
	if (osc !== undefined) {
		// osc = "10;<payload>" or "11;<payload>" (regex group excludes terminator)
		const ps = Number(osc.slice(0, 2)) as 10 | 11
		const payload = osc.slice(3)
		if (payload === '?') {
			out.replies.push(oscColorReply(ps))
			return // scrubbed
		}
		out.live += whole // setter: renderers must apply it
		out.history += whole
		return
	}
	if (body === undefined) {
		// bare \x1bc = RIS; Task 3 resets tracked modes. Pass through (it must
		// still reset the renderers).
		state.reset()
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
	if (body.startsWith('?') && body.endsWith('$p')) {
		out.replies.push(state.decrqmReply(Number(body.slice(1, -2))))
		return // scrubbed
	}
	if (body.startsWith('?') && (body.endsWith('h') || body.endsWith('l'))) {
		const fwd = state.modeSequence(body)
		out.live += fwd
		out.history += fwd
		return
	}
	if (body === '!p') {
		state.reset() // DECSTR
		out.live += whole
		out.history += whole
		return
	}
	// unreachable for matched bodies; keep pass-through as safety
	out.live += whole
	out.history += whole
}

export function createQueryResponder(opts: { backend: 'tmux' | 'pty' }): QueryResponder {
	let carry = ''
	const state = new ResponderState()
	return {
		process(chunk: Uint8Array): ResponderResult {
			const s = carry + toLatin1(chunk)
			const hold = pendingPrefix(s)
			carry = hold
			const scan = hold ? s.slice(0, s.length - hold.length) : s
			const out: Sink = { live: '', history: '', replies: [] }
			let last = 0
			SEQ_RE.lastIndex = 0
			for (let m = SEQ_RE.exec(scan); m !== null; m = SEQ_RE.exec(scan)) {
				const plain = scan.slice(last, m.index)
				out.live += plain
				out.history += plain
				handle(m[1], m[2], m[0], out, state, opts.backend)
				last = SEQ_RE.lastIndex
			}
			const tail = scan.slice(last)
			out.live += tail
			out.history += tail
			return {
				live: fromLatin1(out.live),
				history: fromLatin1(out.history),
				replies: out.replies.map(fromLatin1),
			}
		},
		flush(reason: 'attach' | 'snapshot' | 'exit'): Uint8Array {
			const pending = carry
			carry = ''
			return fromLatin1(pending)
		},
	}
}
