import assert from 'node:assert/strict'
import { Router } from './router.ts'

const calls: any[] = []
const registry = {
	'frame-sticky': { handle: async (ctx: any, params: any) => { calls.push({ ctx, params }) } },
}
// resolveBinding: channelId → inbound bindings (stubs the server lookup)
const resolve = async (channelId: string) =>
	channelId === 'c1'
		? [{ room: 'planning', route: { handler: 'frame-sticky', params: { frameId: 'shape:f1' } } }]
		: []

const router = new Router({ registry, resolveBinding: resolve })

// bound channel dispatches, with room + params threaded through
await router.handle({ channelId: 'c1', guildId: 'g', authorId: 'u', authorName: 'a', isBot: false, content: 'hello' })
assert.equal(calls.length, 1, 'bound channel dispatches')
assert.equal(calls[0].params.frameId, 'shape:f1')
assert.equal(calls[0].ctx.room, 'planning', 'router injects room into context')
assert.equal(calls[0].ctx.message.content, 'hello')

// bot messages dropped (echo/loop guard)
await router.handle({ channelId: 'c1', guildId: 'g', authorId: 'u', authorName: 'a', isBot: true, content: 'echo' })
assert.equal(calls.length, 1, 'bot messages are dropped')

// unbound channel reaches nothing (security gate)
await router.handle({ channelId: 'nope', guildId: 'g', authorId: 'u', authorName: 'a', isBot: false, content: 'x' })
assert.equal(calls.length, 1, 'unbound channel reaches nothing')

// unknown handler ignored safely (binding references a handler not in the registry)
const router2 = new Router({
	registry,
	resolveBinding: async () => [{ room: 'r', route: { handler: 'does-not-exist', params: {} } }],
})
await router2.handle({ channelId: 'x', guildId: 'g', authorId: 'u', authorName: 'a', isBot: false, content: 'z' })
// no throw, no dispatch — reaching here without an exception is the assertion
console.log('ok: router')
