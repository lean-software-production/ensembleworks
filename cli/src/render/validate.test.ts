// D4 posture (§7.2): BLOCK (throw CliError exit 2) on unknown flag / missing
// required / a value that cannot coerce to the schema type; WARN-and-send on
// value constraints (enum / min / max). Run with: bun src/render/validate.test.ts
import assert from 'node:assert/strict'
import { allTools, type ManifestEntry, toManifestEntry } from '@ensembleworks/contracts'
import { CliError } from '../errors.ts'
import type { Conn } from '../resolve.ts'
import { buildRequest } from './args.ts'

const entry = (plugin: string, id: string): ManifestEntry =>
	toManifestEntry(allTools.find((t) => t.plugin === plugin && t.id === id)!)
const conn: Conn = { url: 'http://localhost:8788', room: 'team', auth: { method: 'none' } }
const isBlock = (e: unknown) => e instanceof CliError && (e as CliError).exitCode === 2

// BLOCK: unknown flag.
assert.throws(() => buildRequest(entry('canvas', 'sticky'), ['hi', '--bogus', 'x'], conn), isBlock)

// BLOCK: missing required (terminal status needs sessionId AND status).
assert.throws(() => buildRequest(entry('terminal', 'status'), ['only-one'], conn), isBlock)

// BLOCK: a non-numeric value for a number field (avPulse.rttMs is a number).
assert.throws(() => buildRequest(entry('av', 'pulse'), ['--rtt-ms', 'not-a-number'], conn), isBlock)

// WARN-and-send: an out-of-enum status is a value constraint — the request is
// STILL built (server is the authority), and a warning is emitted to stderr.
{
	const captured: string[] = []
	const realWrite = process.stderr.write.bind(process.stderr)
	;(process.stderr as any).write = (s: string) => { captured.push(String(s)); return true }
	let req: ReturnType<typeof buildRequest>
	try {
		req = buildRequest(entry('terminal', 'status'), ['s1', 'bogus-status'], conn)
	} finally {
		;(process.stderr as any).write = realWrite
	}
	assert.equal(req.json?.status, 'bogus-status', 'the request is still built with the value')
	assert.ok(captured.some((l) => l.includes('warning') && l.includes('status')), 'a warning was emitted for the enum violation')
}

console.log('ok: validate — blocks unknown-flag/missing-required/bad-type, warns-and-sends on value constraints')
