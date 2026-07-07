// resolveFileArg: PWD-relative → home-relative; ~ and abs-under-home accepted;
// abs-outside-home and traversal-out rejected.
// Run with: bun src/native/file.test.ts
import assert from 'node:assert/strict'
import { resolveFileArg } from './file.ts'

const home = '/home/agent'
// relative to a cwd inside home
assert.equal(resolveFileArg('docs/r.html', '/home/agent/my-repo', home), 'my-repo/docs/r.html')
// already home-rooted forms
assert.equal(resolveFileArg('~/docs/r.html', '/anywhere', home), 'docs/r.html')
assert.equal(resolveFileArg('/home/agent/docs/r.html', '/anywhere', home), 'docs/r.html')
// cwd at home root
assert.equal(resolveFileArg('r.html', '/home/agent', home), 'r.html')
// .. that stays inside home is fine after resolution
assert.equal(resolveFileArg('../docs/r.html', '/home/agent/my-repo', home), 'docs/r.html')
// escapes
assert.equal(resolveFileArg('/etc/passwd', '/home/agent', home), null)
assert.equal(resolveFileArg('../../etc/passwd', '/home/agent', home), null)
// home itself is a directory, not a file
assert.equal(resolveFileArg('~/', '/anywhere', home), null)
// sibling-prefix dir must not relativise
assert.equal(resolveFileArg('/home/agentx/f.html', '/anywhere', home), null)

console.log('ok: cli file resolveFileArg')
