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
import { ANCHOR, createNoteAt, seedFileViewer, seedTerminal, setCameraZoom, viewportBox, waitForBoot } from '../lib/canvas-v2'
import type { Page } from '@playwright/test'

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
// Shared boot/anchor/create helpers live in ../lib/canvas-v2.ts — the browser
// perf rig (perf/canvas-v2-perf.spec.ts, Task H3) reuses the SAME helpers.
// ============================================================================

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

// ============================================================================
// TASK B6 — E2E burn-down of B1 (undo/redo)/B2 (delete)/B3 (Escape/blur/
// pointercancel abandonment)/B4 (Ctrl+Z/Ctrl+Shift+Z/Ctrl+Y)/B5 (transform-
// cancel revert) in a real two-client browser session over /sync/v2. Reuses
// the SAME helpers (createNoteAt/viewportBox/waitForBoot/ANCHOR) and the same
// two-context multiplayer pattern the H2 cases above established.
//
// FOCUS NOTE (the B3 toolbar-focus nuance): CanvasV2App.tsx's toolbar buttons
// are DOM SIBLINGS of the viewport, not descendants — clicking one leaves
// keyboard focus on the BUTTON, not the viewport. `createNoteAt`'s own last
// step clicks the 'select' toolbar button, so every case below that needs a
// keydown to land via a REAL selection (not just the app's document-level
// keydown fallback) clicks the shape itself first — a canvas click both
// selects the shape (select.ts's onIdle pointerdown->pointerup) AND moves
// focus onto the viewport's own focusable div (a real click on/inside a
// tabIndex=0 element focuses it in a real browser), matching how a real user
// would actually select-then-delete.
// ============================================================================

test('canvas-v2 new engine: delete — Delete/Backspace remove a selected shape for both clients; Delete during text-editing does not delete it', async ({ page, browser }) => {
	test.setTimeout(60_000)
	const room = 'v2-e2e-delete'
	expect(room).not.toBe('team')

	await page.goto(`/?room=${room}&engine=v2`)
	await waitForBoot(page)
	const boxA = await viewportBox(page)
	const anchor = { x: boxA.x + ANCHOR.x, y: boxA.y + ANCHOR.y }

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

		// --- Delete key: create, select (click focuses the viewport too), Delete ---
		const id1 = await createNoteAt(page, boxA)
		const shapeB1 = pageB.locator(`[data-shape-id="${id1}"]`)
		await expect(shapeB1).toBeVisible({ timeout: 10_000 })

		await page.mouse.click(anchor.x, anchor.y) // select.ts's onIdle: a completed click on the note -> SetSelection([id1])
		await expect
			.poll(() => page.evaluate(() => [...(window as any).__ew.editor.get().selection]))
			.toEqual([id1])
		await page.keyboard.press('Delete')

		await expect(page.locator(`[data-shape-id="${id1}"]`)).toHaveCount(0)
		await expect.poll(() => page.evaluate((id) => !!(window as any).__ew.doc.getShape(id), id1)).toBe(false)
		// B convergence: DeleteShapes is a real doc mutation, ships over the wire like any other.
		await expect(shapeB1).toHaveCount(0, { timeout: 10_000 })
		await expect
			.poll(() => pageB.evaluate((id) => !!(window as any).__ew.doc.getShape(id), id1), { timeout: 10_000 })
			.toBe(false)

		// --- Backspace key: same shape, same convergence, the OTHER app-global key ---
		const id2 = await createNoteAt(page, boxA)
		const shapeB2 = pageB.locator(`[data-shape-id="${id2}"]`)
		await expect(shapeB2).toBeVisible({ timeout: 10_000 })

		await page.mouse.click(anchor.x, anchor.y)
		await expect
			.poll(() => page.evaluate(() => [...(window as any).__ew.editor.get().selection]))
			.toEqual([id2])
		await page.keyboard.press('Backspace')

		await expect(page.locator(`[data-shape-id="${id2}"]`)).toHaveCount(0)
		await expect(shapeB2).toHaveCount(0, { timeout: 10_000 })

		// --- Delete while the shape is being TEXT-EDITED must NOT delete it ---
		// (handleGlobalShortcut's `editingId !== null` gate — CanvasV2App.tsx —
		// defers Delete/Backspace to TextEditor's own textarea, which only
		// edits characters and never deletes the shape.)
		const id3 = await createNoteAt(page, boxA)
		await expect(pageB.locator(`[data-shape-id="${id3}"]`)).toBeVisible({ timeout: 10_000 })

		// TWO completed clicks at the same point within DOUBLE_CLICK_MS/RADIUS
		// (input.ts) -> select.ts's double-click-to-edit -> BeginEdit (same
		// pattern the editing-loop case above uses; NOT a native 'dblclick').
		await page.mouse.click(anchor.x, anchor.y)
		await page.mouse.click(anchor.x, anchor.y)
		const textareaA = page.locator(`[data-text-editor-input="${id3}"]`)
		await expect(textareaA).toBeVisible({ timeout: 5_000 })

		await page.keyboard.press('Delete') // edits the (empty) textarea content, not the shape
		// `[data-shape-kind]` (not a bare `[data-shape-id]`): the note stays
		// SELECTED through the whole edit (BeginEdit/EndEdit never touch
		// selection — same as the editing-loop case above), so a bare id query
		// would ALSO match the selection overlay's own outline element, which
		// carries the identical data-shape-id.
		await expect(page.locator(`[data-shape-id="${id3}"][data-shape-kind]`)).toHaveCount(1) // still there, mid-edit
		await expect.poll(() => page.evaluate((id) => !!(window as any).__ew.doc.getShape(id), id3)).toBe(true)

		await page.keyboard.press('Escape') // TextEditor's own Escape -> onEndEdit (editingId back to null)
		await expect(textareaA).toBeHidden({ timeout: 5_000 })
		await expect(page.locator(`[data-shape-id="${id3}"][data-shape-kind]`)).toHaveCount(1)
		await expect.poll(() => page.evaluate((id) => !!(window as any).__ew.doc.getShape(id), id3)).toBe(true)
		await expect(pageB.locator(`[data-shape-id="${id3}"]`)).toBeVisible() // B never saw it disappear either
	} finally {
		await ctxB.close()
	}
})

