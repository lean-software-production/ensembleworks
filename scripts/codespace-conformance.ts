// Codespace conformance smoke (coexistence spec §7 / decision #9): boots each
// fixture repo as a REAL EW Codespace via the real `ew codespace up` and
// asserts the interesting failure surface — repo → container → CONNECTOR →
// canvas — not repo → container alone (design §1). Also the permanent gate on
// bumping the vendored @devcontainers/cli pin.
//
// REQUIRES docker + network (image/feature pulls). Deliberately NOT *.test.ts:
// no test glob spawns it. Run by hand: bun scripts/codespace-conformance.ts
// Cleanup is by exact stored container ids only — never a filter.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { createSyncApp } from '../server/src/app.ts'

const repoRoot = path.join(import.meta.dir, '..')
const FIXTURES = ['codespace-basic', 'codespace-features']

const openSocket = (url: string) =>
	new Promise<WebSocket>((resolve, reject) => {
		const ws = new WebSocket(url)
		ws.once('open', () => resolve(ws))
		ws.once('error', reject)
	})

const firstText = (ws: WebSocket) =>
	new Promise<any>((resolve) => {
		const h = (data: Buffer, isBinary: boolean) => {
			if (isBinary) return
			ws.off('message', h)
			resolve(JSON.parse(data.toString()))
		}
		ws.on('message', h)
	})

function waitForOutput(ws: WebSocket, needle: string, timeoutMs = 30_000): Promise<string> {
	return new Promise((resolve, reject) => {
		let acc = ''
		const handler = (data: Buffer, isBinary: boolean) => {
			if (!isBinary) return
			acc += data.toString()
			if (acc.includes(needle)) {
				clearTimeout(timer)
				ws.off('message', handler)
				resolve(acc)
			}
		}
		const timer = setTimeout(() => {
			ws.off('message', handler)
			reject(new Error(`timeout waiting for ${JSON.stringify(needle)}; got: ${acc.slice(-500)}`))
		}, timeoutMs)
		ws.on('message', handler)
	})
}

