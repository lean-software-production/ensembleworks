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
		if (typeof input === 'string') {
			input = patch(input)
		} else if (input instanceof URL) {
			// A URL object's .pathname is always root-absolute, unlike
			// Request.prototype.url (always absolute) — reliably patchable.
			if (input.host === location.host) {
				var patched = patch(input.pathname)
				if (patched !== input.pathname) {
					var u2 = new URL(input.href)
					u2.pathname = patched
					input = u2
				}
			}
		}
		// Request-object inputs are left unpatched: Request.prototype.url is
		// always absolute (a url.charAt(0) === '/' check here can never
		// match), and rebuilding one via new Request(patchedUrl, input)
		// throws a duplex-required error in Chrome once the Request carries
		// a body. Same-origin fetch(new Request(...)) calls made directly
		// (rather than via a string/URL) are rare enough in practice that
		// this is an accepted gap, not a silent mishandling.
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
			if (u.host === location.host) {
				u.pathname = patch(u.pathname)
				url = u.toString()
			} else if (
				(u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1') &&
				u.port === '${port}'
			) {
				// Vite's HMR client dials ws://localhost:{devPort}/ directly (its
				// __HMR_PORT__ default is the dev server's own port), which the
				// browser can't reach — the dev server only listens inside the VM.
				// Re-target it at the page origin's /dev/{port} proxy path.
				var proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
				url = proto + '//' + location.host + prefix + u.pathname + u.search
			}
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
	// XHR: wraps XMLHttpRequest.prototype.open as already patched by
	// urlPatchScript (this script runs after it in injectDevPage's ordering),
	// so responseURL below reflects the /dev/{port}-rewritten request.
	var origOpen = XMLHttpRequest.prototype.open
	XMLHttpRequest.prototype.open = function () {
		var xhr = this
		xhr.addEventListener('load', function () {
			if (xhr.status >= 400) report('request', xhr.status + ' ' + xhr.responseURL)
		})
		xhr.addEventListener('error', function () {
			report('request', xhr.responseURL || 'XHR request failed')
		})
		return origOpen.apply(this, arguments)
	}
	// WebSocket: wraps the current window.WebSocket, which at this point in
	// injection order is already urlPatchScript's URL-rewriting constructor —
	// so constructing via OrigWS below still gets the /dev/{port} URL patch.
	var OrigWS = window.WebSocket
	if (OrigWS) {
		window.WebSocket = function (url, protocols) {
			var ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols)
			ws.addEventListener('error', function () { report('request', 'ws ' + (ws.url || url)) })
			ws.addEventListener('close', function (e) {
				var code = e && e.code
				if (code !== 1000 && code !== 1001 && code !== 1005) {
					report('request', 'ws close ' + code + ' ' + (ws.url || url))
				}
			})
			return ws
		}
		window.WebSocket.prototype = OrigWS.prototype
		Object.defineProperty(window.WebSocket, 'CONNECTING', { value: OrigWS.CONNECTING })
		Object.defineProperty(window.WebSocket, 'OPEN', { value: OrigWS.OPEN })
		Object.defineProperty(window.WebSocket, 'CLOSING', { value: OrigWS.CLOSING })
		Object.defineProperty(window.WebSocket, 'CLOSED', { value: OrigWS.CLOSED })
	}
})()</script>`
}

/**
 * Rewrite root-absolute <script src="/..."> attributes to the /dev/{port}
 * prefix. Without this, a module script at a naked-origin URL (Vite's
 * /@vite/client) makes its transitive dependency requests with a Referer
 * that carries no /dev/{port}/ segment — the edge's Referer fallback then
 * routes those deps to the wrong backend and the whole module tree fails.
 * Prefixed script URLs keep the /dev/{port}/ marker in every downstream
 * Referer. Stylesheet hrefs are deliberately left alone: their requests use
 * the DOCUMENT's Referer (which has the prefix), and Vite's css-update
 * messages match <link> elements by the original root-absolute href.
 */
export function rewriteScriptSrcs(html: string, port: number): string {
	const prefix = `/dev/${port}`
	return html.replace(/(<script\b[^>]*?\ssrc=)(["'])(\/[^"']*)\2/gi, (m, pre, q, src) => {
		if (src.startsWith('//') || src === prefix || src.startsWith(`${prefix}/`)) return m
		return `${pre}${q}${prefix}${src}${q}`
	})
}

/** rrweb asset + shared recorder bridge + dev-only scripts, before last </body>. */
export function injectDevPage(html: string, port: number): string {
	// Rewrite existing script srcs FIRST — the injected tags below (rrweb at
	// /files-assets, inline scripts) must keep their canvas-origin paths.
	html = rewriteScriptSrcs(html, port)
	// Error reporter FIRST so its fetch wrapper composes under the URL patch
	// (patch runs the underlying request; reporter observes the patched result).
	const injected = RRWEB_TAG + urlPatchScript(port) + errorReporterScript() + BRIDGE_SCRIPT
	const re = /<\/body\s*>/gi
	let idx = -1
	for (let m = re.exec(html); m; m = re.exec(html)) idx = m.index
	if (idx < 0) return html + injected
	return html.slice(0, idx) + injected + html.slice(idx)
}