test('canvas-v2 new engine: undo — Ctrl+Z fully restores a deleted shape (single-intent op); a multi-step drag needs ONE Ctrl+Z PER increment, not one atomic undo', async ({
	page,
	browser,
}) => {
	test.setTimeout(60_000)
	const room = 'v2-e2e-undo'
	expect(room).not.toBe('team')

	await page.goto(`/?room=${room}&engine=v2`)
	await waitForBoot(page)
	const boxA = await viewportBox(page)
	const anchor = { x: boxA.x + ANCHOR.x, y: boxA.y + ANCHOR.y }

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

		// ------------------------------------------------------------------
		// PART 1 — delete then undo: a single keypress emits DeleteShapes +
		// SetSelection as ONE applyAll batch, i.e. ONE UndoEntry (editor.ts's
		// COMMIT GRANULARITY). One Ctrl+Z fully restores it. Cross-client too:
		// undo replays InverseOps against THIS peer's own doc, which ships the
		// restoring putShape over the wire exactly like any other mutation.
		// ------------------------------------------------------------------
		const id1 = await createNoteAt(page, boxA)
		await expect(pageB.locator(`[data-shape-id="${id1}"]`)).toBeVisible({ timeout: 10_000 })

		await page.mouse.click(anchor.x, anchor.y)
		await page.keyboard.press('Delete')
		await expect(page.locator(`[data-shape-id="${id1}"]`)).toHaveCount(0)
		await expect(pageB.locator(`[data-shape-id="${id1}"]`)).toHaveCount(0, { timeout: 10_000 })

		await page.keyboard.press('Control+z')
		await expect(page.locator(`[data-shape-id="${id1}"]`)).toHaveCount(1, { timeout: 5_000 })
		await expect.poll(() => page.evaluate((id) => !!(window as any).__ew.doc.getShape(id), id1)).toBe(true)
		await expect(pageB.locator(`[data-shape-id="${id1}"]`)).toBeVisible({ timeout: 10_000 })
		await expect
			.poll(() => pageB.evaluate((id) => !!(window as any).__ew.doc.getShape(id), id1), { timeout: 10_000 })
			.toBe(true)

		// ------------------------------------------------------------------
		// PART 2 — drag then undo: THE SUPERVISOR-FLAGGED CARRIED FINDING.
		//
		// select.ts's translate drag commits ONE TranslateShapes intent PER
		// pointermove (COMMIT CADENCE note, both onPointing's threshold-cross
		// move and every subsequent onDragging move), and each is its own
		// editor.applyAll() call -> its own UndoEntry (editor.ts's COMMIT
		// GRANULARITY: "every apply()/applyAll() batch's worth of doc
		// mutation" is one undo/redo step). A drag driven through several REAL
		// pointermoves (not a single teleporting move, which would hide this)
		// therefore leaves MULTIPLE undo entries behind, and ONE Ctrl+Z only
		// pops the LAST one — i.e. it steps back ONE INCREMENT of the drag,
		// not the whole gesture back to its pre-drag start. This is verified
		// HONESTLY below (not papered over with a trivial single-move drag or
		// a silent multi-press loop): the assertions name the actual observed
		// per-increment behavior, and a full restore is only reached after
		// pressing Ctrl+Z once per increment. See tool-loop.ts's
		// `cancelActiveTool` doc comment for the sibling finding this same
		// commit cadence causes on transform/resize-cancel (B5) — the SAME
		// underlying gap (no gesture-atomic undo yet), a documented Phase-4
		// carry, not something this test should quietly hide.
		//
		// A second note, away from id1, so translating it can never coincide
		// with id1's bounds (computeSnappedDelta's snap candidates) and
		// confuse the position math below.
		// ------------------------------------------------------------------
		await page.locator('[data-canvas-v2-tool="note"]').click()
		const p2 = { x: boxA.x + 900, y: boxA.y + 520 }
		await page.mouse.click(p2.x, p2.y)
		await page.locator('[data-canvas-v2-tool="select"]').click()
		const note2 = page.locator(`[data-shape-kind="note"]:not([data-shape-id="${id1}"])`)
		await expect(note2).toBeVisible({ timeout: 10_000 })
		const id2 = await note2.getAttribute('data-shape-id')
		if (!id2) throw new Error('second note has no data-shape-id')

		const posOf = (id: string) =>
			page.evaluate((shapeId) => {
				const s = (window as any).__ew.doc.getShape(shapeId)
				return s ? { x: s.x, y: s.y } : null
			}, id)

		const p0 = await posOf(id2) // pre-drag position

		// THREE discrete pointer moves (no Playwright `steps` interpolation —
		// exact control over how many commits happen), each past
		// DRAG_THRESHOLD (4px) from the last, so each is its own increment.
		await page.mouse.move(p2.x, p2.y)
		await page.mouse.down() // lands ON the note -> select.ts's Pointing(targetId=id2)
		await page.mouse.move(p2.x + 90, p2.y + 70) // move #1: crosses threshold -> Dragging entry, UndoEntry #1 (SetSelection + TranslateShapes)
		const p1 = await posOf(id2)
		await page.mouse.move(p2.x + 160, p2.y + 210) // move #2 -> UndoEntry #2
		const pAfter2 = await posOf(id2)
		await page.mouse.move(p2.x + 260, p2.y + 250) // move #3 -> UndoEntry #3
		const pFinal = await posOf(id2)
		await page.mouse.up()

		expect(p1).not.toEqual(p0) // the drag actually moved it
		expect(pAfter2).not.toEqual(p1) // move #2 is a DISTINCT increment from move #1
		expect(pFinal).not.toEqual(pAfter2) // move #3 is a DISTINCT increment from move #2

		// ONE Ctrl+Z: per the finding above, this pops UndoEntry #3 ONLY.
		await page.keyboard.press('Control+z')
		const pAfterOneUndo = await posOf(id2)
		// THE KEY OBSERVATION (verbatim, not softened): one Ctrl+Z after a
		// 3-move drag restores the position to what it was after move #2 —
		// ONE increment back — NOT the pre-drag position p0.
		expect(pAfterOneUndo).toEqual(pAfter2)
		expect(pAfterOneUndo).not.toEqual(p0)

		// Undo does eventually reach the true pre-drag position — it just
		// takes one Ctrl+Z per increment (3 total for a 3-move drag), not one
		// atomic gesture-undo. This is the "restores prior position" the task
		// asks for, achieved honestly rather than asserted falsely after a
		// single press.
		await page.keyboard.press('Control+z')
		await page.keyboard.press('Control+z')
		const pFullyUndone = await posOf(id2)
		expect(pFullyUndone).toEqual(p0)

		// Cross-client convergence of the FINAL (fully undone) position —
		// undo's replayed InverseOps are ordinary doc mutations, so they ship
		// to B the same as any other commit.
		await expect
			.poll(() => pageB.evaluate((id) => (window as any).__ew.doc.getShape(id), id2), { timeout: 10_000 })
			.toMatchObject({ x: p0!.x, y: p0!.y })
	} finally {
		await ctxB.close()
	}
})

