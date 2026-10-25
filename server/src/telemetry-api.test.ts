// POST /api/telemetry/connection: validate a batch, append per room.
// Run with: bun src/telemetry-api.test.ts
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSyncApp } from './app.ts'

async function main() {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tel-api-'))
	const { server } = createSyncApp({ dataDir })
	await new Promise<void>((r) => server.listen(0, () => r()))
	const { port } = server.address() as { port: number }
	const url = `http://127.0.0.1:${port}/api/telemetry/connection`

	// A valid batch — including the 'lock' plane (canvas-lock transitions) —
	// with one junk event mixed in (junk is skipped, not fatal). The junk
	// event's plane, 'nope', is a check that the gate is still a closed union:
	// widening it to admit 'lock' must not have loosened it to admit anything.
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			events: [
				{ roomId: 'team', userId: 'u1', plane: 'livekit', event: 'reconnecting' },
				{ roomId: 'team', userId: 'u1', plane: 'sync', event: 'offline', detail: { code: 1006 } },
				{ roomId: 'team', userId: 'u1', plane: 'lock', event: 'granted' },
				{ plane: 'nope', event: '' }, // invalid → skipped
			],
		}),
	})
	assert.equal(res.status, 200)
	const summary = (await res.json()) as { written: number }
	assert.equal(summary.written, 3, 'three valid events written, junk skipped')

	const file = path.join(dataDir, 'telemetry', 'team-connection.jsonl')
	const lines = (await readFile(file, 'utf8')).trim().split('\n')
	assert.equal(lines.length, 3)
	assert.equal(JSON.parse(lines[1]!).event, 'offline')
	assert.equal(JSON.parse(lines[2]!).plane, 'lock')
	assert.equal(JSON.parse(lines[2]!).event, 'granted')

	// Empty batch → 400.
	const bad = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ events: [] }),
	})
	assert.equal(bad.status, 400)

	console.log('ok: telemetry-api')
	server.close()
	process.exit(0)
}

main()
