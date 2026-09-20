import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const renderScript = fileURLToPath(new URL('../scripts/render-github-issue-card.ts', import.meta.url))
const pickerHarness = fileURLToPath(new URL('../../plugins/canvas/tests/browser-github-issue-picker.tsx', import.meta.url))

test.describe('iPhone-sized touch viewport', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 })
  for (const [width, height] of [[260, 170], [320, 256]]) {
  test(`${width}×${height} open issue picker fits the card on an iPhone viewport`, async ({ page }) => {
    const outputDir = mkdtempSync(join(tmpdir(), 'canvas-github-picker-'))
    const bundle = join(outputDir, 'picker.js')
    try {
      execFileSync('bun', ['build', pickerHarness, '--target', 'browser', '--outfile', bundle], { encoding: 'utf8' })
      await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><main id="card" style="position:absolute;right:5px;bottom:5px;width:${width}px;height:${height}px"></main>`)
      await page.addScriptTag({ path: bundle })
      const card = page.locator('[data-github-issue-unlinked]')
      const input = card.getByRole('combobox')
      expect(await input.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16)
      await input.click()
      const list = card.getByRole('listbox')
      await expect(list.getByRole('option')).toHaveCount(20)
      const cardBox = (await card.boundingBox())!
      const listBox = (await list.boundingBox())!
      expect(listBox.x).toBeGreaterThanOrEqual(cardBox.x - 1)
      expect(listBox.x + listBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1)
      expect(Math.abs(listBox.width - cardBox.width)).toBeLessThanOrEqual(3)
      expect(listBox.y).toBeGreaterThanOrEqual(cardBox.y)
      expect(listBox.y + listBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height + 1)
      expect(listBox.x + listBox.width).toBeLessThanOrEqual(391)
      expect(listBox.y + listBox.height).toBeLessThanOrEqual(845)
      expect(await list.evaluate((node) => node.scrollHeight)).toBeGreaterThan(await list.evaluate((node) => node.clientHeight))
      const touch = await page.context().newCDPSession(page)
      const x = listBox.x + listBox.width / 2
      const startY = listBox.y + listBox.height - 8
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] })
      for (let step = 1; step <= 5; step++) {
        await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: startY - step * 12 }] })
      }
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })
  }
})

for (const [width, height] of [[260, 170], [470, 256]]) {
  test(`${width}×${height} unlinked card keeps the URL form visible and leaves the body draggable`, async ({ page }) => {
    const html = execFileSync('bun', [renderScript, 'unlinked', String(width), String(height)], { encoding: 'utf8' })
    await page.setContent(`<div style="width:${width}px;height:${height}px">${html}</div>`)
    const card = page.locator('[data-github-issue-unlinked]')
    const bounds = await card.boundingBox()
    expect(bounds).not.toBeNull()
    expect(await card.getAttribute('data-canvas-interactive')).toBeNull()
    await expect(card.locator('form[data-canvas-interactive] input[role="combobox"]')).toBeVisible()
    await expect(card.locator('button[type="submit"]')).toBeVisible()
    for (const element of await card.locator('h2, form, p').all()) {
      const box = await element.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.y + box!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 1)
      expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1)
    }
  })
}

test('issue description reveals more whole lines as the card grows', async ({ page }) => {
  const visibleLines: number[] = []
  for (const height of [170, 256, 420]) {
    const html = execFileSync('bun', [renderScript, 'ready', '470', String(height)], { encoding: 'utf8' })
    await page.setContent(`<div style="width:470px;height:${height}px">${html}</div>`)
    const description = page.locator('[data-github-issue-body]')
    if (height === 170) { await expect(description).toHaveCount(0); visibleLines.push(0); continue }
    await expect(description).toBeVisible()
    const bounds = (await description.boundingBox())!
    const lineHeight = await description.evaluate((node) => parseFloat(getComputedStyle(node).lineHeight))
    expect(Math.abs(bounds.height / lineHeight - Math.round(bounds.height / lineHeight))).toBeLessThan(0.1)
    const footer = (await page.locator('footer').boundingBox())!
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(footer.y)
    visibleLines.push(Math.round(bounds.height / lineHeight))
  }
  expect(visibleLines[1]).toBeGreaterThan(visibleLines[0]!)
  expect(visibleLines[2]).toBeGreaterThan(visibleLines[1]!)
})

for (const state of ['ready', 'stale', 'cache-miss', 'loading'] as const) {
  test(`260×170 ${state} card keeps its primary content and timestamps in bounds`, async ({ page }) => {
    const html = execFileSync('bun', [renderScript, state], { encoding: 'utf8' })
    await page.setContent(`<div style="width:260px;height:170px">${html}</div>`)
    const card = page.locator('[data-shape-body="github-issue"]')
    const cardBox = await card.boundingBox()
    expect(cardBox).not.toBeNull()
    const content = state === 'ready' || state === 'stale' ? card.locator('h2') : card.locator('div').filter({ hasText: state === 'cache-miss' ? 'Not in GitHub cache' : 'Loading GitHub cache' }).last()
    const contentBox = await content.boundingBox()
    expect(contentBox).not.toBeNull()
    expect(contentBox!.height).toBeGreaterThan(state === 'ready' || state === 'stale' ? 30 : 12)
    expect(contentBox!.y).toBeGreaterThanOrEqual(cardBox!.y)
    const footer = await card.locator('footer').boundingBox()
    expect(footer).not.toBeNull()
    expect(contentBox!.y + contentBox!.height).toBeLessThanOrEqual(footer!.y)
    for (const line of await card.locator('footer span').all()) {
      const box = await line.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.x + box!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width)
      expect(box!.y + box!.height).toBeLessThanOrEqual(cardBox!.y + cardBox!.height)
    }
    await expect(card.locator('a')).toBeVisible()
  })
}

for (const width of [260, 360, 470]) for (const height of width === 470 ? [170, 189, 190, 205, 209, 210, 230, 239, 240, 249, 250, 256, 279, 280, 299, 300, 319, 320] : [170, 205, 209, 210, 230, 256, 299, 300, 320]) for (const state of ['ready', 'stale', 'auth'] as const) {
  test(`${width}×${height} ${state} rows are whole or absent`, async ({ page }) => {
    const html = execFileSync('bun', [renderScript, state, String(width), String(height)], { encoding: 'utf8' })
    await page.setContent(`<div style="width:${width}px;height:${height}px">${html}</div>`)
    const card = page.locator('[data-shape-body="github-issue"]')
    await expect(card.locator('a')).toBeVisible()
    const rows = await card.evaluate((article) => {
      const title = article.querySelector('h2')!
      const badge = [...article.querySelectorAll('span')].find((el) => el.textContent?.includes('◉ Open'))
      const label = article.querySelector('span[title="bug"]')
      const elements = { title, warning: article.querySelector('[role="status"]'), status: badge?.parentElement,
        description: article.querySelector('[data-github-issue-body]'), labels: label?.parentElement }
      return Object.entries(elements).map(([name, element]) => {
        if (!element) return { name, shown: false, visible: 0, required: 0, scroll: 0, client: 0 }
        const box = element.getBoundingClientRect()
        let clip = article.getBoundingClientRect().bottom
        for (let parent = element.parentElement; parent && parent !== article; parent = parent.parentElement) {
          if (getComputedStyle(parent).overflowY === 'hidden') clip = Math.min(clip, parent.getBoundingClientRect().bottom)
        }
        const line = parseFloat(getComputedStyle(element).lineHeight)
        return { name, shown: getComputedStyle(element).display !== 'none', visible: Math.max(0, Math.min(box.bottom, clip) - box.top),
          required: name === 'title' ? line : box.height, scroll: element.scrollHeight, client: element.clientHeight }
      })
    })
    for (const row of rows) {
      if (!row.shown) continue
      expect(row.visible, `${state} ${height}px ${row.name}: ${JSON.stringify(row)}`).toBeGreaterThanOrEqual(row.required - 1)
      if (row.name !== 'title' && row.name !== 'description') expect(row.client, `${state} ${height}px ${row.name}: ${JSON.stringify(row)}`).toBeGreaterThanOrEqual(row.scroll - 1)
    }
    for (const timestamp of await card.locator('footer span').all()) {
      const box = await timestamp.boundingBox()
      const footer = await card.locator('footer').boundingBox()
      expect(box!.y + box!.height).toBeLessThanOrEqual(footer!.y + footer!.height + 1)
    }
  })
}
