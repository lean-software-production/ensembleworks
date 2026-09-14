// Run: bun src/fonts.test.ts
import assert from 'node:assert/strict'
import { canvasFontFaceCss } from './fonts.js'

const css = canvasFontFaceCss('/fonts/tldraw')
for (const family of ['tldraw_draw', 'tldraw_sans', 'tldraw_serif', 'tldraw_mono']) {
  assert.ok(css.includes(`font-family: '${family}'`), `declares ${family}`)
}
assert.ok(css.includes("url('/fonts/tldraw/Shantell_Sans-Informal_Regular.woff2')"), 'draw font resolves under the base url')
assert.ok(!canvasFontFaceCss('/x/').includes('/x//'), 'a trailing slash on the base url is not doubled')
console.log('ok: canvasFontFaceCss declares the four canvas families under the host base url')
