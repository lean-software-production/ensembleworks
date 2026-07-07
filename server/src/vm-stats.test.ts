// Tests for the VM-pressure reading and the /api/av/pulse heartbeat.
// Run with: bun src/vm-stats.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSyncApp } from './app.ts'
import { _internal, readVmStats } from './vm-stats.ts'

async function main() {
	// --- PSI "some avg10" parsing --------------------------------------------
	const { parsePressureSome } = _internal
	assert.equal(
		parsePressureSome('some avg10=0.40 avg60=0.13 avg300=0.03 total=181987359\nfull avg10=0.00'),
		0.4,
		'reads the "some" avg10'
	)
	assert.equal(parsePressureSome('full avg10=1.00 avg60=0.5'), null, 'no "some" line → null')
	assert.equal(parsePressureSome('garbage'), null, 'unparseable → null')

	// --- readVmStats shape ----------------------------------------------------
	// Works on any Linux/non-Linux box: cgroup slice when present, else host
	// memory. We assert the contract, not exact numbers.
	const vm = readVmStats()
	assert.ok(vm.cpu.cores >= 1, 'at least one core')
	assert.ok(vm.cpu.pct >= 0 && vm.cpu.pct <= 100, 'cpu pct in [0,100]')
	assert.ok(vm.mem.usedBytes > 0, 'some memory in use')
	assert.ok(vm.mem.usedPct >= 0 && vm.mem.usedPct <= 100, 'mem pct in [0,100]')
	assert.ok(vm.mem.source === 'cgroup' || vm.mem.source === 'host', 'mem source is tagged')
	// Second call within the cache window returns the identical object.
	assert.equal(readVmStats(), vm, 'reading is cached (~2s)')

	// --- POST /api/av/pulse contract --------------------------------------------
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pulse-test-'))
	const { server } = createSyncApp({ dataDir })
	await new Promise<void>((resolve) => server.listen(0, resolve))
	const addr = server.address()
	assert.ok(addr && typeof addr === 'object')
	const base = `http://127.0.0.1:${addr.port}`

	const post = (body: unknown) =>
		fetch(`${base}/api/av/pulse`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})

	// First pulse with no rtt yet: VM reading present, latency map empty.
	{
		const res = await post({ room: 'team', userId: 'user:alice', rttMs: null })
		assert.equal(res.status, 200)
		const body = (await res.json()) as any
		assert.ok(body.vm?.cpu && body.vm?.mem, 'pulse carries a VM reading')
		assert.deepEqual(body.latencies, {}, 'no rtt reported yet → empty map')
	}

	// Reporting a sample stores it under the raw user id and reads back.
	{
		const res = await post({ room: 'team', userId: 'user:alice', rttMs: 42.7 })
		const body = (await res.json()) as any
		assert.equal(body.latencies.alice?.rtt, 43, 'rtt rounded and keyed by raw id')
	}

	// A second user shows alongside the first.
	{
		const res = await post({ room: 'team', userId: 'bob', rttMs: 200 })
		const body = (await res.json()) as any
		assert.equal(body.latencies.bob?.rtt, 200)
		assert.equal(body.latencies.alice?.rtt, 43, 'both users present')
	}

	// Garbage rtt is ignored, not stored.
	{
		const res = await post({ room: 'team', userId: 'carol', rttMs: 'nope' })
		const body = (await res.json()) as any
		assert.equal(body.latencies.carol, undefined, 'non-numeric rtt is dropped')
	}

	// Bad room id → 400.
	{
		const res = await post({ room: 'bad!', userId: 'alice', rttMs: 10 })
		assert.equal(res.status, 400)
	}

	await new Promise<void>((resolve) => server.close(() => resolve()))
	console.log('vm-stats.test.ts: OK')
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
