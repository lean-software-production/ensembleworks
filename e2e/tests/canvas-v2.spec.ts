// Drives every Agent API v2 read endpoint against the real server (:8788). Pure
// HTTP — the read side needs no browser. This is the "untyped consumers" watchdog.
//
// BELOW that (Task H2, phase-3 plan): the NEW-ENGINE dogfood browser E2E —
// completely unrelated to the "Agent API v2" read endpoints above (same "v2"
// word, two disjoint features: that's `/api/v2/canvas/*`, a versioned tldraw-
// store read API; this is `/sync/v2/:roomId`, the new canvas-editor/
// canvas-react engine's live WS protocol, gated on EW_CANVAS_SYNC=1 —
// scripts/start-server.ts turns that flag on by default for this whole e2e
// rig, additively, so it changes nothing about the tests above). Every case
// below navigates with `?engine=v2` (client/src/engine.ts's URL override) on
// a room id that is NEVER `'team'` (the ratified Q1 hard exclusion — see
// engine.ts's module header) — dogfood rooms only, real pointer/keyboard
// events, real WS sync through a real DocumentActor.
import { test, expect, API, identityState } from '../lib/fixtures'
import { shape } from '../lib/seed'

// ============================================================================
// Failure artifact (design's C9 session-replay idea, HONEST v1 SCOPE): the
// SessionRecorder (canvas-editor/src/replay.ts) is NOT wired into
// CanvasV2App — doing so is a documented Phase-4 nicety (full input-replay
// capture), not this unit's job. What we CAN do cheaply, on any test in this
// file that fails: dump the primary `page` fixture's own
// `window.__ew.doc.exportSnapshot()` bytes (base64, so they survive
// Playwright's JSON-based evaluate() return channel) plus the editor's
// current EditorState as a test-info attachment — a point-in-time snapshot
// of what client A's doc/editor looked like at the moment of failure, not a
// replayable event log. Multi-context cases construct extra pages (pageB)
// inside the test body itself; this hook only ever sees the `page` fixture,
// so a B-side-only failure won't have its own dump — an honest limitation,
// not an oversight (see the module comment above re: C9 deferral).
test.afterEach(async ({ page }, testInfo) => {
	if (testInfo.status === testInfo.expectedStatus) return
	const dump = await page
		.evaluate(() => {
			const ew = (window as unknown as { __ew?: { editor: { get(): unknown }; doc: { exportSnapshot(): Uint8Array } } }).__ew
			if (!ew) return null
			const bytes = ew.doc.exportSnapshot()
			let binary = ''
			for (const b of bytes) binary += String.fromCharCode(b)
			const state = ew.editor.get() as { camera: unknown; selection: Set<string>; hover: string | null; editingId: string | null }
			return {
				snapshotBase64: btoa(binary),
				editorState: { camera: state.camera, selection: [...state.selection], hover: state.hover, editingId: state.editingId },
			}
		})
		.catch(() => null) // window.__ew may never have existed (e.g. the failure happened before the v2 session ever booted) — omit, don't fail the attach
	if (dump) {
		await testInfo.attach('canvas-v2-session-dump.json', {
			body: JSON.stringify(dump, null, 2),
			contentType: 'application/json',
		})
	}
})

const get = (p: string) => fetch(`${API}${p}`).then(async (r) => ({ status: r.status, body: (await r.json()) as any }))

test('canvas-v2 read endpoints serve the new model', async () => {
	const room = 'v2-smoke'
	await shape(room, { type: 'frame', name: 'Planning', x: 0, y: 0, w: 1000, h: 800 })
	for (const [i, t] of ['alpha', 'beta', 'gamma'].entries())
		await shape(room, { type: 'note', frame: 'Planning', x: 20, y: 20 + i * 120, text: t, color: 'yellow' })
	await shape(room, { type: 'note', frame: 'Planning', x: 800, y: 700, text: 'lonely', color: 'blue' })

	const doc = await get(`/api/v2/canvas/document?room=${room}`)
	expect(doc.status).toBe(200)
	expect(doc.body.model).toBe(2)
	expect(doc.body.shapes.length).toBe(5)

	const frames = await get(`/api/v2/canvas/frames?room=${room}`)
	expect(frames.body.frames[0].name).toBe('Planning')
	expect(frames.body.frames[0].notes).toBe(4)

	const frame = await get(`/api/v2/canvas/frame?room=${room}&name=plan`)
	expect(frame.status).toBe(200)
	expect(frame.body.members.length).toBe(4)

	const sem = await get(`/api/v2/canvas/semantic?room=${room}&frame=plan`)
	expect(sem.status).toBe(200)
	expect(sem.body.clusters.length).toBeGreaterThanOrEqual(1)
	expect(sem.body.outliers.length).toBeGreaterThanOrEqual(1)

	const aNote = doc.body.shapes.find((s: any) => s.kind === 'note')
	const near = await get(`/api/v2/canvas/neighbors?room=${room}&id=${encodeURIComponent(aNote.id)}&radius=300`)
	expect(near.status).toBe(200)
	expect(Array.isArray(near.body.neighbors)).toBe(true)
})

