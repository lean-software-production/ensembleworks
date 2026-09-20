import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const renderScript = fileURLToPath(new URL('../scripts/render-github-issue-card.ts', import.meta.url))

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
      const elements = { title, warning: article.querySelector('[role="status"]'), status: badge?.parentElement, labels: label?.parentElement }
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
      if (row.name !== 'title') expect(row.client, `${state} ${height}px ${row.name}: ${JSON.stringify(row)}`).toBeGreaterThanOrEqual(row.scroll - 1)
    }
    for (const timestamp of await card.locator('footer span').all()) {
      const box = await timestamp.boundingBox()
      const footer = await card.locator('footer').boundingBox()
      expect(box!.y + box!.height).toBeLessThanOrEqual(footer!.y + footer!.height + 1)
    }
  })
}
