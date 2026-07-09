import assert from 'node:assert/strict'
import { FakeGateway } from './adapter.fake.ts'
import { wireBot } from './bot.ts'

// Poll helper: resolve once `cond()` is true, throw on timeout.
async function until(cond: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!cond()) {
		if (Date.now() > deadline) throw new Error('until: timed out')
		await Bun.sleep(10)
	}
}

// One stub server standing in for the sync server: it answers both the resolve
// lookup (inbound routing) and the sticky create (handler side effect).
const stickies: { room?: string; frame?: string; text?: string; author?: string }[] = []
const srv = Bun.serve({
	port: 0,
	async fetch(req) {
		const url = new URL(req.url)
		if (url.pathname === '/api/discord/resolve') {
			const channelId = url.searchParams.get('channelId')
			if (channelId === 'c1') {
				return Response.json({
					ok: true,
					bindings: [{ room: 'r', route: { handler: 'frame-sticky', params: { frame: 'Ideas' } } }],
				})
			}
			return Response.json({ ok: true, bindings: [] })
		}
		if (url.pathname === '/api/canvas/sticky') {
			const body = (await req.json()) as { room?: string; frame?: string; text?: string; author?: string }
			stickies.push(body)
			return Response.json({ ok: true, id: `sticky-${stickies.length}` })
		}
		return new Response('not found', { status: 404 })
	},
})
const base = `http://127.0.0.1:${srv.port}`

const gw = new FakeGateway()
const { httpFace } = wireBot(gw, { syncBase: base, secret: 's', port: 0 })

// 2. INBOUND: a real user message → a sticky lands in the bound frame.
gw.emit({ channelId: 'c1', guildId: 'g', authorId: 'u', authorName: 'alice', isBot: false, content: 'hello' })
await until(() => stickies.length === 1, 2000)
const posted = stickies[0]!
assert.equal(posted.room, 'r')
assert.equal(posted.frame, 'Ideas')
assert.equal(posted.text, 'hello')
assert.match(posted.author!, /alice.*Discord/i)

// 3. OUTBOUND: internal /post → gateway.send with a formatted embed.
const res = await fetch(`http://127.0.0.1:${httpFace.port}/post`, {
	method: 'POST',
	headers: { 'content-type': 'application/json', 'x-internal-secret': 's' },
	body: JSON.stringify({ channelId: 'cX', payload: { kind: 'summary', room: 'r', data: { text: 'done' } } }),
})
assert.equal(res.status, 200)
assert.equal(gw.sent.length, 1)
const sent = gw.sent[0]!
assert.equal(sent.channelId, 'cX')
assert.match(sent.embed.title!, /summary/i)

// 4. Echo guard end-to-end: a bot-authored message must not create a sticky.
gw.emit({ channelId: 'c1', guildId: 'g', authorId: 'u', authorName: 'bot', isBot: true, content: 'echo' })
await Bun.sleep(30)
assert.equal(stickies.length, 1, 'bot message ignored — no extra sticky')

httpFace.stop()
srv.stop()
console.log('ok: bot wiring')
