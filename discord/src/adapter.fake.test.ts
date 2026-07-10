import assert from 'node:assert/strict'
import { FakeGateway } from './adapter.fake.ts'

const gw = new FakeGateway()
const seen: any[] = []
gw.onMessage((m) => { seen.push(m) })
gw.emit({ channelId: 'c1', guildId: 'g1', authorId: 'u1', authorName: 'alice', isBot: false, content: 'hi' })
assert.equal(seen.length, 1)
assert.equal(seen[0].content, 'hi')

await gw.send('c1', { title: 'T', description: 'D' })
assert.deepEqual(gw.sent[0], { channelId: 'c1', embed: { title: 'T', description: 'D' } })

// multiple handlers all receive an emitted message
const gw2 = new FakeGateway()
let a = 0, b = 0
gw2.onMessage(() => { a++ })
gw2.onMessage(() => { b++ })
gw2.emit({ channelId: 'c', guildId: 'g', authorId: 'u', authorName: 'x', isBot: true, content: 'y' })
assert.equal(a, 1)
assert.equal(b, 1)

console.log('ok: fake gateway')