// ============================================================================
// NEW-ENGINE DOGFOOD E2E (Task H2) — real browser, real WS sync, never `team`.
// ============================================================================

// Every note this file creates starts at this SCREEN point relative to
// `[data-canvas-v2-viewport]`'s own bounding box — dom-events.ts's COORDINATES
// note: canvas-react's screen space is VIEWPORT-relative (subtracts the
// viewport element's own getBoundingClientRect()), and the Editor's camera
// starts at the fixed default `{x:0, y:0, z:1}` (canvas-editor/src/editor.ts)
// for a fresh session — an identity transform — so this screen point IS the
// note's world position too, with no camera math needed to predict it.
const ANCHOR = { x: 300, y: 220 } as const

async function viewportBox(page: import('@playwright/test').Page) {
	const box = await page.locator('[data-canvas-v2-viewport]').boundingBox()
	if (!box) throw new Error('[data-canvas-v2-viewport] has no bounding box — did the v2 session fail to boot?')
	return box
}

/** Waits for the v2 session to boot (toolbar visible == window.__ew is set —
 * CanvasV2Session, which renders the toolbar, only mounts once CanvasV2App's
 * boot() has already called `setSession`, and `window.__ew` is assigned
 * synchronously just before that same call — see CanvasV2App.tsx's
 * CONSTRUCTION SEQUENCE step 7). */
async function waitForBoot(page: import('@playwright/test').Page) {
	await expect(page.locator('[data-canvas-v2-tool="select"]')).toBeVisible({ timeout: 15_000 })
}

/** Click the `note` tool, then click ANCHOR (viewport-relative) to
 * click-create a note (canvas-editor/src/tools/create.ts: a sub-threshold
 * click, not a drag, centers a default-size shape ON the click point), then
 * switch back to the `select` tool (so a later drag/double-click in the same
 * test can pick it up — the note tool stays active after a click-create
 * otherwise, tool-loop.ts's TOOL-SWITCHING MODEL). Returns the created
 * shape's id (read off the rendered `data-shape-id`, not guessed). */
async function createNoteAt(page: import('@playwright/test').Page, box: { x: number; y: number }): Promise<string> {
	await page.locator('[data-canvas-v2-tool="note"]').click()
	await page.mouse.click(box.x + ANCHOR.x, box.y + ANCHOR.y)
	await page.locator('[data-canvas-v2-tool="select"]').click()
	const shape = page.locator('[data-shape-kind="note"]')
	await expect(shape).toBeVisible({ timeout: 10_000 })
	const id = await shape.getAttribute('data-shape-id')
	if (!id) throw new Error('created note has no data-shape-id')
	return id
}

test('canvas-v2 new engine: single client creates a note via real pointer events — DOM and doc state agree', async ({ page }) => {
	const room = 'v2-e2e-single'
	await page.goto(`/?room=${room}&engine=v2`)
	await waitForBoot(page)
	const box = await viewportBox(page)

	const shapeId = await createNoteAt(page, box)

	// DOM: exactly one rendered note, at the id we read off the click-created
	// element (data-shape-id / data-shape-kind — ShapeBody.tsx). Scoped to
	// `[data-shape-kind]` specifically (not bare `[data-shape-id]`): the
	// Selection overlay's outline ALSO carries the selected shape's
	// `data-shape-id` (overlay/Selection.tsx) — this note IS selected right
	// after creation (create.ts's finalizeIntents always emits SetSelection
	// alongside CreateShape) — so a bare `[data-shape-id]` query would match
	// BOTH the shape body div and its selection-outline polygon.
	await expect(page.locator('[data-shape-id][data-shape-kind]')).toHaveCount(1)
	await expect(page.locator(`[data-shape-id="${shapeId}"][data-shape-kind="note"]`)).toBeVisible()

	// Doc state: window.__ew.editor/doc (the design's E2E hook,
	// CanvasV2App.tsx's CONSTRUCTION SEQUENCE step 7) agrees with the DOM —
	// exactly one shape in the CRDT, of kind note, with that exact id, and
	// selected (create.ts's finalizeIntents always emits SetSelection([shape.id])
	// alongside CreateShape).
	const state = await page.evaluate((id) => {
		const ew = (window as any).__ew
		const shapes = ew.doc.listShapes()
		return { count: shapes.length, kinds: shapes.map((s: any) => s.kind), selection: [...ew.editor.get().selection], hasId: shapes.some((s: any) => s.id === id) }
	}, shapeId)
	expect(state.count).toBe(1)
	expect(state.kinds).toEqual(['note'])
	expect(state.hasId).toBe(true)
	expect(state.selection).toEqual([shapeId])
})

