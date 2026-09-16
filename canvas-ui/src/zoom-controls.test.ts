// Run: bun src/zoom-controls.test.ts
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MAX_ZOOM, MIN_ZOOM } from '@ensembleworks/canvas-editor'
import { ZoomControls } from './ZoomControls.js'

const VIEWPORT = { width: 800, height: 600 }

const html = renderToStaticMarkup(createElement(ZoomControls, { camera: { x: 0, y: 0, z: 1 }, viewportSize: VIEWPORT, onSetCamera: () => {} }))
assert.ok(html.includes('data-canvas-zoom="out"'), 'renders a zoom-out button')
assert.ok(html.includes('data-canvas-zoom="reset"'), 'renders a reset button')
assert.ok(html.includes('data-canvas-zoom="in"'), 'renders a zoom-in button')
assert.ok(html.includes('aria-label="Zoom out"'), 'zoom-out button is labelled')
assert.ok(html.includes('aria-label="Reset zoom to 100%"'), 'reset button is labelled')
assert.ok(html.includes('aria-label="Zoom in"'), 'zoom-in button is labelled')
assert.match(html, /data-canvas-zoom="reset"[^>]*>100%</, 'reset button shows the current zoom level, rounded to a percentage')
console.log('ok: ZoomControls renders out/reset/in buttons with the current zoom readout')

// The readout rounds to the nearest percent and reflects the camera prop.
{
	const zoomedHtml = renderToStaticMarkup(createElement(ZoomControls, { camera: { x: 0, y: 0, z: 1.256 }, viewportSize: VIEWPORT, onSetCamera: () => {} }))
	assert.match(zoomedHtml, /data-canvas-zoom="reset"[^>]*>126%</, 'the readout rounds camera.z*100 to the nearest percent')
	console.log('ok: ZoomControls readout tracks and rounds the camera prop')
}

// Buttons disable at the zoom extremes rather than allowing a no-op click.
{
	const atMin = renderToStaticMarkup(createElement(ZoomControls, { camera: { x: 0, y: 0, z: MIN_ZOOM }, viewportSize: VIEWPORT, onSetCamera: () => {} }))
	assert.match(atMin, /data-canvas-zoom="out"[^>]*disabled=""/, "'out' is disabled at MIN_ZOOM")
	assert.ok(!/data-canvas-zoom="in"[^>]*disabled=""/.test(atMin), "'in' stays enabled at MIN_ZOOM")

	const atMax = renderToStaticMarkup(createElement(ZoomControls, { camera: { x: 0, y: 0, z: MAX_ZOOM }, viewportSize: VIEWPORT, onSetCamera: () => {} }))
	assert.match(atMax, /data-canvas-zoom="in"[^>]*disabled=""/, "'in' is disabled at MAX_ZOOM")
	assert.ok(!/data-canvas-zoom="out"[^>]*disabled=""/.test(atMax), "'out' stays enabled at MAX_ZOOM")

	console.log('ok: ZoomControls disables out/in exactly at the zoom extremes')
}

console.log('ok: ZoomControls markup smoke test')
