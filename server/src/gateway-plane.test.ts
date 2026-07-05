// Integration test for the gateway plane: connect-equals-register, list,
// relay splicing end-to-end over real WebSockets against an in-process app.
// Run with: bun src/gateway-plane.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { createSyncApp } from './app.ts'
import { encodeBinaryFrame } from './gateway-registry.ts'
import { makeTestClient } from './test-helpers.ts'

const openSocket = (url: string) =>
	new Promise<WebSocket>((resolve, reject) => {
		const ws = new WebSocket(url)
		ws.once('open', () => resolve(ws))
		// Persistent (not once): a rejected upgrade can emit 'error' more than once
		// under Bun's ws, and a second error with no listener would escape as an
		// unhandled crash. reject() on an already-settled promise is a harmless
		// no-op, so this stays correct for both the reject-path and opened sockets.
		ws.on('error', reject)
	})

const nextMessage = (ws: WebSocket) =>
	new Promise<{ data: Buffer; isBinary: boolean }>((resolve) => {
		ws.once('message', (data, isBinary) => resolve({ data: data as Buffer, isBinary }))
	})

const closed = (ws: WebSocket) =>
	new Promise<void>((resolve) => {
		// A replacement connect closes this socket as a side effect of the new
		// socket's open resolving; under Bun's timing that 'close' can already have
		// fired by the time we attach the listener (readyState CLOSED), so a bare
		// once('close') would wait forever. Resolve immediately if already closed —
		// robust under both Node and Bun; the assertions below are unchanged.
		if (ws.readyState === WebSocket.CLOSED) return resolve()
		ws.once('close', () => resolve())
	})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-plane-test-'))
	const { server } = createSyncApp({ dataDir })
	await new Promise<void>((resolve) => server.listen(0, resolve))
	const address = server.address()
	assert.ok(address && typeof address === 'object')
	const base = `http://127.0.0.1:${address.port}`
	const wsBase = `ws://127.0.0.1:${address.port}`
	const { getJson } = makeTestClient(base)

	// 1. Empty list before any connector.
	assert.deepEqual((await getJson('/api/gateway/list')).body, { gateways: [] })

	// 2. Connect = register.
	const gw = await openSocket(`${wsBase}/api/gateway/connect?gatewayId=gw-test&label=Test%20Box`)
	const list = (await getJson('/api/gateway/list')).body
	assert.equal(list.gateways.length, 1)
	assert.equal(list.gateways[0].gatewayId, 'gw-test')
	assert.equal(list.gateways[0].label, 'Test Box')

	// 3. Browser attach → relay-open arrives at the gateway.
	const browser = await openSocket(`${wsBase}/api/term/relay?session=s1&gateway=gw-test&cols=80&rows=24`)
	const open = JSON.parse((await nextMessage(gw)).data.toString())
	assert.deepEqual(open, { type: 'relay-open', channelId: 1, sessionId: 's1', cols: 80, rows: 24 })

	// 4. Gateway relay-msg → browser text frame (unwrapped).
	gw.send(JSON.stringify({ type: 'relay-msg', channelId: 1, msg: { type: 'attached', cols: 80, rows: 24 } }))
	const attached = await nextMessage(browser)
	assert.equal(attached.isBinary, false)
	assert.deepEqual(JSON.parse(attached.data.toString()), { type: 'attached', cols: 80, rows: 24 })

	// 5. Gateway binary frame → browser binary, prefix stripped.
	gw.send(encodeBinaryFrame(1, Buffer.from('output!')), { binary: true })
	const out = await nextMessage(browser)
	assert.equal(out.isBinary, true)
	assert.equal(out.data.toString(), 'output!')

	// 6. Browser input → gateway relay-msg wrap.
	browser.send(JSON.stringify({ type: 'input', data: 'ls\r' }))
	const wrapped = JSON.parse((await nextMessage(gw)).data.toString())
	assert.deepEqual(wrapped, { type: 'relay-msg', channelId: 1, msg: { type: 'input', data: 'ls\r' } })

	// 7. Browser close → gateway sees relay-close.
	browser.close()
	const relayClose = JSON.parse((await nextMessage(gw)).data.toString())
	assert.deepEqual(relayClose, { type: 'relay-close', channelId: 1 })

	// 8. Replacement: new connect with same id closes old gw + riding browsers,
	//    and the old socket's late close does not deregister the new one.
	const browser2 = await openSocket(`${wsBase}/api/term/relay?session=s1&gateway=gw-test&cols=80&rows=24`)
	const gw2 = await openSocket(`${wsBase}/api/gateway/connect?gatewayId=gw-test&label=Test%20Box%20v2`)
	await closed(gw)
	await closed(browser2)
	await sleep(50) // let the old socket's close event land
	const list2 = (await getJson('/api/gateway/list')).body
	assert.equal(list2.gateways.length, 1, 'replacement survived the stale close event')
	assert.equal(list2.gateways[0].label, 'Test Box v2')

	// 9. Offline gateway → browser upgrade destroyed immediately.
	gw2.close()
	await sleep(50)
	await assert.rejects(openSocket(`${wsBase}/api/term/relay?session=s1&gateway=gw-test&cols=80&rows=24`))

	// 10. Bad ids rejected.
	await assert.rejects(openSocket(`${wsBase}/api/gateway/connect?gatewayId=bad%20id!`))

	server.close()
	console.log('gateway-plane.test.ts: all assertions passed')
	process.exit(0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
