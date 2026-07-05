/**
 * Run: bun src/kernel/roomHooks.test.ts
 *
 * Uses a duck-typed editor (the screenshare/resolve.ts RoomLike precedent):
 * type-only tldraw imports keep the test runnable under plain tsx.
 */
import assert from 'node:assert/strict'
import type { Editor, TLShape } from 'tldraw'
import type { ClientPlugin } from './plugin'
import { attachRoomHooks } from './roomHooks'

type BeforeHandler = (shape: TLShape, source: 'user' | 'remote') => false | void
type AfterHandler = (shape: TLShape) => void

function fakeEditor() {
	const state = { before: [] as BeforeHandler[], after: [] as AfterHandler[], unregistered: 0 }
	const editor = {
		sideEffects: {
			registerBeforeDeleteHandler(_type: string, handler: BeforeHandler) {
				state.before.push(handler)
				return () => state.unregistered++
			},
			registerAfterDeleteHandler(_type: string, handler: AfterHandler) {
				state.after.push(handler)
				return () => state.unregistered++
			},
		},
	}
	return { editor: editor as unknown as Editor, state }
}

const shape = { id: 'shape:t1', type: 'terminal' } as unknown as TLShape

{
	// No plugins with roomHooks → nothing registered; cleanup is a no-op.
	const { editor, state } = fakeEditor()
	const cleanup = attachRoomHooks(editor, [{ id: 'plain' }])
	assert.equal(state.before.length, 0)
	assert.equal(state.after.length, 0)
	cleanup()
	assert.equal(state.unregistered, 0)
}

{
	// Factories run once per attach, with the editor; vetoes compose: every
	// hook sees the shape, and any single false vetoes the batch.
	const calls: string[] = []
	let factoryRuns = 0
	const vetoPlugin: ClientPlugin = {
		id: 'veto',
		roomHooks: (ed) => {
			factoryRuns++
			assert.ok(ed)
			return {
				beforeShapeDelete(s, source) {
					calls.push(`veto:${s.type}:${source}`)
					return false
				},
			}
		},
	}
	const observePlugin: ClientPlugin = {
		id: 'observe',
		roomHooks: () => ({
			beforeShapeDelete() {
				calls.push('observe')
			},
			afterShapeDelete() {
				calls.push('after')
			},
		}),
	}
	const { editor, state } = fakeEditor()
	const cleanup = attachRoomHooks(editor, [vetoPlugin, observePlugin])
	assert.equal(factoryRuns, 1)
	assert.equal(state.before.length, 1) // one composed handler, not one per plugin
	assert.equal(state.after.length, 1)

	const verdict = state.before[0]!(shape, 'user')
	assert.equal(verdict, false)
	// Both hooks ran, in registry order, despite the first vetoing.
	assert.deepEqual(calls, ['veto:terminal:user', 'observe'])

	state.after[0]!(shape)
	assert.deepEqual(calls.at(-1), 'after')

	cleanup()
	assert.equal(state.unregistered, 2)
}

{
	// No veto → composed handler returns undefined (does not return true).
	const okPlugin: ClientPlugin = { id: 'ok', roomHooks: () => ({ beforeShapeDelete() {} }) }
	const { editor, state } = fakeEditor()
	attachRoomHooks(editor, [okPlugin])
	assert.equal(state.before[0]!(shape, 'user'), undefined)
}

{
	// Plugin-provided cleanup fns run on detach.
	let cleaned = 0
	const withCleanup: ClientPlugin = { id: 'c', roomHooks: () => ({ cleanup: () => cleaned++ }) }
	const { editor } = fakeEditor()
	const cleanup = attachRoomHooks(editor, [withCleanup])
	cleanup()
	assert.equal(cleaned, 1)
}

console.log('roomHooks.test.ts: all assertions passed')
