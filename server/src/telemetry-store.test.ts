// Unit tests for the connection-telemetry JSONL store.
// Run with: bun src/telemetry-store.test.ts
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTelemetryStore } from './telemetry-store.ts'

async function main() {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'tel-'))
	const store = createTelemetryStore(dir, 200) // tiny rotate cap for the test

	await store.append('team', { userId: 'u1', plane: 'livekit', event: 'disconnected', detail: { reason: 3 } })
	await store.append('team', { userId: 'u1', plane: 'sync', event: 'offline' })

	const file = path.join(dir, 'team-connection.jsonl')
	const lines = (await readFile(file, 'utf8')).trim().split('\n')
	assert.equal(lines.length, 2, 'two events appended')
	const first = JSON.parse(lines[0]!)
	assert.equal(first.roomId, 'team')
	assert.equal(first.plane, 'livekit')
	assert.equal(first.event, 'disconnected')
	assert.equal(typeof first.t, 'number', 'server-stamped timestamp')

	// Cross the 200-byte cap → the live file rotates to .1 and starts fresh.
	for (let i = 0; i < 20; i++) await store.append('team', { userId: 'u1', plane: 'sync', event: 'online' })
	await stat(`${file}.1`) // throws if rotation didn't happen

	console.log('ok: telemetry-store')
}

main()
