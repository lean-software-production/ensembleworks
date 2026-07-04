// Throwaway smoke test: speak just enough tlsync to confirm the server
// accepts a connection and answers with a connect response.
import WebSocket from 'ws'
import { schema } from './schema.ts'

const ws = new WebSocket('ws://localhost:8788/sync/smoke?sessionId=smoke-1&userId=smoke-user&storeId=s1')
ws.on('message', (d) => {
	const msg = JSON.parse(d.toString())
	console.log('server replied:', msg.type, 'connectRequestId:', msg.connectRequestId, 'hydration type:', msg.hydrationType)
	process.exit(msg.type === 'connect' ? 0 : 1)
})
ws.on('open', () => {
	ws.send(
		JSON.stringify({
			type: 'connect',
			connectRequestId: 'r1',
			lastServerClock: 0,
			protocolVersion: 8,
			schema: schema.serialize(),
		})
	)
})
ws.on('error', (e) => { console.error('ws error', e.message); process.exit(1) })
setTimeout(() => { console.error('timeout — no reply'); process.exit(1) }, 8000)