async function waitForGateway(httpBase: string, id: string, timeoutMs = 180_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${httpBase}/api/terminal/list`)
			const body = (await res.json()) as { gateways: Array<{ gatewayId: string }> }
			if (body.gateways.some((g) => g.gatewayId === id)) return
		} catch {
			// server warming up — retry
		}
		await new Promise((r) => setTimeout(r, 500))
	}
	throw new Error(`gateway ${id} did not register within ${timeoutMs}ms`)
}

const run = (argv: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) => {
	console.error(`\n$ ${argv.join(' ')}`)
	return Bun.spawnSync(argv, { cwd: opts.cwd, env: opts.env, stdout: 'pipe', stderr: 'inherit' })
}

async function main() {
	// 0. Build the connector binary ONCE (decision #4: tests build once and set
	// the override). build:binary emits cli/dist/ensembleworks (glibc x64).
	{
		const build = Bun.spawnSync(['bun', 'run', '--filter', '@ensembleworks/cli', 'build:binary'], {
			cwd: repoRoot,
			stdout: 'inherit',
			stderr: 'inherit',
		})
		assert.equal(build.exitCode, 0, 'connector build:binary failed')
	}
	const connectorBin = path.join(repoRoot, 'cli', 'dist', 'ensembleworks')

	// 1. Boot the sync app (the splice plane) on an ephemeral port.
	const dataDir = mkdtempSync(path.join(os.tmpdir(), 'codespace-conformance-server-'))
	const { server } = createSyncApp({ dataDir }) as { server: http.Server }
	await new Promise<void>((resolve) => server.listen(0, resolve))
	const port = (server.address() as { port: number }).port
	const httpBase = `http://127.0.0.1:${port}`
	const cliMain = path.join(repoRoot, 'cli', 'src', 'main.ts')

	const cleanupContainerIds: string[] = []
	let failed = false
	try {
		for (const fixture of FIXTURES) {
			console.error(`\n=== fixture: ${fixture} ===`)
			// 2. Copy the fixture to a fresh workspace (unique realpath → unique
			// gatewayId) with fully isolated XDG dirs per fixture.
			const workRoot = mkdtempSync(path.join(os.tmpdir(), `codespace-conformance-${fixture}-`))
			const workspace = path.join(workRoot, fixture)
			cpSync(path.join(repoRoot, 'scripts', 'fixtures', fixture), workspace, { recursive: true })
			run(['git', 'init', '-b', 'conformance', workspace])
			run(['git', '-c', 'user.email=c@c', '-c', 'user.name=c', 'commit', '--allow-empty', '-m', 'x'], { cwd: workspace })
			const env: Record<string, string> = {
				...(process.env as Record<string, string>),
				XDG_CONFIG_HOME: path.join(workRoot, 'config'),
				XDG_DATA_HOME: path.join(workRoot, 'data'),
				XDG_CACHE_HOME: path.join(workRoot, 'cache'),
				EW_CONNECTOR_BIN: connectorBin,
				ENSEMBLEWORKS_URL: httpBase,
			}

			// 3. Read the plan (also proves --dry-run on a real repo) → gatewayId.
			const dry = run(['bun', cliMain, 'codespace', 'up', '--dry-run'], { cwd: workspace, env })
			assert.equal(dry.exitCode, 0, 'codespace up --dry-run failed')
			const plan = JSON.parse(dry.stdout.toString()) as { gatewayId: string; workspaceFolder: string }
			console.error(`gatewayId: ${plan.gatewayId}`)

			// 4. The real thing, in the background: up → inject → exec → supervise.
			const upProc = Bun.spawn(['bun', cliMain, 'codespace', 'up'], {
				cwd: workspace,
				env,
				stdout: 'inherit',
				stderr: 'inherit',
			})
			try {
				// 5. Terminal reaches the canvas: registration, then echo round-trip.
				await waitForGateway(httpBase, plan.gatewayId)
				const relayUrl = `ws://127.0.0.1:${port}/api/terminal/relay?session=conf${Date.now().toString(36)}&gateway=${plan.gatewayId}&cols=80&rows=24`
				const b = await openSocket(relayUrl)
				const attached = await firstText(b)
				assert.equal(attached.type, 'attached', 'relay attach handshake')
				const marker = `conformance-ok-${fixture}`
				const echoed = waitForOutput(b, marker)
				b.send(JSON.stringify({ type: 'input', data: `echo ${marker}\r` }))
				await echoed
				b.close()
				console.error(`fixture ${fixture}: echo round-trip OK`)

				// 6. Stored containerId (written by the live engine) → exact-id checks.
				const store = JSON.parse(
					readFileSync(path.join(env.XDG_CONFIG_HOME, 'ensembleworks', 'codespaces.json'), 'utf8'),
				) as { codespaces: Record<string, { containerId?: string }> }
				const containerId = store.codespaces[plan.workspaceFolder]?.containerId
				assert.ok(containerId, 'live engine stored the containerId')
				cleanupContainerIds.push(containerId)
			} finally {
				upProc.kill('SIGINT') // foreground supervisor exits 0 on clean signal
				await upProc.exited
			}

			// 7. Stop by exact id and verify not running.
			const stop = run(['bun', cliMain, 'codespace', 'stop'], { cwd: workspace, env })
			assert.equal(stop.exitCode, 0, 'codespace stop failed')
			const inspect = run(['docker', 'inspect', '-f', '{{.State.Running}}', cleanupContainerIds.at(-1) as string])
			assert.equal(inspect.stdout.toString().trim(), 'false', 'container stopped (exact-id inspect)')
			console.error(`fixture ${fixture}: PASS`)
		}
	} catch (err) {
		failed = true
		console.error(err)
	} finally {
		// Cleanup by EXACT ids only (decision #9) — never a filter.
		for (const id of cleanupContainerIds) run(['docker', 'rm', '-f', id])
		server.close()
	}
	if (failed) process.exit(1)
	console.log(`codespace-conformance: all ${FIXTURES.length} fixtures passed (vendored @devcontainers/cli ${readFileSync(path.join(repoRoot, 'cli', 'vendor', 'devcontainers-cli', 'VERSION'), 'utf8').trim()})`)
	process.exit(0)
}

main()
