// files-render: md→styled HTML (relative refs preserved), bridge injection
// (with and without </body>), error/unsupported pages.
// Run with: bun src/files-render.test.ts
import assert from 'node:assert/strict'
import { BRIDGE_SCRIPT, errorPage, injectBridge, renderMarkdown } from './files-render.ts'

// markdown: GFM table + relative image + link survive
const md = '# T\n\n|a|b|\n|-|-|\n|1|2|\n\n![d](./diagram.svg) [s](sib.html)'
const html = renderMarkdown(md, 'notes.md')
assert.ok(html.includes('<table>'), 'GFM table rendered')
assert.ok(html.includes('src="./diagram.svg"'), 'relative img preserved')
assert.ok(html.includes('href="sib.html"'), 'relative link preserved')
assert.ok(html.includes('<title>notes.md</title>'), 'title from filename')
assert.ok(html.includes('prefers-color-scheme'), 'dark mode styles present')
assert.ok(html.includes(BRIDGE_SCRIPT), 'rendered markdown ships the bridge')

// injection: before </body> when present…
const withBody = injectBridge('<html><body><p>x</p></body></html>')
assert.ok(withBody.indexOf(BRIDGE_SCRIPT) < withBody.indexOf('</body>'), 'injected before </body>')
// …appended when absent; document content untouched
const noBody = injectBridge('<p>bare</p>')
assert.ok(noBody.startsWith('<p>bare</p>'), 'original content leads')
assert.ok(noBody.includes(BRIDGE_SCRIPT), 'bridge appended')

// bridge contract strings (the client + injected script must agree)
assert.ok(BRIDGE_SCRIPT.includes('ew-file-viewer-ready'))
assert.ok(BRIDGE_SCRIPT.includes('ew-scroll'))
assert.ok(BRIDGE_SCRIPT.includes('ew-scroll-set'))

// error pages: styled, status text present
assert.ok(errorPage('Not found', 'nope.html does not exist').includes('Not found'))

console.log('ok: files-render')
