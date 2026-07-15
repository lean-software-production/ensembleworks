/**
 * The component-golden harness (Task G2) — turns one `Fixture` (fixtures.ts /
 * shape-fixtures.ts) into a REAL, but entirely OFFLINE, canvas-v2 render:
 * an in-memory `LoroCanvasDoc` (no SyncClientPeer, no WebSocket, no server
 * dependency of any kind for the doc/sync layer itself), a real `Editor` +
 * `ToolContext`, and the SAME canvas-react composition CanvasV2App.tsx uses
 * (Viewport -> Grid + WorldLayer{ShapeLayer, EmbedLayer} -> Overlay ->
 * Cursors) — so what a Playwright screenshot captures here is the real
 * renderer, not a stand-in.
 *
 * NOT a CanvasV2App clone: no `connect()`, no `SyncClientPeer`, no
 * `PresenceStore`, no dev overlay, no toolbar, no tool dispatch (there is
 * nothing to interact with — a golden is a single static screenshot of a
 * fixed scene). `window.__ewGolden = { editor }` is this harness's OWN debug
 * hook (deliberately a DIFFERENT name than `window.__ew`, so a golden-harness
 * page can never be mistaken for a real dogfood mount by an E2E script that
 * checks for `window.__ew`).
 */
import { useMemo, useState } from 'react'
import { Editor, createToolContext } from '@ensembleworks/canvas-editor'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import {
	Cursors,
	EmbedLayer,
	Grid,
	Overlay,
	ShapeLayer,
	Viewport,
	WorldLayer,
	useDocSnapshot,
	useEditorState,
	type ViewportSize,
} from '@ensembleworks/canvas-react'
import { registerCanvasV2Shapes, canvasV2EmbedLifecycles } from '../shapes/index.js'
import { PAGE_ID, type Fixture } from './fixtures.js'

export interface GoldenHarnessProps {
	readonly fixture: Fixture
}

export function GoldenHarness({ fixture }: GoldenHarnessProps) {
	// Matches the REAL browser viewport (e.g. Playwright's configured
	// 1280x720 — e2e/playwright.config.ts) rather than a hardcoded guess, so
	// ShapeLayer/Overlay's viewport-culling math agrees with what actually
	// gets painted. No resize handling: a golden is one static screenshot per
	// page load, never resized mid-capture.
	const [viewportSize] = useState<ViewportSize>(() => ({ width: window.innerWidth, height: window.innerHeight }))
	// Built ONCE per fixture (keyed by fixture.name via the parent's `key` —
	// see main.tsx), not per render: a fresh doc/editor/toolContext every
	// render would defeat useDocSnapshot/useEditorState's subscription model
	// for no benefit (this harness never mutates anything after setup).
	const session = useMemo(() => {
		registerCanvasV2Shapes()
		const doc = LoroCanvasDoc.create({ peerId: 1n })
		doc.putPage({ id: PAGE_ID, name: 'Goldens' })
		for (const shape of fixture.shapes) doc.putShape(shape)
		doc.commit()
		const editor = new Editor({ doc, now: () => 0, random: () => 0.5, pageId: PAGE_ID })
		if (fixture.camera) editor.apply({ type: 'SetCamera', ...fixture.camera })
		if (fixture.selection) editor.apply({ type: 'SetSelection', ids: [...fixture.selection] })
		const toolContext = createToolContext(editor)
		;(window as unknown as { __ewGolden?: { editor: Editor } }).__ewGolden = { editor }
		return { doc, editor, toolContext }
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [fixture.name])

	const { editor, toolContext } = session
	const editorState = useEditorState(editor)
	const snapshot = useDocSnapshot(toolContext)

	return (
		<div data-golden-fixture={fixture.name} style={{ position: 'fixed', inset: 0, background: '#fafaf7' }}>
			<Viewport onInput={() => {}} style={{ position: 'absolute', inset: 0 }}>
				<Grid camera={editorState.camera} />
				<WorldLayer camera={editorState.camera}>
					<ShapeLayer toolContext={toolContext} camera={editorState.camera} viewportSize={viewportSize} />
					<EmbedLayer
						toolContext={toolContext}
						camera={editorState.camera}
						viewportSize={viewportSize}
						tick={0}
						suspendAfterTicks={Number.POSITIVE_INFINITY}
						lifecycleFor={canvasV2EmbedLifecycles.lifecycleFor}
					/>
				</WorldLayer>
				<Overlay
					editorState={editorState}
					snapshot={snapshot}
					camera={editorState.camera}
					viewportSize={viewportSize}
					index={toolContext.index()}
					snapResult={undefined}
				/>
				{fixture.presence && (
					<Cursors presence={fixture.presence} selfKey={fixture.selfKey ?? 'self'} camera={editorState.camera} viewportSize={viewportSize} />
				)}
			</Viewport>
		</div>
	)
}