test("canvas-v2 new engine: undo is LOCAL-ONLY per peer — A's Ctrl+Z reverts only A's own last create, never B's", async ({ page, browser }) => {
	test.setTimeout(60_000)
	const room = 'v2-e2e-local-undo'
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
		const boxB = await viewportBox(pageB)

		// A creates X, B creates Y — each peer's undo stack (editor.ts's
		// `undoStack`) is a plain in-memory array on ITS OWN Editor instance,
		// populated only by THAT instance's own applyAll() calls (Task B1's
		// design: "gives local-peer-only undo scope for free — a remote
		// peer's incoming shapes are never captured"). So A's stack holds only
		// X's create batch; Y was never A's own mutation and never enters it.
		const idX = await createNoteAt(page, boxA)
		await expect(pageB.locator(`[data-shape-id="${idX}"]`)).toBeVisible({ timeout: 10_000 })
		// NOT createNoteAt(pageB, boxB) here: that helper's own `[data-shape-kind="note"]`
		// locator (lib/canvas-v2.ts) assumes exactly one note on the page — true
		// for every OTHER case in this file (fresh room, first shape), but by
		// now B's DOM already shows X (converged from A), so the same manual
		// sequence is inlined here with an explicit `:not(...)` filter for X's id.
		await pageB.locator('[data-canvas-v2-tool="note"]').click()
		await pageB.mouse.click(boxB.x + ANCHOR.x, boxB.y + ANCHOR.y)
		await pageB.locator('[data-canvas-v2-tool="select"]').click()
		const noteY = pageB.locator(`[data-shape-kind="note"]:not([data-shape-id="${idX}"])`)
		await expect(noteY).toBeVisible({ timeout: 10_000 })
		const idY = await noteY.getAttribute('data-shape-id')
		if (!idY) throw new Error('created note (Y) has no data-shape-id')
		await expect(page.locator(`[data-shape-id="${idY}"]`)).toBeVisible({ timeout: 10_000 })

		// A undoes ITS OWN last batch (creating X). No prior click/focus setup
		// needed here — A's last DOM interaction was createNoteAt's own
		// closing click on the 'select' toolbar button, so this Ctrl+Z is
		// delivered via CanvasV2App's document-level keydown fallback (the
		// button is a viewport SIBLING, not a descendant — see that
		// component's GLOBAL KEYBOARD-DELIVERY FALLBACK note), which funnels
		// through the exact same `handleGlobalShortcut` policy either way.
		await page.keyboard.press('Control+z')

		// X gone on BOTH clients.
		await expect(page.locator(`[data-shape-id="${idX}"]`)).toHaveCount(0)
		await expect.poll(() => page.evaluate((id) => !!(window as any).__ew.doc.getShape(id), idX)).toBe(false)
		await expect(pageB.locator(`[data-shape-id="${idX}"]`)).toHaveCount(0, { timeout: 10_000 })
		await expect
			.poll(() => pageB.evaluate((id) => !!(window as any).__ew.doc.getShape(id), idX), { timeout: 10_000 })
			.toBe(false)

		// Y — B's OWN create — is UNTOUCHED on both clients: A's undo never
		// reverts a peer's op. Scoped to `[data-shape-kind]` on B's OWN check:
		// Y is STILL selected there (create.ts's finalizeIntents selects
		// whatever it just created, and nothing in this test ever deselects
		// it), so a bare id query on B would also match the selection
		// overlay's own outline (same pitfall as the delete test's id3 case).
		await expect(page.locator(`[data-shape-id="${idY}"]`)).toHaveCount(1)
		await expect.poll(() => page.evaluate((id) => !!(window as any).__ew.doc.getShape(id), idY)).toBe(true)
		await expect(pageB.locator(`[data-shape-id="${idY}"][data-shape-kind]`)).toHaveCount(1)
		await expect.poll(() => pageB.evaluate((id) => !!(window as any).__ew.doc.getShape(id), idY)).toBe(true)
	} finally {
		await ctxB.close()
	}
})

