/**
 * EnsembleWorks terminal gateway.
 *
 * Bridges browser xterm.js instances to tmux sessions on this VM. The gateway
 * holds exactly ONE tmux client (a PTY) per canvas session and fans its
 * output out to every attached WebSocket, so all viewers see identical bytes.
 * tmux is the substrate: sessions survive the gateway, the browser, and are
 * reachable from a plain `ssh` + `tmux attach -t canvas-<id>`.
 *
 * Routes (Caddy proxies /api/terminal/* here):
 *   GET    /api/terminal/health
 *   GET    /api/terminal/sessions        – live gateway sessions + detached tmux ones
 *   DELETE /api/terminal/sessions/:id    – kill the underlying tmux session
 *   WS     /api/terminal/ws?session=ID&cols=N&rows=N
 *
 * Wire protocol: see @ensembleworks/contracts terminal-protocol
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import http from 'node:http'
import type { Socket } from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import {
	termClientMessage,
	TMUX_SESSION_PREFIX,
	type TermServerMessage,
} from '@ensembleworks/contracts'
import { canvasTmuxSpawnSpec, openTmuxSession, type TmuxSession } from '@ensembleworks/contracts/session-manager'
import { WebSocketServer, type WebSocket } from 'ws'

const PORT = Number(process.env.PORT ?? 8789)
const SCROLLBACK_LIMIT = 256 * 1024 // bytes replayed to newly attached clients
const HEARTBEAT_INTERVAL_MS = 20_000

// Omarchy-derived tmux config (see deploy/tmux-ensembleworks.conf). `-f` only
// takes effect when the tmux *server* starts; for an already-running server
// apply it with `tmux source-file <conf>`.
const TMUX_CONF =
	process.env.TMUX_CONF ?? path.resolve(import.meta.dirname, '../../deploy/tmux-ensembleworks.conf')
const TMUX_BASE_ARGS = existsSync(TMUX_CONF) ? ['-f', TMUX_CONF] : []

// Privilege separation. When TERM_RUN_AS is set, every terminal shell is dropped
// to that (less-privileged) user via sudo, so canvas terminals can't read the app
// user's home — releases, build.env, the neko/LiveKit secrets. The gateway itself
// stays as the app user because it must read its own code from that 700 home; only
// the leaf pty drops privilege. A fixed host-provisioned launcher (allowed by a
// narrow NOPASSWD sudoers rule) does the `cd $HOME` + `exec tmux …` with a box-wide
// tmux.conf the sandbox user can read — keeping the privileged surface to one
// binary. Unset (legacy -ash box, local dev) → shells run as the gateway user,
// exactly as before. See deploy/systemd/prod/ensembleworks-term.service.
const RUN_AS = process.env.TERM_RUN_AS?.trim() ?? ''
const TERM_LAUNCHER = process.env.TERM_LAUNCHER ?? '/usr/local/bin/ensembleworks-term-launch'

const execFileP = promisify(execFile)

// How to spawn the tmux client for a session — directly as the gateway user, or
// dropped to the sandbox user via sudo. Split out so getOrCreateSession stays
// readable. When dropping, sudo's env_reset strips the gateway's environment and
// -H points HOME at the sandbox user; the launcher owns the conf + `cd`, so we
// pass a deliberately bare env and a neutral cwd (the gateway user may not be able
// to chdir into the sandbox user's home).
function tmuxSpawnSpec(id: string): {
	file: string
	args: string[]
	cwd: string
	env: Record<string, string>
} {
	const sessionName = `${TMUX_SESSION_PREFIX}${id}`
	if (RUN_AS) {
		return {
			file: 'sudo',
			args: ['-n', '-H', '-u', RUN_AS, '--', TERM_LAUNCHER, sessionName],
			cwd: '/',
			env: { TERM: 'xterm-256color' },
		}
	}
	return canvasTmuxSpawnSpec({ sessionId: id, tmuxConf: TMUX_CONF, home: process.env.HOME })
}

// One-shot startup check: when TERM_RUN_AS is set, confirm the gateway can sudo to
// it. On failure we log loudly but do NOT downgrade to the privileged gateway user
// — sessions simply fail to spawn (fail closed) until the host grants the sudoers
// rule, which is the safe posture for a segregation feature.
function probeRunAs(): void {
	if (!RUN_AS) {
		console.log('[term] TERM_RUN_AS unset — terminals run as the gateway user')
		return
	}
	execFile('sudo', ['-n', '-u', RUN_AS, 'true'], (err) => {
		if (err) {
			console.error(
				`[term] WARNING: TERM_RUN_AS=${RUN_AS} but \`sudo -n -u ${RUN_AS}\` failed — ` +
					'terminal sessions will NOT start until the host grants the NOPASSWD sudoers ' +
					'rule for the launcher. Refusing to fall back to the privileged gateway user. ' +
					`(${err.message})`
			)
		} else {
			console.log(`[term] terminals drop to '${RUN_AS}' via sudo (launcher: ${TERM_LAUNCHER})`)
		}
	})
}

interface TermSession {
	id: string
	pty: TmuxSession
	clients: Set<WebSocket>
	scrollback: Buffer[]
	scrollbackBytes: number
}

const sessions = new Map<string, TermSession>()

function sanitizeId(id: string): string | null {
	return /^[a-zA-Z0-9_-]{1,48}$/.test(id) ? id : null
}

function getOrCreateSession(id: string, cols: number, rows: number): TermSession {
	const existing = sessions.get(id)
	if (existing) return existing

	const proc = openTmuxSession(tmuxSpawnSpec(id), cols, rows)

	const session: TermSession = {
		id,
		pty: proc,
		clients: new Set(),
		scrollback: [],
		scrollbackBytes: 0,
	}

	proc.onData((data) => {
		const buf = Buffer.from(data, 'utf8')
		session.scrollback.push(buf)
		session.scrollbackBytes += buf.byteLength
		while (session.scrollbackBytes > SCROLLBACK_LIMIT && session.scrollback.length > 1) {
			session.scrollbackBytes -= session.scrollback.shift()!.byteLength
		}
		for (const ws of session.clients) {
			if (ws.readyState === ws.OPEN) ws.send(buf, { binary: true })
		}
	})

	proc.onExit(() => {
		console.log(`[term ${id}] tmux client exited`)
		const exitMsg: TermServerMessage = { type: 'exit' }
		for (const ws of session.clients) {
			if (ws.readyState === ws.OPEN) {
				ws.send(JSON.stringify(exitMsg))
				ws.close()
			}
		}
		sessions.delete(id)
	})

	sessions.set(id, session)
	console.log(`[term ${id}] spawned tmux client (${cols}x${rows})`)
	return session
}

function resizeSession(session: TermSession, cols: number, rows: number) {
	if (!session.pty.resize(cols, rows)) return
	// Authoritative size fan-out: every viewer converges on the same grid.
	const resizeMsg: TermServerMessage = { type: 'resize', cols: session.pty.cols, rows: session.pty.rows }
	const msg = JSON.stringify(resizeMsg)
	for (const ws of session.clients) {
		if (ws.readyState === ws.OPEN) ws.send(msg)
	}
}

async function listTmuxSessions(): Promise<string[]> {
	try {
		const { stdout } = await execFileP('tmux', ['list-sessions', '-F', '#{session_name}'])
		return stdout
			.split('\n')
			.filter((name) => name.startsWith(TMUX_SESSION_PREFIX))
			.map((name) => name.slice(TMUX_SESSION_PREFIX.length))
	} catch {
		return [] // no tmux server running yet
	}
}

// ---------------------------------------------------------------------------
// HTTP + WS plumbing
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url ?? '', 'http://internal')
	res.setHeader('content-type', 'application/json')

	if (req.method === 'GET' && url.pathname === '/api/terminal/health') {
		res.end(JSON.stringify({ ok: true, sessions: sessions.size }))
		return
	}

	if (req.method === 'GET' && url.pathname === '/api/terminal/sessions') {
		const detached = await listTmuxSessions()
		const all = new Map<string, { id: string; attachedClients: number }>()
		for (const id of detached) all.set(id, { id, attachedClients: 0 })
		for (const s of sessions.values()) all.set(s.id, { id: s.id, attachedClients: s.clients.size })
		res.end(JSON.stringify({ sessions: [...all.values()] }))
		return
	}

	const killMatch = url.pathname.match(/^\/api\/terminal\/sessions\/([^/]+)$/)
	if (req.method === 'DELETE' && killMatch) {
		const id = sanitizeId(killMatch[1]!)
		if (!id) {
			res.statusCode = 400
			res.end(JSON.stringify({ error: 'bad session id' }))
			return
		}
		try {
			await execFileP('tmux', ['kill-session', '-t', `${TMUX_SESSION_PREFIX}${id}`])
		} catch {
			// already gone
		}
		res.end(JSON.stringify({ ok: true }))
		return
	}

	res.statusCode = 404
	res.end(JSON.stringify({ error: 'not found' }))
})

const wss = new WebSocketServer({ noServer: true })
const aliveClients = new WeakMap<WebSocket, boolean>()

// Detect half-open proxy/network connections. Browser WebSockets answer ping
// frames automatically; terminating a missed heartbeat triggers client retry.
const heartbeat = setInterval(() => {
	for (const ws of wss.clients) {
		if (ws.readyState !== ws.OPEN) continue
		if (aliveClients.get(ws) === false) {
			ws.terminate()
			continue
		}
		aliveClients.set(ws, false)
		ws.ping()
	}
}, HEARTBEAT_INTERVAL_MS)
heartbeat.unref()

server.on('upgrade', (req, socket, head) => {
	const url = new URL(req.url ?? '', 'http://internal')
	if (url.pathname !== '/api/terminal/ws') {
		socket.destroy()
		return
	}
	const id = sanitizeId(url.searchParams.get('session') ?? '')
	const cols = Number(url.searchParams.get('cols') ?? 80)
	const rows = Number(url.searchParams.get('rows') ?? 24)
	if (!id) {
		socket.destroy()
		return
	}

	// Terminal traffic is a stream of tiny frames — a keystroke up, a one-char
	// echo back. Node sockets default to Nagle on, which can park those small
	// echo frames for ~40ms waiting to coalesce, adding to every round-trip on
	// top of raw network RTT. Disable it so characters paint as fast as the link
	// allows (most noticeable for far-region users). The upgrade event types
	// `socket` as a generic Duplex; over an HTTP/TCP server it is a net.Socket.
	;(socket as Socket).setNoDelay(true)

	wss.handleUpgrade(req, socket, head, (ws) => {
		aliveClients.set(ws, true)
		ws.on('pong', () => aliveClients.set(ws, true))
		const session = getOrCreateSession(id, cols || 80, rows || 24)

		// Bring the newcomer up to speed: current grid size, then the recent
		// output so the screen renders immediately (tmux also repaints on its
		// next output, which papers over any escape sequences cut mid-stream).
		const attachedMsg: TermServerMessage = { type: 'attached', cols: session.pty.cols, rows: session.pty.rows }
		ws.send(JSON.stringify(attachedMsg))
		if (session.scrollback.length > 0) {
			ws.send(Buffer.concat(session.scrollback), { binary: true })
		}
		session.clients.add(ws)
		console.log(`[term ${id}] client attached (${session.clients.size} attached)`)

		ws.on('message', (raw, isBinary) => {
			if (isBinary) return
			let parsed: unknown
			try {
				parsed = JSON.parse(raw.toString())
			} catch {
				return
			}
			const result = termClientMessage.safeParse(parsed)
			if (!result.success) return
			const msg = result.data
			if (msg.type === 'input') {
				session.pty.write(msg.data)
			} else if (msg.type === 'resize') {
				resizeSession(session, msg.cols, msg.rows)
			}
		})

		ws.on('close', () => {
			session.clients.delete(ws)
			console.log(`[term ${id}] client detached (${session.clients.size} attached)`)
			// The pty (and tmux session) intentionally stays alive with zero
			// clients — closing every browser must not kill the session (M1
			// exit criterion).
		})
	})
})

server.listen(PORT, () => {
	console.log(`ensembleworks terminal gateway listening on :${PORT}`)
	probeRunAs()
})
