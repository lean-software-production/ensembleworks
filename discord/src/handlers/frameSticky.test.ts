import assert from 'node:assert/strict'
import { makeFrameStickyHandler } from './frameSticky.ts'
import type { SyncServerClient } from '../syncClient.ts'

const calls: any[] = []
const fakeClient = { createSticky: async (input: any) => { calls.push(input); return 'shape:x' } }
const handler = makeFrameStickyHandler(fakeClient as unknown as SyncServerClient)

const msg = (content: string) => ({ channelId: 'c', guildId: 'g', authorId: 'u', authorName: 'alice', isBot: false, content })

// happy path: content → sticky in the named frame, author-attributed
await handler.handle({ room: 'planning', message: msg('ship it') }, { frame: 'Ideas' })
assert.equal(calls.length, 1)
assert.equal(calls[0].room, 'planning')
assert.equal(calls[0].frame, 'Ideas')
assert.equal(calls[0].text, 'ship it')
assert.match(calls[0].author, /alice.*Discord/i)

// empty / whitespace-only content is skipped (no sticky)
await handler.handle({ room: 'planning', message: msg('   ') }, { frame: 'Ideas' })
assert.equal(calls.length, 1, 'whitespace-only content is skipped')

// missing frame param → frame is undefined (server will post unparented), still posts
await handler.handle({ room: 'r', message: msg('hello') }, {})
assert.equal(calls.length, 2)
assert.equal(calls[1].frame, undefined)

console.log('ok: frame-sticky handler')