test('canvas-v2 new engine: cancellation — Escape/blur/pointercancel abandon an in-flight create-drag or arrow-draw with no persisted preview', async ({
	page,
}) => {
	test.setTimeout(60_000)
	const room = 'v2-e2e-cancel'
	expect(room).not.toBe('team')

	await page.goto(`/?room=${room}&engine=v2`)
	await waitForBoot(page)
	const box = await viewportBox(page)

	const shapeCount = () => page.evaluate(() => (window as any).__ew.doc.listShapes().length)
	// The exact selector matters: `[data-canvas-v2-viewport]` (CanvasV2App.tsx)
	// is the OUTER, non-focusable wrapping div; canvas-react's `Viewport`
	// component renders its OWN inner div (the one with tabIndex=0 and every
	// pointer/keyboard/blur listener — see Viewport.tsx) as that wrapper's
	// single direct child. Focus/blur/pointercancel below all need to target
	// THAT inner div specifically.
	const focusViewport = () =>
		page.evaluate(() => (document.querySelector('[data-canvas-v2-viewport] > div') as HTMLElement | null)?.focus())
	const blurViewport = () =>
		page.evaluate(() => (document.querySelector('[data-canvas-v2-viewport] > div') as HTMLElement | null)?.blur())
	const dispatchPointerCancel = () =>
		page.evaluate(() => {
			const el = document.querySelector('[data-canvas-v2-viewport] > div') as HTMLElement | null
			el?.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, cancelable: true, pointerId: 1 }))
		})

	// --- 1) create-drag then Escape -> no preview persists ---
	await page.locator('[data-canvas-v2-tool="geo"]').click()
	const p0 = { x: box.x + 500, y: box.y + 500 }
	await page.mouse.move(p0.x, p0.y)
	await page.mouse.down()
	await page.mouse.move(p0.x + 60, p0.y + 60) // crosses DRAG_THRESHOLD -> preview shape committed (create.ts's 'dragging')
	await expect(page.locator('[data-shape-kind="geo"]')).toHaveCount(1) // sanity: the preview really is live mid-drag
	await page.keyboard.press('Escape') // handleGlobalShortcut -> cancelAndReset -> DeleteShapes([previewId])
	await page.mouse.up() // release the real button (tool FSM is already back to idle by the time this lands)
	await expect(page.locator('[data-shape-kind="geo"]')).toHaveCount(0)
	await expect.poll(shapeCount).toBe(0)
	await page.locator('[data-canvas-v2-tool="select"]').click()

	// --- 2) create-drag then BLUR the viewport (not Escape, not pointerup) -> no preview persists ---
	await page.locator('[data-canvas-v2-tool="geo"]').click()
	const p1 = { x: box.x + 500, y: box.y + 200 }
	await page.mouse.move(p1.x, p1.y)
	await page.mouse.down()
	await focusViewport() // guarantee it HAS focus, so the .blur() below actually fires a real blur event
	await page.mouse.move(p1.x + 60, p1.y + 60)
	await expect(page.locator('[data-shape-kind="geo"]')).toHaveCount(1)
	await blurViewport() // Viewport.tsx's onBlur -> CanvasV2App's handleViewportBlur -> cancelAndReset
	await page.mouse.up()
	await expect(page.locator('[data-shape-kind="geo"]')).toHaveCount(0)
	await expect.poll(shapeCount).toBe(0)
	await page.locator('[data-canvas-v2-tool="select"]').click()

	// --- 3) arrow-draw then Escape -> no arrow persists (bounds DoD #5) ---
	// Arrows render via canvas-react's BoxShape fallback (shapeRegistry.ts's
	// FALLBACK POLICY — no bespoke arrow body is registered yet), so
	// `[data-shape-kind="arrow"]` is a real, queryable DOM element same as
	// any other shape.
	await page.locator('[data-canvas-v2-tool="arrow"]').click()
	const p2 = { x: box.x + 200, y: box.y + 500 }
	await page.mouse.move(p2.x, p2.y)
	await page.mouse.down()
	await page.mouse.move(p2.x + 80, p2.y + 80) // crosses threshold -> arrow.ts's 'drawing' (StartArrow committed)
	await expect(page.locator('[data-shape-kind="arrow"]')).toHaveCount(1)
	await page.keyboard.press('Escape')
	await page.mouse.up()
	await expect(page.locator('[data-shape-kind="arrow"]')).toHaveCount(0)
	await expect.poll(shapeCount).toBe(0)
	await page.locator('[data-canvas-v2-tool="select"]').click()

	// --- 4) a pointercancel mid-create-drag -> no preview persists ---
	await page.locator('[data-canvas-v2-tool="note"]').click()
	const p3 = { x: box.x + 800, y: box.y + 300 }
	await page.mouse.move(p3.x, p3.y)
	await page.mouse.down()
	await page.mouse.move(p3.x + 60, p3.y + 60)
	await expect(page.locator('[data-shape-kind="note"]')).toHaveCount(1)
	await dispatchPointerCancel() // Viewport.tsx's onPointerCancel -> CanvasV2App's onPointerCancel -> cancelAndReset
	await page.mouse.up() // the real pointer is still physically down; release it for a clean end-of-test state
	await expect(page.locator('[data-shape-kind="note"]')).toHaveCount(0)
	await expect.poll(shapeCount).toBe(0)
})

