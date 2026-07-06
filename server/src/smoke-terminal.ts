/**
 * Throwaway smoke test for the terminal gateway: two simulated browsers on
 * one session, input echo, scrollback replay, resize fan-out, and tmux
 * session survival after every client disconnects.
 */
import { execFileSync } from 'node:child_process'
import WebSocket from 'ws'

const BASE = 'ws://localhost:8789/api/terminal/ws'   // was ws://localhost:8789/term/ws
const SESSION = `smoke${Date.now().toString(36)}`

function connect(cols = 80, rows = 24) {
	const ws = new WebSocket(`${BASE}?session=${SESSION}&cols=${cols}&rows=${rows}`)
	ws.binaryType = 'arraybuffer'
	const state = { ws, output: '', control: [] as any[] }
	ws.on('message', (data, isBinary) => {
		if (isBinary) state.output += Buffer.from(data as ArrayBuffer).toString('utf8')
		else state.control.push(JSON.parse(data.toString()))
	})
	return state
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
	const a = connect()
	await sleep(1200)
	if (!a.control.some((m) => m.type === 'attached')) throw new Error('A: no attached msg')

	a.ws.send(JSON.stringify({ type: 'input', data: 'echo canary-$((20+22))\r' }))
	await sleep(800)
	if (!a.output.includes('canary-42')) throw new Error(`A: echo not seen. got: ${a.output.slice(-300)}`)
	console.log('PASS: input + output round trip')

	const b = connect()
	await sleep(800)
	if (!b.output.includes('canary-42')) throw new Error('B: scrollback replay missing')
	console.log('PASS: second client got scrollback replay')

	b.ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }))
	await sleep(500)
	if (!a.control.some((m) => m.type === 'resize' && m.cols === 100 && m.rows === 30))
		throw new Error('A: resize not fanned out')
	console.log('PASS: resize fan-out to all clients')

	b.ws.send(JSON.stringify({ type: 'input', data: 'echo from-b\r' }))
	await sleep(500)
	if (!a.output.includes('from-b')) throw new Error('A: did not see B typing')
	console.log('PASS: both clients can type into one session')

	a.ws.close()
	b.ws.close()
	await sleep(500)
	const tmuxLs = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}']).toString()
	if (!tmuxLs.includes(`canvas-${SESSION}`)) throw new Error('tmux session died with clients')
	console.log('PASS: tmux session survives all clients closing')

	const c = connect()
	await sleep(800)
	if (!c.output.includes('from-b')) throw new Error('C: reattach replay missing')
	console.log('PASS: reattach after full disconnect shows prior screen')
	c.ws.close()

	execFileSync('tmux', ['kill-session', '-t', `canvas-${SESSION}`])
	console.log('ALL TERMINAL GATEWAY SMOKE TESTS PASSED')
	process.exit(0)
}

main().catch((err) => {
	console.error('FAIL:', err.message)
	process.exit(1)
})
