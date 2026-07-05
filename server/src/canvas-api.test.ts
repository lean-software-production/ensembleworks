// Contract tests for the canvas HTTP API (session MVP plan, Cycle 2).
// Boots the express app in-process via createSyncApp, seeds a room through
// getOrCreateRoom().updateStore(), then exercises /api/terminal-status,
// /api/sticky and the /api/health regression guard.
// Run with: bun src/canvas-api.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { createSyncApp } from './app.ts'
import { schema } from './schema.ts'
import { makeTestClient } from './test-helpers.ts'

const TERMINAL_ID = 'shape:terminal-1'
const FRAME_ID = 'shape:frame-advice'
const STICKY_TEXT = 'Try slicing the next story thinner'

async function main() {
	// 1. Boot the app against a throwaway data dir on an ephemeral port.
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-api-test-'))
	const { server, getOrCreateRoom } = createSyncApp({ dataDir })
	await new Promise<void>((resolve) => server.listen(0, resolve))
	const address = server.address()
	assert.ok(address && typeof address === 'object', 'server.listen(0) should yield a port')
	const base = `http://127.0.0.1:${address.port}`

	const { postJson, getJson } = makeTestClient(base)
	const openSocket = (url: string) =>
		new Promise<WebSocket>((resolve, reject) => {
			const ws = new WebSocket(url)
			ws.once('open', () => resolve(ws))
			ws.once('error', reject)
		})

	// 2. Seed the room: a terminal shape and an advice frame. A fresh room
	// already contains document:document and page:page.
	const room = getOrCreateRoom('test')
	await room.updateStore((store) => {
		store.put({
			id: TERMINAL_ID,
			typeName: 'shape',
			type: 'terminal',
			x: 0,
			y: 0,
			rotation: 0,
			isLocked: false,
			opacity: 1,
			meta: {},
			props: { w: 640, h: 480, sessionId: 'abc123', title: 'crew-a terminal' },
			parentId: 'page:page',
			index: 'a1',
		} as any)
		store.put({
			id: FRAME_ID,
			typeName: 'shape',
			type: 'frame',
			x: 1000,
			y: 0,
			rotation: 0,
			isLocked: false,
			opacity: 1,
			meta: {},
			props: { w: 800, h: 600, name: 'Advice — crew-a', color: 'black' },
			parentId: 'page:page',
			index: 'a2',
		} as any)
	})

	const documents = () => room.getCurrentSnapshot().documents.map((d) => d.state as any)

	// 3. terminal-status happy path: flips props.status on the matching shape.
	{
		const res = await postJson('/api/terminal-status', {
			room: 'test',
			sessionId: 'abc123',
			status: 'needs-you',
		})
		assert.equal(res.status, 200, 'terminal-status happy path should be 200')
		assert.equal(res.body.ok, true)
		assert.equal(res.body.updated, 1, 'exactly one terminal shape should be updated')
		const terminal = documents().find((r) => r.id === TERMINAL_ID)
		assert.ok(terminal, 'terminal shape should still exist')
		assert.equal(terminal.props.status, 'needs-you', 'snapshot should show the new status prop')
		console.log('ok: terminal-status sets props.status on the matching terminal')
	}

	// 4. terminal-status edge cases.
	{
		const unknown = await postJson('/api/terminal-status', {
			room: 'test',
			sessionId: 'does-not-exist',
			status: 'working',
		})
		assert.equal(unknown.status, 200, 'unknown sessionId is not an error')
		assert.equal(unknown.body.updated, 0, 'unknown sessionId updates nothing')

		const badStatus = await postJson('/api/terminal-status', {
			room: 'test',
			sessionId: 'abc123',
			status: 'bogus',
		})
		assert.equal(badStatus.status, 400, 'status outside working|needs-you|done|idle is 400')

		const missingSession = await postJson('/api/terminal-status', {
			room: 'test',
			status: 'working',
		})
		assert.equal(missingSession.status, 400, 'missing sessionId is 400')
		console.log('ok: terminal-status edge cases (unknown id, bad status, missing sessionId)')
	}

	// 5. sticky happy path: note parented to the matching frame, rich text
	// contains the text.
	{
		const res = await postJson('/api/sticky', {
			room: 'test',
			text: STICKY_TEXT,
			frame: 'advice',
		})
		assert.equal(res.status, 200, 'sticky happy path should be 200')
		assert.equal(res.body.ok, true)
		assert.ok(typeof res.body.id === 'string' && res.body.id.startsWith('shape:'), 'response carries the new shape id')
		const note = documents().find((r) => r.id === res.body.id)
		assert.ok(note, 'the new note should appear in the snapshot')
		assert.equal(note.type, 'note', 'sticky creates a tldraw note shape')
		assert.equal(note.parentId, FRAME_ID, 'note is parented to the matching frame')
		assert.ok(
			JSON.stringify(note.props).includes(STICKY_TEXT),
			'note rich text contains the posted text'
		)
		// fontSizeAdjustment multiplies the label font size: 0 renders the
		// text at 0px (invisible sticky), so it must be 1 for new notes.
		assert.equal(note.props.fontSizeAdjustment, 1, 'note text must not render at 0px')
		console.log('ok: sticky lands inside the advice frame with the right text')
	}

	// 6. sticky edge cases.
	{
		const noFrame = await postJson('/api/sticky', {
			room: 'test',
			text: 'orphan advice',
			frame: 'definitely-no-such-frame',
		})
		assert.equal(noFrame.status, 404, 'unknown frame is 404')
		assert.equal(noFrame.body.error, 'frame not found')

		const emptyText = await postJson('/api/sticky', { room: 'test', text: '   ' })
		assert.equal(emptyText.status, 400, 'text empty after trim is 400')
		console.log('ok: sticky edge cases (unknown frame 404, empty text 400)')
	}

	// 6b. Seed an image (+ its asset) into the advice frame so the read
	// endpoints have something richer than the single note from section 5.
	const IMAGE_ID = 'shape:img-1'
	const ASSET_ID = 'asset:advice-1'
	await room.updateStore((store) => {
		store.put({
			id: ASSET_ID,
			typeName: 'asset',
			type: 'image',
			meta: {},
			props: {
				w: 800,
				h: 600,
				name: 'whiteboard.png',
				isAnimated: false,
				mimeType: 'image/png',
				src: '/uploads/whiteboard',
			},
		} as any)
		store.put({
			id: IMAGE_ID,
			typeName: 'shape',
			type: 'image',
			x: 40,
			y: 300,
			rotation: 0,
			isLocked: false,
			opacity: 1,
			meta: {},
			parentId: FRAME_ID,
			index: 'a3',
			props: {
				w: 320,
				h: 240,
				assetId: ASSET_ID,
				playing: true,
				url: '',
				crop: null,
				flipX: false,
				flipY: false,
				altText: '',
			},
		} as any)
	})

	// 6c. /api/frames lists every frame with its child counts.
	{
		const res = await getJson('/api/frames?room=test')
		assert.equal(res.status, 200, '/api/frames should be 200')
		const advice = res.body.frames.find((f: any) => f.name === 'Advice — crew-a')
		assert.ok(advice, 'frames listing includes the advice frame')
		assert.equal(advice.notes, 1, 'advice frame reports its one sticky')
		assert.equal(advice.images, 1, 'advice frame reports its one image')
		console.log('ok: /api/frames lists frames with child counts')
	}

	// 6d. /api/frame returns a frame's stickies + images as structured data,
	// recovering plain text from richText and resolving images to their url.
	{
		const res = await getJson('/api/frame?room=test&name=advice')
		assert.equal(res.status, 200, '/api/frame should be 200')
		assert.equal(res.body.frame.name, 'Advice — crew-a')
		assert.ok(
			res.body.notes.some((n: any) => n.text === STICKY_TEXT),
			'note text recovered from richText'
		)
		assert.equal(res.body.images.length, 1, 'the seeded image is returned')
		assert.equal(
			res.body.images[0].url,
			'/uploads/whiteboard',
			'image resolves to its asset src url'
		)

		const missing = await getJson('/api/frame?room=test&name=definitely-no-such-frame')
		assert.equal(missing.status, 404, 'unknown frame is 404')
		assert.equal(missing.body.error, 'frame not found')

		const noName = await getJson('/api/frame?room=test')
		assert.equal(noName.status, 400, 'missing name is 400')

		// With nobody connected there is no cursor to sort by.
		assert.equal(res.body.sortedBy, null, 'no presence ⇒ sortedBy is null (document order)')
		console.log('ok: /api/frame returns stickies + image urls, 404/400 on edges')
	}

	// 6e. Proximity sort: a connected teammate's cursor orders the stickies,
	// nearest first. Seed two notes at known positions, connect a client and
	// push a presence cursor next to the far one, then read the frame back.
	{
		const FRAME_X = 1000 // FRAME_ID was seeded at x:1000, y:0 on page:page
		await room.updateStore((store) => {
			store.put({
				id: 'shape:note-near', typeName: 'shape', type: 'note', x: 600, y: 400, rotation: 0,
				isLocked: false, opacity: 1, meta: {}, parentId: FRAME_ID, index: 'a8',
				props: { richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'NEAR' }] }] }, color: 'yellow', size: 'm', font: 'draw', fontSizeAdjustment: 1, align: 'middle', verticalAlign: 'middle', growY: 0, url: '', scale: 1, labelColor: 'black', textFirstEditedBy: null },
			} as any)
			store.put({
				id: 'shape:note-far', typeName: 'shape', type: 'note', x: 10, y: 10, rotation: 0,
				isLocked: false, opacity: 1, meta: {}, parentId: FRAME_ID, index: 'a9',
				props: { richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'FAR' }] }] }, color: 'yellow', size: 'm', font: 'draw', fontSizeAdjustment: 1, align: 'middle', verticalAlign: 'middle', growY: 0, url: '', scale: 1, labelColor: 'black', textFirstEditedBy: null },
			} as any)
		})

		const wsBase = `ws://127.0.0.1:${address.port}`
		const ws = await openSocket(`${wsBase}/sync/test?sessionId=cursor-tab&storeId=c1&userId=mover`)
		const connected = new Promise<void>((resolve) =>
			ws.on('message', (d) => {
				if (JSON.parse(d.toString()).type === 'connect') resolve()
			})
		)
		ws.send(
			JSON.stringify({
				type: 'connect', connectRequestId: 'r1', lastServerClock: 0, protocolVersion: 8,
				schema: schema.serialize(),
			})
		)
		await connected
		// Cursor in page space right on top of the NEAR note (frame x + note x).
		ws.send(
			JSON.stringify({
				type: 'push', clock: 1,
				presence: ['put', {
					userId: 'mover', userName: 'Mover', color: '#FF0000', currentPageId: 'page:page',
					cursor: { x: FRAME_X + 600, y: 400, type: 'default', rotation: 0 },
					camera: { x: 0, y: 0, z: 1 }, selectedShapeIds: [], screenBounds: { x: 0, y: 0, w: 1, h: 1 },
					lastActivityTimestamp: 10, followingUserId: null, brush: null, scribbles: [], chatMessage: '', meta: {},
				}],
			})
		)
		await new Promise((r) => setTimeout(r, 300)) // let the push apply

		const sorted = await getJson('/api/frame?room=test&name=advice')
		assert.equal(sorted.status, 200)
		assert.ok(sorted.body.sortedBy, 'a connected cursor populates sortedBy')
		assert.equal(sorted.body.sortedBy.userName, 'Mover')
		const texts = sorted.body.notes.map((n: any) => n.text)
		assert.ok(
			texts.indexOf('NEAR') < texts.indexOf('FAR'),
			`NEAR should sort before FAR, got ${JSON.stringify(texts)}`
		)
		assert.ok(
			typeof sorted.body.notes[0].dist === 'number',
			'sorted notes carry a numeric dist'
		)

		// Same tab publishes a stamp whose point is on top of the FAR note while
		// the raw cursor stays on NEAR: reads must sort by the stamp point (what
		// the user is at/looking at), and sortedBy must report that point.
		ws.send(
			JSON.stringify({
				type: 'push', clock: 2,
				presence: ['put', {
					userId: 'mover', userName: 'Mover', color: '#FF0000', currentPageId: 'page:page',
					cursor: { x: FRAME_X + 600, y: 400, type: 'default', rotation: 0 },
					camera: { x: 0, y: 0, z: 1 }, selectedShapeIds: [], screenBounds: { x: 0, y: 0, w: 1, h: 1 },
					lastActivityTimestamp: 20, followingUserId: null, brush: null, scribbles: [], chatMessage: '',
					meta: { stamp: { at: { x: FRAME_X + 10, y: 10 }, frame: { name: 'Advice — crew-a', dist: 0 } } },
				}],
			})
		)
		await new Promise((r) => setTimeout(r, 300))

		const stamped = await getJson('/api/frame?room=test&name=advice')
		assert.equal(stamped.status, 200)
		assert.deepEqual(
			stamped.body.sortedBy.cursor,
			{ x: FRAME_X + 10, y: 10 },
			'sortedBy reports the stamp point actually used'
		)
		const stampedTexts = stamped.body.notes.map((n: any) => n.text)
		assert.ok(
			stampedTexts.indexOf('FAR') < stampedTexts.indexOf('NEAR'),
			`stamp point flips the order, got ${JSON.stringify(stampedTexts)}`
		)
		console.log('ok: /api/frame sorts by the presence stamp point when present')

		// The sibling /api/frames endpoint shares the same sort wiring — confirm
		// it too reports the stamp point (not the raw cursor) in sortedBy.
		const framesStamped = await getJson('/api/frames?room=test')
		assert.equal(framesStamped.status, 200)
		assert.deepEqual(
			framesStamped.body.sortedBy.cursor,
			{ x: FRAME_X + 10, y: 10 },
			'/api/frames sortedBy also reports the stamp point'
		)
		console.log('ok: /api/frames sortedBy reports the presence stamp point')

		ws.close()
		await new Promise((r) => setTimeout(r, 100))
		console.log('ok: /api/frame orders stickies by nearest cursor when present')
	}

	// 7. Kick disconnects every canvas tab registered to the target user.
	{
		const wsBase = `ws://127.0.0.1:${address.port}`
		const alice = await openSocket(`${wsBase}/sync/test?sessionId=alice-tab&storeId=a&userId=alice`)
		const bob1 = await openSocket(`${wsBase}/sync/test?sessionId=bob-tab-1&storeId=b1&userId=bob`)
		const bob2 = await openSocket(`${wsBase}/sync/test?sessionId=bob-tab-2&storeId=b2&userId=bob`)
		const bobClosed = Promise.all([
			new Promise<void>((resolve) => bob1.once('close', () => resolve())),
			new Promise<void>((resolve) => bob2.once('close', () => resolve())),
		])

		const kicked = await postJson('/api/kick', { room: 'test', userId: 'bob' })
		assert.equal(kicked.status, 200)
		assert.equal(kicked.body.disconnected, 2, 'all tabs for the target user are disconnected')
		await bobClosed
		assert.equal(alice.readyState, WebSocket.OPEN, 'other room members stay connected')
		alice.close()
		console.log('ok: kick disconnects only the target user across all tabs')
	}

	// 8. Refactor guard: /api/health still answers.
	{
		const res = await fetch(`${base}/api/health`)
		assert.equal(res.status, 200, '/api/health should be 200')
		const body = (await res.json()) as any
		assert.equal(body.ok, true, '/api/health should report ok: true')
		console.log('ok: /api/health survives the refactor')
	}

	room.close()
	await new Promise<void>((resolve, reject) =>
		server.close((err) => (err ? reject(err) : resolve()))
	)
}

main().then(
	() => {
		console.log('canvas-api.test.ts: all tests passed')
		process.exit(0)
	},
	(err) => {
		console.error(err)
		process.exit(1)
	}
)