test('canvas-v2 new engine: multi-client render convergence — B\'s rendered DOM converges to A\'s drag, and A\'s presence cursor is visible in B\'s overlay', async ({ page, browser }) => {
	test.setTimeout(60_000)
	const room = 'v2-e2e-multi'
	expect(room).not.toBe('team') // the spec's own rooms must never be `team` — see the module header

	await page.goto(`/?room=${room}&engine=v2`)
	await waitForBoot(page)
	const boxA = await viewportBox(page)

	const ctxB = await browser.newContext({
		storageState: identityState('E2E Two', 'e2e-user-0000-0000-0002'),
		viewport: { width: 1280, height: 720 },
	})
	try {
		const pageB = await ctxB.newPage()
		pageB.on('dialog', (d) => {
			throw new Error(`unexpected dialog (identity fixture broken?): ${d.message()}`)
		})
		await pageB.goto(`/?room=${room}&engine=v2`)
		await waitForBoot(pageB)

		// A creates a note through a real click; B must see it appear (create
		// convergence) before this test drives the drag that's the real point.
		const shapeId = await createNoteAt(page, boxA)
		const shapeB = pageB.locator(`[data-shape-id="${shapeId}"]`)
		await expect(shapeB).toBeVisible({ timeout: 10_000 })

		// Drag A's note from ANCHOR to a new point — a real pointer sequence
		// (down, several intermediate moves crossing DRAG_THRESHOLD, up), not a
		// single teleporting move, so this exercises the SAME per-pointermove
		// commit cadence a real user's drag would (tools/select.ts's Dragging
		// state / the H3 COMMIT CADENCE watch-item).
		const start = { x: boxA.x + ANCHOR.x, y: boxA.y + ANCHOR.y }
		const delta = { x: 220, y: 180 }
		const end = { x: start.x + delta.x, y: start.y + delta.y }
		await page.mouse.move(start.x, start.y)
		await page.mouse.down()
		await page.mouse.move(start.x + delta.x / 2, start.y + delta.y / 2, { steps: 4 })
		await page.mouse.move(end.x, end.y, { steps: 4 })
		await page.mouse.up()

		// A's OWN doc reflects the translated shape (sanity anchor for the
		// cross-client assertion below — if this fails, the drag itself never
		// landed, and the B-side convergence assertion would be meaningless).
		await expect
			.poll(
				async () =>
					page.evaluate((id) => {
						const ew = (window as any).__ew
						const s = ew.doc.getShape(id)
						return s ? { x: s.x, y: s.y } : null
					}, shapeId),
				{ timeout: 10_000 },
			)
			.toMatchObject({ x: expect.closeTo(ANCHOR.x - 100 + delta.x, 0), y: expect.closeTo(ANCHOR.y - 100 + delta.y, 0) })
		// (ANCHOR - 100: create.ts centers a 200x200 note ON the click point, so
		// its top-left x/y is ANCHOR - w/2 == ANCHOR - 100 before any drag.)

		// B's RENDERED DOM (not just its doc) converges to the new position —
		// the design's "convergence of what is rendered", not merely "the CRDT
		// merged". Read via the rendered element's own bounding box, converted
		// to viewport-relative coordinates the same way ANCHOR is defined.
		const boxB = await viewportBox(pageB)
		await expect
			.poll(
				async () => {
					const rect = await shapeB.boundingBox()
					if (!rect) return null
					return { x: Math.round(rect.x - boxB.x), y: Math.round(rect.y - boxB.y) }
				},
				{ timeout: 10_000 },
			)
			.toMatchObject({ x: expect.closeTo(ANCHOR.x - 100 + delta.x, 0), y: expect.closeTo(ANCHOR.y - 100 + delta.y, 0) })

		// Presence (design's D6/G4): A's cursor (last pointer position = `end`,
		// published via CanvasV2App's pointermove -> presencePublisher wiring)
		// is visible in B's overlay, keyed by A's identity (the default `page`
		// fixture's storageState — lib/fixtures.ts — sets userId
		// 'e2e-user-0000-0000-0001', the SAME string CanvasV2App uses as both
		// the presence map key and the WS ?userId= — see presence.ts/
		// CanvasV2App.tsx's Session.selfKey doc comment).
		const aCursorInB = pageB.locator('[data-overlay="cursor"][data-presence-key="e2e-user-0000-0000-0001"]')
		await expect(aCursorInB).toBeVisible({ timeout: 10_000 })
	} finally {
		await ctxB.close()
	}
})

