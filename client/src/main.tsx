import React, { Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { getRoomId } from './identity'
import { selectEngineFromEnvironment } from './engine'

/**
 * ZERO EXPOSURE (the paramount Phase-3 constraint — see engine.ts's module
 * header for the ratified Q1 amendment `selectEngineFromEnvironment` reads):
 * the ENTIRE v2 module graph (CanvasV2App -> canvas-editor/canvas-react ->
 * canvas-doc/canvas-sync -> loro-crdt's WASM) sits behind a `React.lazy()`
 * DYNAMIC import, reached through exactly ONE branch below. `lazy()`'s
 * factory function is not invoked at module-eval time — React only calls it
 * the first time the lazy component is actually RENDERED — so a room that
 * resolves to `'tldraw'` (every room today, including `team`, which is
 * HARD-EXCLUDED regardless of configuration) never even issues the
 * `import()` network request for the v2 chunk, let alone executes it. The
 * `team` room's render path is therefore BYTE-IDENTICAL to before this
 * branch existed: `<App/>`, unconditionally, with nothing new evaluated
 * ahead of it.
 *
 * Task G6's exposure audit (a later unit) greps this exact file for the
 * `CanvasV2App`/`selectEngine` pairing — see the plan's
 * scripts/exposure-audit.ts sketch (docs/plans/2026-07-12-canvas-phase3-
 * editor-renderer.md) — so keep both identifiers literally present here,
 * not aliased away.
 */
const CanvasV2App = lazy(() => import('./canvas-v2/CanvasV2App').then((m) => ({ default: m.CanvasV2App })))

const engine = selectEngineFromEnvironment(getRoomId())

createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		{engine === 'v2' ? (
			<Suspense fallback={null}>
				<CanvasV2App />
			</Suspense>
		) : (
			<App />
		)}
	</React.StrictMode>
)
