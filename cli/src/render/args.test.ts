// argv → request (§6.2): positional primary args in the reconciled required-
// first-then-optional slot order (sticky "hi"; terminal status a working;
// scribe say <identity> <text> with text at slot 1 skipping optional `name`;
// roadmap read <name> with OPTIONAL name at slot 0); the scalar-slot rule
// (roadmap.write's required `ops` array claims no slot); JSON-body spread
// (shape, roadmap write); kebab→camel flags; @file loader; room injection;
// GET→query vs POST→body. Run with: bun src/render/args.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { allTools, type ManifestEntry, toManifestEntry } from '@ensembleworks/contracts'
import type { Conn } from '../resolve.ts'
import { buildRequest } from './args.ts'

const entry = (plugin: string, id: string): ManifestEntry => {
	const def = allTools.find((t) => t.plugin === plugin && t.id === id)
	if (!def) throw new Error(`no such tool ${plugin}.${id}`)
	return toManifestEntry(def)
}
const conn: Conn = { url: 'http://localhost:8788', room: 'team', auth: { method: 'none' } }

// sticky "hi" → text positional; room injected; POST→json.
{
	const req = buildRequest(entry('canvas', 'sticky'), ['hi'], conn)
	assert.equal(req.method, 'POST')
	assert.equal(req.path, '/api/canvas/sticky')
	assert.deepEqual(req.json, { text: 'hi', room: 'team' })
}

// terminal status <session-id> <status> → both required scalars positional.
{
	const req = buildRequest(entry('terminal', 'status'), ['crew-a', 'working'], conn)
	assert.deepEqual(req.json, { sessionId: 'crew-a', status: 'working', room: 'team' })
}

// scribe say <identity> <text> → required-first order puts text at slot 1,
// SKIPPING the optional `name` declared between identity and text.
{
	const req = buildRequest(entry('scribe', 'say'), ['user-7', 'hello there'], conn)
	assert.equal(req.json?.identity, 'user-7', 'slot 0 → identity')
	assert.equal(req.json?.text, 'hello there', 'slot 1 → text, not the optional name')
	assert.equal(req.json?.name, undefined, 'optional name is not positionally filled here')
}

// roadmap read <name> → OPTIONAL name reachable at slot 0; GET→query.
{
	const req = buildRequest(entry('roadmap', 'read'), ['Product Roadmap'], conn)
	assert.equal(req.method, 'GET')
	assert.deepEqual(req.query, { name: 'Product Roadmap', room: 'team' })
}
// roadmap read (no name) → list (only room).
{
	const req = buildRequest(entry('roadmap', 'read'), [], conn)
	assert.deepEqual(req.query, { room: 'team' })
}

// roadmap write <name> --ops '<json>' → required `ops` array claims NO positional
// slot: name is the only positional; --ops is a JSON-valued flag.
{
	const req = buildRequest(entry('roadmap', 'write'), ['My Roadmap', '--ops', '[{"op":"set","key":"O1","fields":{}}]'], conn)
	assert.equal(req.json?.name, 'My Roadmap')
	assert.deepEqual(req.json?.ops, [{ op: 'set', key: 'O1', fields: {} }])
}

// JSON-body spread: a lone JSON-object positional, no flags → spread as the body.
{
	const req = buildRequest(entry('canvas', 'shape'), ['{"type":"geo","text":"retry bug","x":100,"y":80}'], conn)
	assert.deepEqual(req.json, { type: 'geo', text: 'retry bug', x: 100, y: 80, room: 'team' })
}

// kebab→camel: --if-rev → ifRev, --session-id → sessionId.
{
	const req = buildRequest(entry('roadmap', 'write'), ['R', '--ops', '[{"op":"set","key":"O1","fields":{}}]', '--if-rev', '4'], conn)
	assert.equal(req.json?.ifRev, 4, '--if-rev coerced to number ifRev')
}
{
	const req = buildRequest(entry('terminal', 'status'), ['--session-id', 's1', '--status', 'done'], conn)
	assert.deepEqual(req.json, { sessionId: 's1', status: 'done', room: 'team' })
}

// --field @file loads a field from a file.
{
	const dir = mkdtempSync(path.join(os.tmpdir(), 'ew-args-'))
	const opsFile = path.join(dir, 'ops.json')
	writeFileSync(opsFile, '[{"op":"replace","data":{"meta":{"title":"T"},"outcomes":[]}}]')
	const req = buildRequest(entry('roadmap', 'write'), ['R', '--ops', `@${opsFile}`], conn)
	assert.deepEqual((req.json?.ops as unknown[])[0], { op: 'replace', data: { meta: { title: 'T' }, outcomes: [] } })
}

// GET with query: kernel participants --page.
{
	const req = buildRequest(entry('kernel', 'participants'), ['--page', 'page:main'], conn)
	assert.equal(req.method, 'GET')
	assert.deepEqual(req.query, { page: 'page:main', room: 'team' })
}

// Guard: an unsubstituted `:param` path segment must throw, not silently ship a
// literal `:id` to the server (which would no-op and report ok). buildRequest
// does not substitute path params, so no manifest tool may declare one — this is
// the runtime backstop for the contract-level no-`:`-path invariant (tools.test.ts).
{
	const pathParamEntry: ManifestEntry = {
		plugin: 'discord', id: 'unbind', method: 'DELETE', path: '/api/discord/bindings/:id',
		help: 'x', input: { type: 'object', properties: { id: { type: 'string' } } }, output: {},
	}
	assert.throws(() => buildRequest(pathParamEntry, ['abc'], conn), /path param|:id|substitut/i, 'unsubstituted :param path must throw')
}

console.log('ok: args — positional required-first order, scalar-slot rule, JSON spread, kebab→camel, @file, room inject, method→location, path-param guard')