test('canvas-v2 new engine: the editing loop — double-click to edit, type, Escape lands in A\'s doc and renders in B', async ({ page, browser }) => {
	test.setTimeout(60_000)
	const room = 'v2-e2e-edit'
	expect(room).not.toBe('team')

	await page.goto(`/?room=${room}&engine=v2`)
	await waitForBoot(page)
	const boxA = await viewportBox(page)

	const ctxB = await browser.newContext({
		storageState: identityState('E2E Two', 'e2e-user-0000-0000-0002'),
		viewport: { width: 1280, height: 720 },
	})
	try {
		const pageB = await ctxB.newPage()
		pageB.on('dialog', (d) => {
			throw new Error(`unexpected dialog (identity fixture broken?): ${d.message()}`)
		})
		await pageB.goto(`/?room=${room}&engine=v2`)
		await waitForBoot(pageB)

		const shapeId = await createNoteAt(page, boxA)
		const shapeB = pageB.locator(`[data-shape-id="${shapeId}"]`)
		await expect(shapeB).toBeVisible({ timeout: 10_000 })

		// DOUBLE-CLICK TO EDIT: TWO separate completed clicks on the SAME
		// target within canvas-editor/src/input.ts's DOUBLE_CLICK_MS (450ms) /
		// DOUBLE_CLICK_RADIUS_PX (40px) — select.ts's DOUBLE-CLICK-TO-EDIT FSM
		// logic, NOT a native browser 'dblclick' event (Viewport.tsx never
		// listens for one). Two back-to-back Playwright mouse.click() calls at
		// the same point comfortably land inside both windows.
		const anchor = { x: boxA.x + ANCHOR.x, y: boxA.y + ANCHOR.y }
		await page.mouse.click(anchor.x, anchor.y)
		await page.mouse.click(anchor.x, anchor.y)

		const textareaA = page.locator(`[data-text-editor-input="${shapeId}"]`)
		await expect(textareaA).toBeVisible({ timeout: 5_000 })
		await textareaA.fill('hello from A')
		await page.keyboard.press('Escape') // TextEditor.tsx's handleEditorKeyDown -> onEndEdit

		await expect(textareaA).toBeHidden({ timeout: 5_000 }) // EndEdit unmounts TextEditor (editingId back to null)

		// A's OWN doc: SetText actually landed in the CRDT (editor.doc.getText —
		// the same accessor TextEditor.tsx's controlled value reads).
		await expect
			.poll(async () => page.evaluate((id) => (window as any).__ew.doc.getText(id), shapeId), { timeout: 5_000 })
			.toBe('hello from A')

		// Renders in client B: closes the review gap this case is named for.
		// Until the canvas-react fix landed alongside this test (ShapeLayer
		// threading editor.doc.getText into BoxShape's labelOf — see that
		// commit), NOTHING ever rendered a SetText edit outside the editing
		// textarea itself, on ANY client — this assertion is what actually
		// proves "SetText through the whole stack" the task names, not just
		// "the bytes arrived."
		await expect(shapeB).toContainText('hello from A', { timeout: 10_000 })

		// And, for completeness, A's OWN rendered body also reflects it (the
		// SAME gap applied locally too, not just cross-client — see the fix
		// commit's message). Scoped to `[data-shape-kind]` — see the earlier
		// case's comment on why a bare `[data-shape-id]` query on A (whose
		// note stays selected the whole time — BeginEdit/EndEdit never touch
		// selection) would also match the Selection overlay's outline.
		await expect(page.locator(`[data-shape-id="${shapeId}"][data-shape-kind]`)).toContainText('hello from A')
	} finally {
		await ctxB.close()
	}
})