// ============================================================================
// TASK D6 — two-client embed write-path E2E through /sync/v2, the final
// Seam D unit. Proves the D2 dispatch channel (ShapeBodyProps.dispatch ->
// editor.applyAll) + the D3 terminal title-rename/title-drag features
// end-to-end across two REAL browser clients, closing the carried finding
// from D3's own completion notes ("proven only via a fake-dispatch-spy unit
// test — never over a real two-client /sync/v2 session").
//
// SEEDING: a v2 room's shapes live in its Loro doc (window.__ew.doc), a
// completely disjoint plane from the OLD tldraw store `/api/canvas/shape`
// (lib/seed.ts's `shape()`) writes — see this file's own module header on
// the two disjoint "v2" features. There is also no live terminal gateway in
// this rig to drive a real click-to-create through a terminal tool. So
// lib/canvas-v2.ts's `seedTerminal`/`seedFileViewer` seed directly through
// the doc (the SAME `putShape`+`commit()` mechanism `seedGrid` already uses
// for the H3 perf rig) — confirmed, before writing this spec, that a
// doc-level seed on client A really does sync to a from-scratch client B
// (not just render locally): a throwaway two-client smoke case proved this
// class of seeding propagates over the real WS/actor path identically to a
// pointer-driven CreateShape.
//
// GATEWAY-LESS RENDERING: also confirmed before writing this spec (a
// one-off Playwright run, screenshotted) that TerminalShape mounts its FULL
// title bar — including the rename input and drag handler — with NO live
// terminal gateway present; the only visible effect of the missing gateway
// is the "Connecting…"/"Connection lost — reconnecting" overlay over the
// (blank) xterm body. `props.title` is a plain doc prop
// (TerminalShape.tsx's `terminalContentFrom`), rendered/synced independent
// of the terminal's own connection state — exactly what makes the title
// bar drivable in this rig at all.
// ============================================================================

