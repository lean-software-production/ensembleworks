// Live acceptance smoke for the bb Canvas plugin (docs/plans/2026-09-14-canvas-ui-shared-session-design.md).
// Run from e2e/ against a running bb:  BB_SERVER_URL=http://127.0.0.1:38886 node scripts/bb-canvas-smoke.mjs
// It works on scratch pages it creates and deletes; existing pages are not touched.
// Covers AC1-AC7 from the design doc plus two extras required by the Task 6 review:
//   EXTRA-A - Backspace pressed while focus is on plain page text outside the canvas
//             panel must not delete a selected shape; Backspace with focus on the
//             canvas must still delete it.
//   EXTRA-B - Ctrl+Z after creating a note on a freshly-created page must undo cleanly
//             without leaving the canvas panel blank or errored.
import { chromium } from '@playwright/test'

const BASE = process.env.BB_SERVER_URL ?? 'http://127.0.0.1:38886'
const results = []
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
let acceptDialogs = false
page.on('dialog', (d) => (acceptDialogs ? d.accept() : d.dismiss()))
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))

const bodies = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-shape-kind]')].map((e) => {
      const r = e.getBoundingClientRect()
      return { id: e.getAttribute('data-shape-id'), kind: e.getAttribute('data-shape-kind'), w: Math.round(r.width), h: Math.round(r.height) }
    }),
  )
const pressedTool = () => page.evaluate(() => document.querySelector('[data-canvas-tool][aria-pressed="true"]')?.getAttribute('data-canvas-tool'))

