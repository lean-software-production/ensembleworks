/** Dev-page injection: recorder bridge + URL patch + error reporter into HTML only. Run: bun server/src/dev-inject.test.ts */
import assert from 'node:assert/strict'
import { injectDevPage, rewriteScriptSrcs, urlPatchScript } from './dev-inject.ts'

{
	// Script srcs get the /dev/{port} prefix so transitive module-dependency
	// Referers keep the routing marker; link hrefs stay untouched (css-update
	// matches links by original href; routing rides the document Referer).
	const html = '<html><head><script type="module" src="/@vite/client"></script>' +
		'<link rel="stylesheet" href="/src/style.css"></head>' +
		'<body><script src="/dev/3123/already.js"></script><script src="//cdn.example/x.js"></script></body></html>'
	const out = rewriteScriptSrcs(html, 3123)
	assert.ok(out.includes('src="/dev/3123/@vite/client"'), 'root-absolute script src prefixed')
	assert.ok(out.includes('href="/src/style.css"'), 'stylesheet href untouched')
	assert.ok(out.includes('src="/dev/3123/already.js"'), 'already-prefixed src unchanged')
	assert.ok(out.includes('src="//cdn.example/x.js"'), 'protocol-relative src unchanged')
}
{
	// injectDevPage rewrites page scripts but its own injected tags keep
	// canvas-origin paths (rrweb must load from /files-assets, not /dev).
	const out = injectDevPage('<html><body><script src="/src/main.ts"></script></body></html>', 3123)
	assert.ok(out.includes('src="/dev/3123/src/main.ts"'), 'page script src prefixed')
	assert.ok(out.includes('src="/files-assets/rrweb.js"'), 'injected rrweb tag not prefixed')
}

{
	const out = injectDevPage('<!doctype html><html><head></head><body><div id=app></div></body></html>', 3000)
	assert.ok(out.includes('/files-assets/rrweb.js'), 'rrweb asset tag injected')
	assert.ok(out.includes('ew-present-start'), 'recorder bridge injected')
	assert.ok(out.includes('/dev/3000'), 'URL patch carries the port prefix')
	assert.ok(out.includes('ew-dev-error'), 'error reporter injected')
	assert.ok(out.indexOf('</body>') > out.indexOf('ew-present-start'), 'injected before closing body')
	assert.ok(out.includes('xhr.responseURL'), 'XHR reporter hooks status>=400 loads and network errors via responseURL')
	assert.ok(out.includes("'ws '"), 'WebSocket error reporter present')
	assert.ok(out.includes("'ws close '"), 'WebSocket abnormal-close reporter present')
	assert.ok(out.includes('code !== 1000'), 'WebSocket close reporter ignores normal-closure codes')
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
	// Vite HMR dials ws://localhost:{devPort}/ directly (its __HMR_PORT__
	// default) — the WS wrapper must re-target that at the page origin's
	// /dev/{port} path, since the dev port is unreachable from the browser.
	assert.ok(script.includes("u.port === '5173'"), 'WS wrapper matches the dev port cross-host')
	assert.ok(script.includes('location.host + prefix'), 'WS wrapper re-targets at the page-origin proxy path')
}
{
	// Execute the injected fetch patch in a minimal sandbox to pin its actual
	// runtime behaviour: a same-origin, root-absolute URL-object input gets
	// patched (reliably possible — URL.pathname is always root-absolute,
	// unlike Request.prototype.url which is always absolute); a Request-object
	// input is deliberately left unpatched (rebuilding one via `new
	// Request(patchedUrl, input)` throws a duplex-required error in Chrome
	// once it carries a body) rather than silently mishandled.
	const code = urlPatchScript(3000).replace(/^<script>/, '').replace(/<\/script>$/, '')
	const runSandboxed = () => {
		let capturedInput: unknown
		const fakeLocation = { href: 'http://localhost:8080/', host: 'localhost:8080' }
		const fakeWindow: { fetch: (input: unknown) => Promise<string>; WebSocket?: unknown } = {
			fetch: (input: unknown) => {
				capturedInput = input
				return Promise.resolve('ok')
			},
		}
		fakeWindow.WebSocket = Object.assign(function FakeWebSocket() {}, {
			CONNECTING: 0,
			OPEN: 1,
			CLOSING: 2,
			CLOSED: 3,
			prototype: {},
		})
		const fakeXHR = { prototype: { open: () => {} } }
		const run = new Function('window', 'location', 'XMLHttpRequest', 'URL', 'Request', code)
		run(fakeWindow, fakeLocation, fakeXHR, URL, Request)
		return { fakeWindow, getCaptured: () => capturedInput }
	}

	{
		const { fakeWindow, getCaptured } = runSandboxed()
		await fakeWindow.fetch(new URL('/foo', 'http://localhost:8080/'))
		const captured = getCaptured()
		assert.ok(captured instanceof URL, 'URL-object input stays a URL')
		assert.equal((captured as URL).pathname, '/dev/3000/foo', 'same-origin URL-object input gets patched')
	}
	{
		const { fakeWindow, getCaptured } = runSandboxed()
		const crossOrigin = new URL('https://example.com/foo')
		await fakeWindow.fetch(crossOrigin)
		assert.equal(getCaptured(), crossOrigin, 'cross-origin URL-object input is left untouched')
	}
	{
		const { fakeWindow, getCaptured } = runSandboxed()
		const req = new Request('http://localhost:8080/foo')
		await fakeWindow.fetch(req)
		assert.equal(getCaptured(), req, 'Request-object input passes through unpatched (documented gap, not silently mishandled)')
	}
}
console.log('dev-inject.test.ts OK')
