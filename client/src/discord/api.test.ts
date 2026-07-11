import assert from 'node:assert/strict'
import { bindingsUrl, deleteBindingUrl } from './api'

assert.equal(bindingsUrl('planning'), '/api/discord/bindings?room=planning')
assert.equal(bindingsUrl('a b'), '/api/discord/bindings?room=a+b')
assert.equal(deleteBindingUrl('abc-123'), '/api/discord/bindings?id=abc-123')
assert.equal(deleteBindingUrl('a/b'), '/api/discord/bindings?id=a%2Fb')
console.log('ok: discord api builders')
