/**
 * /dev/{port} HTML injection (spec: web-viewer unification §1–§3): the same
 * rrweb recorder bridge file documents get (files-render.ts), plus two
 * dev-only scripts — a URL patch that rewrites root-absolute fetch/XHR/
 * WebSocket URLs to the /dev/{port} prefix (deterministic fix for JS-initiated
 * traffic incl. HMR), and an error reporter that surfaces JS errors, failed
 * subresources, and failed requests to the parent shape via postMessage
 * (type 'ew-dev-error').
 */
import { BRIDGE_SCRIPT, RRWEB_TAG } from './files-render.ts'

export function urlPatchScript(port: number): string {
	// Serialized into the page; keep it ES5-ish and self-contained.
	return `<script>(function () {
	var prefix = '/dev/${port}'
	function patch(u) {
		if (typeof u !== 'string') return u
		if (u.charAt(0) === '/' && u.charAt(1) !== '/' && u.indexOf(prefix + '/') !== 0 && u !== prefix) return prefix + u
		return u
	}
	var origFetch = window.fetch
	if (origFetch) window.fetch = function (input, init) {
		if (typeof input === 'string') input = patch(input)
		else if (input && typeof input.url === 'string' && input.url.charAt(0) === '/') input = new Request(patch(input.url), input)
		return origFetch.call(this, input, init)
	}
	var origOpen = XMLHttpRequest.prototype.open
	XMLHttpRequest.prototype.open = function (method, url) {
		arguments[1] = patch(url)
		return origOpen.apply(this, arguments)
	}
	var OrigWS = window.WebSocket
	window.WebSocket = function (url, protocols) {
		try {
			var u = new URL(url, location.href)
			if (u.host === location.host) { u.pathname = patch(u.pathname); url = u.toString() }
		} catch (e) {}
		return protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols)
	}
	window.WebSocket.prototype = OrigWS.prototype
	Object.defineProperty(window.WebSocket, 'CONNECTING', { value: OrigWS.CONNECTING })
	Object.defineProperty(window.WebSocket, 'OPEN', { value: OrigWS.OPEN })
	Object.defineProperty(window.WebSocket, 'CLOSING', { value: OrigWS.CLOSING })
	Object.defineProperty(window.WebSocket, 'CLOSED', { value: OrigWS.CLOSED })
})()</script>`
}

export function errorReporterScript(): string {
	return `<script>(function () {
	function report(kind, detail) {
		try { parent.postMessage({ type: 'ew-dev-error', kind: kind, detail: String(detail).slice(0, 500) }, '*') } catch (e) {}
	}
	window.addEventListener('error', function (e) {
		if (e && e.target && (e.target.src || e.target.href) && e.target !== window) {
			report('resource', (e.target.src || e.target.href))
		} else {
			report('js', e && e.message ? e.message : 'script error')
		}
	}, true)
	window.addEventListener('unhandledrejection', function (e) { report('js', e && e.reason ? e.reason : 'unhandled rejection') })
	var origFetch = window.fetch
	if (origFetch) window.fetch = function () {
		return origFetch.apply(this, arguments).then(function (res) {
			if (!res.ok && res.status >= 400) report('request', res.status + ' ' + res.url)
			return res
		})
	}
})()</script>`
}

/** rrweb asset + shared recorder bridge + dev-only scripts, before last </body>. */
export function injectDevPage(html: string, port: number): string {
	// Error reporter FIRST so its fetch wrapper composes under the URL patch
	// (patch runs the underlying request; reporter observes the patched result).
	const injected = RRWEB_TAG + urlPatchScript(port) + errorReporterScript() + BRIDGE_SCRIPT
	const re = /<\/body\s*>/gi
	let idx = -1
	for (let m = re.exec(html); m; m = re.exec(html)) idx = m.index
	if (idx < 0) return html + injected
	return html.slice(0, idx) + injected + html.slice(idx)
}
