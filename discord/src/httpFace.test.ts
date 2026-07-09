import assert from 'node:assert/strict'
import { startHttpFace } from './httpFace.ts'
import { FakeGateway } from './adapter.fake.ts'

const gw = new FakeGateway()
const face = startHttpFace({ gateway: gw, secret: 's3cret', port: 0 })
const base = `http://127.0.0.1:${face.port}`
const payload = { kind: 'summary', room: 'r', data: { text: 'hello' } }

// missing secret → 401
let res = await fetch(`${base}/post`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channelId: 'c1', payload }) })
assert.equal(res.status, 401)
assert.equal(gw.sent.length, 0)

// wrong secret → 401
res = await fetch(`${base}/post`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret': 'nope' }, body: JSON.stringify({ channelId: 'c1', payload }) })
assert.equal(res.status, 401)

// correct secret → 200 and a send happened to the right channel with a formatted embed
res = await fetch(`${base}/post`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret': 's3cret' }, body: JSON.stringify({ channelId: 'c1', payload }) })
assert.equal(res.status, 200)
assert.equal(gw.sent.length, 1)
assert.equal(gw.sent[0]!.channelId, 'c1')
assert.match(gw.sent[0]!.embed.title!, /summary/i)
assert.equal(gw.sent[0]!.embed.description, 'hello')

// bad body (missing channelId) with good secret → 400, no send
res = await fetch(`${base}/post`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret': 's3cret' }, body: JSON.stringify({ payload }) })
assert.equal(res.status, 400)
assert.equal(gw.sent.length, 1, 'no extra send on bad body')

face.stop()
console.log('ok: httpFace')
