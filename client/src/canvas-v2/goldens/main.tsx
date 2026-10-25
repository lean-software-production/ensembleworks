/**
 * Entry point for component-goldens.html (Task G2) — a Vite dev-server-only
 * page (see that file's own header for why it never reaches the production
 * bundle). Reads `?fixture=<name>` and renders exactly ONE GoldenHarness for
 * that named fixture (fixtures.ts / shape-fixtures.ts) — one fixture per
 * page load, matching how e2e/tests/component-goldens.spec.ts drives it (one
 * `page.goto('/component-goldens.html?fixture=X')` + one `toHaveScreenshot`
 * per case).
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { GoldenHarness } from './GoldenHarness.js'
import { FIXTURES } from './fixtures.js'
import { SHAPE_FIXTURES } from './shape-fixtures.js'

const ALL_FIXTURES = { ...FIXTURES, ...SHAPE_FIXTURES }

const name = new URLSearchParams(location.search).get('fixture') ?? ''
const fixture = ALL_FIXTURES[name]

const root = document.getElementById('root')!

if (!fixture) {
	root.textContent = `unknown fixture: "${name}" -- known: ${Object.keys(ALL_FIXTURES).sort().join(', ')}`
} else {
	createRoot(root).render(
		<React.StrictMode>
			<GoldenHarness key={fixture.name} fixture={fixture} />
		</React.StrictMode>,
	)
}