test('canvas-v2 new engine: terminal title-bar write-back through /sync/v2 (D6) — rename propagates to B, Escape discards without propagating, title-drag at non-1 zoom scales by the zoom, and a stationary double-click never moves the shape while Backspace/Delete in the rename input edit text only', async ({
	page,
	browser,
}) => {
	test.setTimeout(60_000)
	const room = 'v2-e2e-terminal-writeback'
	expect(room).not.toBe('team')

	await page.goto(`/?room=${room}&engine=v2`)
	await waitForBoot(page)

	// World coordinates chosen so the title bar (rendered ABOVE the box via
	// `bottom: 100%` — TerminalShape.tsx) and the whole drag path stay safely
	// inside the 1280x720 viewport even after zooming to 2x below (screen =
	// world * z at this fresh session's camera.xy = {0,0} — canvas-editor/src/
	// input.ts's NORMATIVE camera convention).
	const termId = await seedTerminal(page, { x: 200, y: 260, w: 360, h: 220, title: 'e2e-term' })
	const titlebarA = page.locator(`[data-canvas-v2-terminal-titlebar="${termId}"]`)
	await expect(titlebarA).toBeVisible({ timeout: 10_000 })

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

		const shapeB = pageB.locator(`[data-shape-id="${termId}"]`)
		const titlebarB = pageB.locator(`[data-canvas-v2-terminal-titlebar="${termId}"]`)
		await expect(shapeB).toBeVisible({ timeout: 10_000 })
		await expect(titlebarB).toContainText('e2e-term')

		const titleOf = (p: Page) => p.evaluate((id) => (window as any).__ew.doc.getShape(id)?.props?.title as string | undefined, termId)
		const positionOf = (p: Page) =>
			p.evaluate((id) => {
				const s = (window as any).__ew.doc.getShape(id)
				return s ? { x: s.x, y: s.y } : null
			}, termId)

		// ------------------------------------------------------------------
		// 1) CORE PIPE (bounds DoD #6): double-click the title -> type -> Enter
		// commits a REAL UpdateProps intent (dispatch -> editor.applyAll ->
		// doc.commit -> /sync/v2 -> peer). A real native `dblclick` — unlike
		// the canvas's own double-click-to-edit FSM, TerminalShape's title bar
		// listens for a plain browser `onDoubleClick` (TerminalShape.tsx).
		// ------------------------------------------------------------------
		await titlebarA.dblclick()
		const inputA1 = titlebarA.locator('input')
		await expect(inputA1).toBeVisible({ timeout: 5_000 })
		await inputA1.fill('renamed-by-a')
		await inputA1.press('Enter') // onKeyDown -> e.currentTarget.blur() -> onBlur -> commitTitleRename (commits)
		await expect(inputA1).toBeHidden({ timeout: 5_000 })

		// A's OWN doc: the UpdateProps intent actually landed.
		await expect.poll(() => titleOf(page), { timeout: 5_000 }).toBe('renamed-by-a')
		await expect(titlebarA).toContainText('renamed-by-a')

		// B converges — the doc's title equals the new value on BOTH clients,
		// proving the FULL dispatch -> UpdateProps -> /sync/v2 -> peer pipe,
		// not just that A's own local state changed.
		await expect.poll(() => titleOf(pageB), { timeout: 10_000 }).toBe('renamed-by-a')
		await expect(titlebarB).toContainText('renamed-by-a')

		// ------------------------------------------------------------------
		// 2) ESCAPE DISCARDS (the D3 correct-by-construction fix, now
		// behaviorally confirmed): double-click -> type a change -> Escape ->
		// title UNCHANGED on A, and (proven below, once phase 3's drag has
		// shipped a message strictly AFTER this one) nothing ever reaches B.
		// ------------------------------------------------------------------
		await titlebarA.dblclick()
		const inputA2 = titlebarA.locator('input')
		await expect(inputA2).toBeVisible({ timeout: 5_000 })
		await inputA2.fill('should-not-land')
		await page.keyboard.press('Escape') // discardRef=true -> blur -> commitTitleRename discards, dispatches nothing
		await expect(inputA2).toBeHidden({ timeout: 5_000 })
		await expect(titlebarA).toContainText('renamed-by-a') // unchanged, not "should-not-land"
		expect(await titleOf(page)).toBe('renamed-by-a')

		// ------------------------------------------------------------------
		// 3) TITLE-DRAG AT NON-1 ZOOM: world delta = screenDelta / z (D6's
		// carried drag-at-zoom requirement). setCameraZoom dispatches a REAL
		// SetCamera intent against A's own Editor — editor-local state, never
		// synced to the CRDT/peer (editor.ts's EditorState doc comment), so
		// B's own camera stays the default z=1 throughout.
		// ------------------------------------------------------------------
		const rectBeforeZoom = await titlebarA.boundingBox()
		if (!rectBeforeZoom) throw new Error('title bar has no bounding box before zoom')
		await setCameraZoom(page, 2)
		// Wait for the re-render: camera.z=2 with camera.xy unchanged doubles
		// every on-screen position measured from the world origin.
		await expect
			.poll(async () => {
				const r = await titlebarA.boundingBox()
				return r ? Math.round(r.x) : null
			}, { timeout: 5_000 })
			.not.toBe(Math.round(rectBeforeZoom.x))

		const p0 = await positionOf(page)
		if (!p0) throw new Error('terminal shape missing from A doc before drag')

		const rectA = await titlebarA.boundingBox()
		if (!rectA) throw new Error('title bar has no bounding box at z=2')
		const start = { x: rectA.x + rectA.width / 2, y: rectA.y + rectA.height / 2 }
		// A clean, evenly-halving screen delta so the expected WORLD delta
		// (screenDelta / 2) is an exact integer, not a rounded approximation.
		const screenDelta = { x: 200, y: 80 }
		const end = { x: start.x + screenDelta.x, y: start.y + screenDelta.y }
		await page.mouse.move(start.x, start.y)
		await page.mouse.down()
		await page.mouse.move(start.x + screenDelta.x / 2, start.y + screenDelta.y / 2, { steps: 4 }) // crosses TITLE_DRAG_THRESHOLD
		await page.mouse.move(end.x, end.y, { steps: 4 })
		await page.mouse.up()

		const expectedWorldDelta = { x: screenDelta.x / 2, y: screenDelta.y / 2 } // z = 2 -> dx = screenDx / z

		await expect
			.poll(() => positionOf(page), { timeout: 5_000 })
			.toMatchObject({
				x: expect.closeTo(p0.x + expectedWorldDelta.x, 0),
				y: expect.closeTo(p0.y + expectedWorldDelta.y, 0),
			})
		const pAfterDrag = await positionOf(page)
		if (!pAfterDrag) throw new Error('terminal shape missing from A doc after drag')

		// Proves the ZOOM-SCALING specifically, not merely "it moved": the raw
		// screen delta (200px) is DOUBLE the actual world delta the doc holds.
		expect(Math.round(pAfterDrag.x - p0.x)).toBe(screenDelta.x / 2)
		expect(Math.round(pAfterDrag.x - p0.x)).not.toBe(screenDelta.x)

		// B converges to the SAME world position — a plain TranslateShapes
		// doc mutation ships over the wire like any other, regardless of the
		// SENDING client's own (never-synced) camera zoom.
		await expect
			.poll(() => positionOf(pageB), { timeout: 10_000 })
			.toMatchObject({ x: expect.closeTo(pAfterDrag.x, 0), y: expect.closeTo(pAfterDrag.y, 0) })

		// This message shipped strictly AFTER phase 2's Escape-discard attempt
		// (same WS connection, FIFO order) — so by the time B has converged to
		// THIS drag, phase 2's discarded rename would certainly have arrived
		// too, had it ever been dispatched. It never was: B's title is still
		// the real committed value from phase 1, not "should-not-land".
		expect(await titleOf(pageB)).toBe('renamed-by-a')
		await expect(titlebarB).toContainText('renamed-by-a')

		// ------------------------------------------------------------------
		// 4) 4px THRESHOLD + stopPropagation: a STATIONARY double-click opens
		// rename without moving the shape (both clicks land at the same point,
		// same as every dblclick() above — this makes it explicit), and
		// Backspace/Delete inside the rename input edit the title text, never
		// reach CanvasV2App's global-shortcut handler that would otherwise
		// delete the SHAPE (D3's stopPropagation guard — TerminalShape.tsx's
		// input onKeyDown: "Swallow EVERY keydown").
		// ------------------------------------------------------------------
		const pBeforeStationary = await positionOf(page)
		await titlebarA.dblclick()
		const inputA3 = titlebarA.locator('input')
		await expect(inputA3).toBeVisible({ timeout: 5_000 })
		expect(await positionOf(page)).toEqual(pBeforeStationary) // the two clicks' own jitter never crossed TITLE_DRAG_THRESHOLD

		const draftBefore = await inputA3.inputValue()
		await inputA3.press('Backspace')
		await expect(inputA3).toHaveValue(draftBefore.slice(0, -1)) // a real character was edited...
		await inputA3.press('Delete') // ...and Delete is equally swallowed (no-op at end-of-text, but must not reach the shape)

		// ...never the SHAPE: still exactly one terminal, unmoved. `[data-shape-kind]`
		// (not a bare `[data-shape-id]`) — same pitfall as the delete/undo
		// cases above: this note-equivalent selection outline would otherwise
		// double-match if the terminal were ever selected (it isn't here, but
		// the scoped selector costs nothing and matches house convention).
		await expect(page.locator(`[data-shape-id="${termId}"][data-shape-kind]`)).toHaveCount(1)
		expect(await positionOf(page)).toEqual(pBeforeStationary)

		await page.keyboard.press('Escape') // discard this last edit too, tidy end state
		await expect(inputA3).toBeHidden({ timeout: 5_000 })
	} finally {
		await ctxB.close()
	}
})

