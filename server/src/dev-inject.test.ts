/** Dev-page injection: recorder bridge + URL patch + error reporter into HTML only. Run: bun server/src/dev-inject.test.ts */
import assert from 'node:assert/strict'
import { injectDevPage, urlPatchScript } from './dev-inject.ts'

{
	const out = injectDevPage('<!doctype html><html><head></head><body><div id=app></div></body></html>', 3000)
	assert.ok(out.includes('/files-assets/rrweb.js'), 'rrweb asset tag injected')
	assert.ok(out.includes('ew-present-start'), 'recorder bridge injected')
	assert.ok(out.includes('/dev/3000'), 'URL patch carries the port prefix')
	assert.ok(out.includes('ew-dev-error'), 'error reporter injected')
	assert.ok(out.indexOf('</body>') > out.indexOf('ew-present-start'), 'injected before closing body')
}
{
	// No </body>: append (same contract as injectBridge).
	const out = injectDevPage('<p>bare fragment', 3000)
	assert.ok(out.startsWith('<p>bare fragment'), 'original content first')
	assert.ok(out.includes('ew-dev-error'), 'still injected')
}
{
	const script = urlPatchScript(5173)
	assert.ok(script.includes("'/dev/5173'"), 'patch is port-specific')
}
console.log('dev-inject.test.ts OK')
