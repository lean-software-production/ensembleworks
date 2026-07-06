#!/usr/bin/env node
// Headless probe for the roadmap canvas control. Encodes every known trap:
// blocking prompts, toolbar overflow, pointer-events edit gating, manual
// HTML5 drag, optimistic-render verification via POST log + server rev.
//
// Run from a directory with playwright installed (docs/headless-browser.md):
//   cd /tmp/canvas-probe && node <repo>/.claude/skills/debugging-roadmap-control/probe.mjs <cmd>
// Env: ROOM (default debug-roadmap), URL (default http://localhost:5173)
//
// Commands:
//   shot [file.png]           screenshot the shape (creates one if missing)
//   click <text|css=SEL>      edit mode, click first matching .rm-root button,
//                             report POSTs + server rev change.
//                             Text args match buttons EXCEPT status chips and
//                             glyphs (their text collides with filter labels);
//                             target those via css=, e.g.
//                               click 'css=[title="Cycle status"]'
//                             DOM order puts outcome chips before feature
//                             glyphs, so the first match is an outcome's.
//   drag <fromText> <toText>  edit mode, drag the handle of the row/card
//                             matching fromText onto the element matching
//                             toText; report POSTs + server rev change
//   eval <js>                 edit mode, run JS in page context, print result
// Resolve playwright from the CWD (it is deliberately not a repo dependency).
import { createRequire } from 'node:module'
const { chromium } = createRequire(process.cwd() + '/')('playwright')

const ROOM = process.env.ROOM || 'debug-roadmap'
const URL_ = process.env.URL || 'http://localhost:5173'
const [cmd, ...args] = process.argv.slice(2)
if (!cmd) {
	console.error('usage: probe.mjs shot|click|drag|eval ... (see file header)')
	process.exit(1)
}

const serverRev = async () => {
	const list = (await (await fetch(`${URL_}/api/roadmap/doc?room=${ROOM}`)).json()).roadmaps
	return list.length ? { name: list[0].name, rev: list[0].rev } : null
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
// Trap: two blocking window.prompt()s (user name, roadmap name) hang goto.
page.on('dialog', (d) =>
	d.accept(d.message().includes('Roadmap name') ? 'Roadmap' : 'probe-bot').catch(() => {})
)
const posts = []
page.on('console', (m) => {
	if (m.text().startsWith('[probe-post]')) posts.push(m.text().slice(13))
})
await page.goto(`${URL_}/?room=${ROOM}`, { waitUntil: 'domcontentloaded', timeout: 20000 })
await page.waitForTimeout(6000) // let sync deliver the room
// Trap: the UI renders optimistically — log what actually hits the server.
await page.evaluate(() => {
	const orig = window.fetch
	window.fetch = (...a) => {
		if (String(a[0]).includes('/api/roadmap/doc') && a[1]?.method === 'POST')
			console.log('[probe-post] ' + a[1].body)
		return orig(...a)
	}
})

if ((await page.locator('.rm-root').count()) === 0) {
	// Trap: the roadmap tool lives in the toolbar overflow menu.
	await page.locator('[data-testid="tools.more-button"]').click()
	await page.waitForTimeout(400)
	await page.locator('[data-testid="tools.more.roadmap"]').click({ force: true })
	await page.mouse.click(750, 500)
	await page.waitForTimeout(2000)
}
const root = page.locator('.rm-root').first()

async function enterEdit() {
	// Trap: shape is pointer-events:none until editing — locator clicks bounce
	// off tl-background. Double-click raw coordinates instead.
	const rb = await root.boundingBox()
	await page.mouse.dblclick(rb.x + 200, rb.y + 12)
	await page.waitForTimeout(500)
	if (!(await root.textContent()).includes('drag to reorder'))
		throw new Error('failed to enter edit mode (legend does not show edit hints)')
}

const el = (arg) =>
	arg.startsWith('css=')
		? page.locator(arg.slice(4)).first()
		: page.locator('.rm-root button:not([title="Cycle status"])', { hasText: arg }).first()

const before = await serverRev()

if (cmd === 'shot') {
	await page.screenshot({ path: args[0] || 'roadmap.png' })
	console.log('wrote', args[0] || 'roadmap.png')
} else if (cmd === 'click') {
	await enterEdit()
	await el(args[0]).click({ timeout: 5000 })
	await page.waitForTimeout(700)
} else if (cmd === 'drag') {
	await enterEdit()
	// The draggable is the row itself (children), or a ⠿ handle whose parent
	// header holds the title (initiatives, outcomes).
	const from = await page.evaluate((text) => {
		// Prefer draggables whose OWN text matches (rows, outcome headers);
		// fall back to parent text for the bare ⠿ handle spans (initiatives),
		// picking the tightest context so an outcome header doesn't shadow them.
		const cands = [...document.querySelectorAll('.rm-root [draggable="true"]')]
		const own = cands.filter((e) => e.textContent.includes(text))
		const d = own.length
			? own.sort((a, b) => a.textContent.length - b.textContent.length)[0]
			: cands
					.filter((e) => e.parentElement.textContent.includes(text))
					.sort((a, b) => a.parentElement.textContent.length - b.parentElement.textContent.length)[0]
		if (!d) return null
		const r = d.getBoundingClientRect()
		return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
	}, args[0])
	if (!from) throw new Error(`no draggable found for "${args[0]}"`)
	const to = await page.getByText(args[1]).last().boundingBox()
	// Trap: playwright's dragAndDrop() is unreliable here — drag manually.
	await page.mouse.move(from.x, from.y)
	await page.mouse.down()
	await page.mouse.move(from.x + 30, from.y + 15, { steps: 4 })
	await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 })
	await page.waitForTimeout(250)
	await page.mouse.up()
	await page.waitForTimeout(700)
} else if (cmd === 'eval') {
	await enterEdit()
	console.log('eval:', JSON.stringify(await page.evaluate(args[0])))
} else {
	throw new Error(`unknown command ${cmd}`)
}

if (posts.length) console.log('POSTs:', posts.join('\n       '))
else if (cmd === 'click' || cmd === 'drag') console.log('POSTs: none (interaction did not reach the server)')
const after = await serverRev()
console.log('server rev:', before?.rev, '->', after?.rev, after ? `(${after.name})` : '(no roadmap in room)')
await browser.close()
