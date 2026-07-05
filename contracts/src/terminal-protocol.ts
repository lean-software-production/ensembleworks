/**
 * The terminal WS wire protocol (browser ⇄ gateway/connector), formerly a
 * comment in server/src/terminal-gateway.ts. Terminal output travels as
 * BINARY frames (raw utf-8 bytes); everything below is the TEXT-frame
 * control channel. The remote connector (unified-architecture-design.md §6)
 * speaks exactly this protocol.
 *
 * Note: the relay plane (server/src/gateway-registry.ts,
 * `{type:'relay-open'|'relay-close'|'relay-msg'|'relay-closed'}`) wraps this
 * protocol's messages inside a `msg` field for gateway↔canvas transport; it
 * is a distinct message set and is intentionally NOT modelled here.
 */
import { z } from 'zod'

export const termClientMessage = z.discriminatedUnion('type', [
	z.object({ type: z.literal('input'), data: z.string() }),
	z.object({
		type: z.literal('resize'),
		// Loosened vs a naive `int().positive()`: terminal-gateway.ts's message
		// handler calls `Number(msg.cols)` / `Number(msg.rows)` before checking
		// `Number.isInteger`, so numeric strings are silently coerced today —
		// z.coerce replicates that. resizeSession() then clamps the result into
		// [20,500]x[5,200] regardless of sign or magnitude (so 0/negative/huge
		// values are accepted here and clamped downstream, not rejected). Only
		// non-numeric or non-integer values (floats, NaN, "abc") are rejected —
		// matching today's silent no-op for those.
		cols: z.coerce.number().int(),
		rows: z.coerce.number().int(),
	}),
])
export type TermClientMessage = z.infer<typeof termClientMessage>

export const termServerMessage = z.discriminatedUnion('type', [
	z.object({ type: z.literal('resize'), cols: z.number().int().positive(), rows: z.number().int().positive() }),
	z.object({ type: z.literal('exit') }),
	// Carries the session's current grid so a newly attached client sizes its
	// xterm before the scrollback replay paints (see terminal-gateway.ts's
	// upgrade handler).
	z.object({ type: z.literal('attached'), cols: z.number().int().positive(), rows: z.number().int().positive() }),
])
export type TermServerMessage = z.infer<typeof termServerMessage>
