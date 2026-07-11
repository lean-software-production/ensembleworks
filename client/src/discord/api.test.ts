import assert from 'node:assert/strict'
import { bindingsUrl, deleteBindingUrl } from './api'

assert.equal(bindingsUrl('planning'), '/api/discord/bindings?room=planning')
assert.equal(bindingsUrl('a b'), '/api/discord/bindings?room=a+b')
// id is a query param, not a path segment — the server route is DELETE
// /api/discord/bindings?id= (see contracts/tools/discord.ts; a `:id` path is not
// renderable by the CLI's generic tool renderer).
assert.equal(deleteBindingUrl('abc-123'), '/api/discord/bindings?id=abc-123')
assert.equal(deleteBindingUrl('a/b'), '/api/discord/bindings?id=a%2Fb')
console.log('ok: discord api builders')