// ----------------------------------------------------------------------------
// D6 "if cheap" extra: the file-viewer's `rev` (D5) is the SAME
// shape-agnostic UpdateProps wire path the terminal case above already
// proves — this case exists only to confirm it's not terminal-specific, not
// to re-prove the pipe from scratch.
//
// EXPLICITLY OUT OF SCOPE for this rig (LiveKit/iframe/capture-dependent,
// not drivable without real media — see this unit's own task text): the
// file-viewer's scroll-position peer-follow, the screenshare stillUrl
// stamp-back, and the screenshare aspect relock. Those remain
// dogfood-room/manual verification only.
// ----------------------------------------------------------------------------

test('canvas-v2 new engine: file-viewer refresh bumps the shared `rev` doc prop through /sync/v2 (D5, confirmed as a second UpdateProps consumer alongside D6\'s terminal case)', async ({
	page,
	browser,
}) => {
	test.setTimeout(30_000)
	const room = 'v2-e2e-fileviewer-rev'
	expect(room).not.toBe('team')

	await page.goto(`/?room=${room}&engine=v2`)
	await waitForBoot(page)

	const fvId = await seedFileViewer(page, { x: 200, y: 260 })
	const revOf = (p: Page) => p.evaluate((id) => (window as any).__ew.doc.getShape(id)?.props?.rev as number | undefined, fvId)
	await expect.poll(() => revOf(page), { timeout: 5_000 }).toBe(0)

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
		await expect(pageB.locator(`[data-shape-id="${fvId}"]`)).toBeVisible({ timeout: 10_000 })
		await expect.poll(() => revOf(pageB), { timeout: 10_000 }).toBe(0)

		// The refresh button (HeaderButton, title="Refresh (reloads for
		// everyone)") calls dispatch([fileViewerRefreshIntent(...)]) on click —
		// a plain UpdateProps, exactly like the terminal rename above.
		const refreshBtn = page.locator(`[data-shape-id="${fvId}"] button[title="Refresh (reloads for everyone)"]`)
		await refreshBtn.click()

		await expect.poll(() => revOf(page), { timeout: 5_000 }).toBe(1)
		await expect.poll(() => revOf(pageB), { timeout: 10_000 }).toBe(1)
	} finally {
		await ctxB.close()
	}
})
