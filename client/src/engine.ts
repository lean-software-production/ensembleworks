/**
 * The per-room canvas engine selector — the gate ZERO EXPOSURE runs through.
 * `selectEngine` is a PURE function of `(roomId, opts)`; the injectable
 * `{ allowlist, engineParam }` seam is what makes it deterministically
 * testable (no `import.meta.env`/URL read inside the function itself).
 * `selectEngineFromEnvironment` is the thin production wrapper that supplies
 * those two inputs from the real build-time env var and the real URL, and is
 * the ONLY call site `main.tsx` ever uses.
 *
 * RATIFIED Q1 AMENDMENT (phase-3 plan, docs/plans/2026-07-12-canvas-phase3-
 * editor-renderer.md, "Ratification" section): the `team` room is
 * HARD-EXCLUDED — checked FIRST, before the allowlist or the URL override are
 * even consulted, so it resolves to `'tldraw'` UNCONDITIONALLY. The room the
 * whole team lives in must be unreachable by construction (a misconfigured
 * `VITE_CANVAS_V2_ROOMS=team` or a stray `?engine=v2` on a shared link), not
 * merely by configuration discipline elsewhere. See engine.test.ts's
 * `selectEngine('team', { allowlist: ['team'], engineParam: 'v2' }) ===
 * 'tldraw'` case — the exact assertion the ratification names.
 *
 * Otherwise: `'v2'` iff the room id is in `allowlist` OR `engineParam ===
 * 'v2'`; else `'tldraw'`. Every unlisted room (including one that merely
 * looks like a dogfood name) defaults to tldraw — allowlist membership is an
 * explicit opt-in, never inferred from the id's shape.
 */
export type Engine = 'tldraw' | 'v2'

export interface SelectEngineOpts {
	/** Room ids allowed onto the v2 engine — comma-split from
	 * `VITE_CANVAS_V2_ROOMS` in production; a plain array in tests. */
	readonly allowlist: readonly string[]
	/** The `?engine=` URL param's value, or `null` if absent/different. Only
	 * the exact string `'v2'` has any effect — any other value (including
	 * `'tldraw'` or garbage) is treated the same as absent. */
	readonly engineParam: string | null
}

/** The one room id that can NEVER resolve to `'v2'` — see the module header's
 * RATIFIED Q1 AMENDMENT. Exported so engine.test.ts and the repo-level
 * exposure audit (Task G6) can both cite the identical literal instead of
 * duplicating the string. */
export const TEAM_ROOM_ID = 'team'

/** Pure. See the module header for the full decision table. */
export function selectEngine(roomId: string, opts: SelectEngineOpts): Engine {
	// HARD EXCLUSION — checked FIRST and unconditionally: no allowlist entry
	// or URL override past this point can ever flip `team` to v2.
	if (roomId === TEAM_ROOM_ID) return 'tldraw'
	if (opts.allowlist.includes(roomId)) return 'v2'
	if (opts.engineParam === 'v2') return 'v2'
	return 'tldraw'
}

/** Split `VITE_CANVAS_V2_ROOMS` (a comma-separated list, e.g.
 * `"dogfood,design-review"`) into a trimmed, non-empty allowlist. Pure — no
 * env read here; `selectEngineFromEnvironment` passes the raw string in.
 * Tolerant of the empty/undefined/garbage cases a real deployment's env can
 * produce: `undefined` (var unset), `""` (var set empty), and stray
 * whitespace/empty segments from a trailing comma (`"a,,b"` / `"a, b,"`) all
 * collapse to sensible results rather than producing an allowlist entry that
 * is itself an empty string (which would be harmless in practice — no real
 * roomId is ever `""` — but is exactly the kind of silent garbage this
 * function exists to filter before it reaches `selectEngine`). */
export function parseAllowlist(raw: string | undefined): string[] {
	if (!raw) return []
	return raw
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
}

/** Production wrapper: reads the real build-time env var
 * (`import.meta.env.VITE_CANVAS_V2_ROOMS`) and the real URL's `?engine=`
 * param, then delegates to the pure `selectEngine`. This is the ONLY call
 * site `main.tsx`/`App.tsx` may use — see engine.test.ts's exposure-audit-
 * style assertion and Task G6's repo-level script for the enforcement. */
export function selectEngineFromEnvironment(roomId: string): Engine {
	const allowlist = parseAllowlist(import.meta.env.VITE_CANVAS_V2_ROOMS as string | undefined)
	const engineParam = new URLSearchParams(location.search).get('engine')
	return selectEngine(roomId, { allowlist, engineParam })
}
