/**
 * /files/* render pipeline: markdown → styled standalone HTML, scroll-bridge
 * injection, and the styled error/unsupported pages. Kept apart from the route
 * so every piece is unit-testable and the file-server stays a dumb byte reader.
 */
import { marked } from 'marked'

/**
 * The scroll-follow bridge, injected into every top-level document. One IIFE,
 * ew-prefixed message types, no globals (spec R6): posts ready + throttled
 * scroll fractions to the parent; applies ew-scroll-set without re-broadcast
 * (echo suppression at the source).
 */
export const BRIDGE_SCRIPT = `<script>(function () {
	var applying = false
	var last = 0
	function fraction() {
		var max = document.documentElement.scrollHeight - window.innerHeight
		return max > 0 ? window.scrollY / max : 0
	}
	window.addEventListener('scroll', function () {
		if (applying) { applying = false; return }
		var now = Date.now()
		if (now - last < 100) return
		last = now
		parent.postMessage({ type: 'ew-scroll', fraction: fraction() }, '*')
	}, { passive: true })
	window.addEventListener('message', function (e) {
		var d = e && e.data
		if (!d || d.type !== 'ew-scroll-set' || typeof d.fraction !== 'number') return
		var max = document.documentElement.scrollHeight - window.innerHeight
		if (max <= 0) return
		applying = true
		window.scrollTo(0, d.fraction * max)
	})
	parent.postMessage({ type: 'ew-file-viewer-ready' }, '*')
})()</script>`

/** Inject the bridge before </body> (last occurrence, case-insensitive), else append. */
export function injectBridge(html: string): string {
	const m = /<\/body\s*>/i.exec(html)
	if (!m) return html + BRIDGE_SCRIPT
	const idx = html.toLowerCase().lastIndexOf('</body')
	return html.slice(0, idx) + BRIDGE_SCRIPT + html.slice(idx)
}

const PAGE_CSS = `<style>
	:root { color-scheme: light dark; }
	body { max-width: 46rem; margin: 2rem auto; padding: 0 1rem; font: 16px/1.6 system-ui, sans-serif; color: #1a1a1a; background: #fdfcf9; }
	@media (prefers-color-scheme: dark) { body { color: #e8e6e1; background: #191919; } a { color: #8ab4f8; } }
	pre { background: rgba(127,127,127,.12); padding: .75rem 1rem; border-radius: 6px; overflow-x: auto; }
	code { font-family: ui-monospace, monospace; font-size: .92em; }
	table { border-collapse: collapse; } th, td { border: 1px solid rgba(127,127,127,.4); padding: .3rem .6rem; }
	img { max-width: 100%; }
	blockquote { border-left: 3px solid rgba(127,127,127,.4); margin-left: 0; padding-left: 1rem; opacity: .85; }
</style>`

function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** GFM markdown → standalone styled HTML with the bridge already injected. */
export function renderMarkdown(md: string, filename: string): string {
	const body = marked.parse(md, { gfm: true, async: false }) as string
	return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(filename)}</title>${PAGE_CSS}</head><body>${body}${BRIDGE_SCRIPT}</body></html>`
}

/** Small styled page for 404/502/unsupported/501 — shown inside the control. */
export function errorPage(title: string, message: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>${PAGE_CSS}</head><body><h1>${esc(title)}</h1><p>${esc(message)}</p></body></html>`
}