try {
  await page.goto(`${BASE}/`)
  await page.waitForTimeout(3000)
  const closeRef = page.getByRole('button', { name: 'Close UI reference' })
  if (await closeRef.count()) await closeRef.first().click()
  await page.getByRole('button', { name: 'Canvas', exact: true }).first().click()
  await page.waitForSelector('[data-canvas-viewport]', { timeout: 15000 })

  const tabsBefore = await page.evaluate(() => [...document.querySelectorAll('[data-canvas-page-tab]')].map((t) => t.textContent.trim()))
  console.log('tabs before run:', JSON.stringify(tabsBefore))

  await page.locator('[data-canvas-new-page-tab]').click()
  await page.waitForTimeout(1500)
  const vp = await page.locator('[data-canvas-viewport]').boundingBox()
  const at = (x, y) => ({ x: vp.x + x, y: vp.y + y })

  // AC1 — polished toolbar
  const tools = await page.evaluate(() =>
    [...document.querySelectorAll('[data-canvas-tool]')].map((b) => ({ id: b.getAttribute('data-canvas-tool'), title: b.getAttribute('title'), icon: !!b.querySelector('svg') })),
  )
  check('AC1 nine icon tools with shortcut tooltips', tools.length === 9 && tools.every((t) => t.icon && /\([A-Z]\)$/.test(t.title ?? '')), JSON.stringify(tools))

  // AC3 — note tool returns to Select after typing
  await page.locator('[data-canvas-tool="note"]').click()
  let p = at(300, 220)
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(300)
  await page.keyboard.type('hello')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const toolAfterType = await pressedTool()
  p = at(900, 600)
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(400)
  const notesAfterClick = (await bodies()).filter((b) => b.kind === 'note').length
  check('AC3 note tool returns to Select; next click creates nothing', toolAfterType === 'select' && notesAfterClick === 1, `tool=${toolAfterType} notes=${notesAfterClick}`)

  // AC2 — colour and font
  const note = (await bodies()).find((b) => b.kind === 'note')
  const noteBox = await page.locator(`[data-shape-id="${note.id}"][data-shape-kind]`).boundingBox()
  await page.mouse.click(noteBox.x + noteBox.width / 2, noteBox.y + 20)
  await page.waitForTimeout(300)
  const readNoteStyle = () =>
    page.evaluate((id) => {
      const body = document.querySelector(`[data-shape-id="${id}"] [data-shape-body]`) ?? document.querySelector(`[data-shape-id="${id}"][data-shape-kind]`)
      const cs = getComputedStyle(body)
      return { background: cs.backgroundColor, font: cs.fontFamily }
    }, note.id)
  const styleBefore = await readNoteStyle()
  await page.locator('[data-style-control="color"] [data-style-value="blue"]').click()
  await page.locator('[data-style-control="font"] [data-style-value="serif"]').click()
  await page.waitForTimeout(400)
  const styleAfter = await readNoteStyle()
  const docProps = await page.evaluate(async (id) => {
    const res = await fetch('/api/v1/plugins/canvas/rpc/canvas_debug', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' })
    return res.ok ? (await res.json()).result?.shapes?.[id]?.props ?? null : null
  }, note.id)
  check(
    'AC2 colour and font change',
    styleAfter.background !== styleBefore.background && styleAfter.font !== styleBefore.font && /serif/i.test(styleAfter.font),
    JSON.stringify({ styleBefore, styleAfter, docProps }),
  )

  // AC7 — theme follows bb
  const panelBg = await page.evaluate(() => {
    const panel = document.querySelector('[data-style-panel-mode]')
    return panel ? getComputedStyle(panel).backgroundColor : null
  })
  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const isDark = (rgb) => { const m = /rgba?\((\d+), (\d+), (\d+)/.exec(rgb ?? ''); return m ? (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3 < 128 : null }
  check('AC7 style panel matches bb light/dark appearance', panelBg !== null && isDark(panelBg) === isDark(bodyBg), `panel=${panelBg} body=${bodyBg}`)

  // AC6 — long text grows the note
  await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  await page.keyboard.press('End')
  await page.keyboard.type(' This is a much longer paragraph. It keeps going so the sticky has to grow downward. Nothing should be cut off at the bottom edge.')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
  const grown = await page.evaluate((id) => {
    const root = document.querySelector(`[data-shape-id="${id}"][data-shape-kind]`)
    const box = root.querySelector('[data-shape-body]') ?? root
    const r = root.getBoundingClientRect()
    return { w: r.width, h: r.height, scroll: box.scrollHeight, client: box.clientHeight }
  }, note.id)
  check('AC6 long note text grows the note', grown.h > grown.w && grown.scroll <= grown.client + 1, JSON.stringify(grown))

  // AC4 — shortcuts keep working after editing text (undo is recorded per edit: the
  // first Ctrl+Z changes the note's text; continued presses, with no clicking in
  // between, eventually remove the note).
  await page.locator('[data-canvas-tool="note"]').click()
  p = at(700, 250)
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(300)
  await page.keyboard.type('undo me')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const bodiesAtAC4 = await bodies()
  const before = bodiesAtAC4.length
  const noteAc4 = bodiesAtAC4.filter((b) => b.kind === 'note').at(-1)
  const readNoteText = (id) =>
    page.evaluate((shapeId) => {
      const el = document.querySelector(`[data-shape-id="${shapeId}"] [data-shape-body]`) ?? document.querySelector(`[data-shape-id="${shapeId}"][data-shape-kind]`)
      return el ? el.textContent : null
    }, id)
  const textBeforeUndo = await readNoteText(noteAc4.id)
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(300)
  const textAfterFirstUndo = await readNoteText(noteAc4.id)
  const firstUndoChangedText = textAfterFirstUndo !== textBeforeUndo
  let pressesToRemove = 1
  let stillThere = (await bodies()).some((b) => b.id === noteAc4.id)
  while (stillThere && pressesToRemove < 21) {
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(250)
    pressesToRemove += 1
    stillThere = (await bodies()).some((b) => b.id === noteAc4.id)
  }
  const after = (await bodies()).length
  const ac4ok = firstUndoChangedText && !stillThere
  if (!ac4ok) await page.screenshot({ path: '/tmp/claude-1000/bbshots/task8-AC4.png' })
  check(
    'AC4 Ctrl+Z works after editing without clicking (first press edits text, repeated presses remove the note)',
    ac4ok,
    `before=${before} after=${after} textBeforeUndo=${JSON.stringify(textBeforeUndo)} textAfterFirstUndo=${JSON.stringify(textAfterFirstUndo)} pressesToRemove=${stillThere ? '>20' : pressesToRemove}`,
  )

  // AC5 — arrows stay on their page
  await page.locator('[data-canvas-tool="arrow"]').click()
  p = at(300, 650)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(p.x + 250, p.y + 40, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const arrowsHere = await page.evaluate(() => document.querySelectorAll('[data-overlay="arrow"]').length)
  await page.locator('[data-canvas-new-page-tab]').click()
  await page.waitForTimeout(1500)
  const arrowsOnFresh = await page.evaluate(() => document.querySelectorAll('[data-overlay="arrow"]').length)
  check('AC5 arrow drawn on its page only', arrowsHere >= 1 && arrowsOnFresh === 0, `here=${arrowsHere} freshPage=${arrowsOnFresh}`)

  // EXTRA-A — keyboard scope: page text outside the canvas panel must not steal Backspace
  const vp2 = await page.locator('[data-canvas-viewport]').boundingBox()
  const at2 = (x, y) => ({ x: vp2.x + x, y: vp2.y + y })
  await page.locator('[data-canvas-tool="note"]').click()
  let pA = at2(500, 400)
  await page.mouse.click(pA.x, pA.y)
  await page.waitForTimeout(300)
  await page.keyboard.type('scratch-a')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const shapeA = (await bodies()).find((b) => b.kind === 'note')
  const boxA = await page.locator(`[data-shape-id="${shapeA.id}"][data-shape-kind]`).boundingBox()
  await page.mouse.click(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2)
  await page.waitForTimeout(200)
  const countBeforeA = (await bodies()).length
  const outsideText = page.locator('p', { hasText: 'Canvas' }).first()
  const outsideTextClickable = await outsideText.count()
  if (outsideTextClickable) await outsideText.click({ timeout: 5000 })
  await page.waitForTimeout(200)
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(300)
  const countAfterOutside = (await bodies()).length
  await page.mouse.click(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2)
  await page.waitForTimeout(200)
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(300)
  const countAfterCanvas = (await bodies()).length
  const extraAok = outsideTextClickable > 0 && countAfterOutside === countBeforeA && countAfterCanvas === countBeforeA - 1
  if (!extraAok) await page.screenshot({ path: '/tmp/claude-1000/bbshots/task8-EXTRA-A.png' })
  check(
    'EXTRA-A Backspace scoped to canvas focus (outside page text ignored, canvas click deletes)',
    extraAok,
    `outsideTextFound=${outsideTextClickable} before=${countBeforeA} afterOutsideBackspace=${countAfterOutside} afterCanvasBackspace=${countAfterCanvas}`,
  )

  // EXTRA-B — undo after page creation must not blank or error the panel
  await page.locator('[data-canvas-tool="note"]').click()
  let pB = at2(600, 300)
  await page.mouse.click(pB.x, pB.y)
  await page.waitForTimeout(300)
  await page.keyboard.type('undo-b')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const notesBeforeUndo = (await bodies()).filter((b) => b.kind === 'note').length
  let notesNow = notesBeforeUndo
  for (let i = 0; i < 8 && notesNow > 0; i++) {
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(250)
    notesNow = (await bodies()).filter((b) => b.kind === 'note').length
  }
  const viewportPresent = await page.locator('[data-canvas-viewport]').count()
  const currentTabPresent = await page.locator('[data-canvas-page-tab][aria-pressed="true"]').count()
  const extraBok = notesBeforeUndo > 0 && notesNow === 0 && viewportPresent > 0 && currentTabPresent > 0
  if (!extraBok) await page.screenshot({ path: '/tmp/claude-1000/bbshots/task8-EXTRA-B.png' })
  check(
    'EXTRA-B Ctrl+Z after page creation undoes cleanly, page still present',
    extraBok,
    `notesBefore=${notesBeforeUndo} notesAfter=${notesNow} viewportPresent=${viewportPresent} currentTabPresent=${currentTabPresent}`,
  )

  check('no page errors', errors.length === 0, JSON.stringify(errors))
} finally {
  // Delete the two scratch pages this run created (the last two tabs).
  acceptDialogs = true
  for (let i = 0; i < 2; i++) {
    const tab = page.locator('[data-canvas-page-tab]').last()
    if (!(await tab.count())) break
    await tab.click({ button: 'right' })
    await page.waitForTimeout(300)
    const del = page.locator('[data-canvas-page-tab-menu-item="delete"]')
    if (await del.count()) {
      await del.click()
      await page.waitForTimeout(1200)
    }
  }
  const tabs = await page.evaluate(() => [...document.querySelectorAll('[data-canvas-page-tab]')].map((t) => t.textContent.trim()))
  console.log('tabs after cleanup:', JSON.stringify(tabs))
  await browser.close()
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail ?? ''}`)
process.exit(results.every((r) => r.ok) ? 0 : 1)
