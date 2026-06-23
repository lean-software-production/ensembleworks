# Driving the canvas with a headless browser

How to screenshot or poke the EnsembleWorks with Playwright — useful for
verifying canvas API changes end-to-end, debugging "it looks wrong" reports,
or letting an agent see what the room actually renders. Verified against
tldraw 5.1.0.

## Setup

Playwright is not a dependency of this repo (keep it that way — it's a debug
tool, not a build input). Install it in a scratch directory:

```bash
npx playwright install chromium          # once per machine
mkdir -p /tmp/canvas-probe && cd /tmp/canvas-probe
npm init -y && npm install playwright
```

## The traps, in the order they bite

1. **Connect to vite directly** (`http://localhost:5173/?room=team`), not the
   reverse proxy. Behind a forwarding proxy (GitHub Codespaces, etc.) the vite
   HMR websocket is pinned to the public hostname and fails with a 302 either
   way — harmless, but expect one `WebSocket closed without opened` pageerror.
   Against a production deploy (no vite), the Caddy URL works as-is.

2. **The name prompt is a blocking `window.prompt()`.** Until it's answered,
   `DOMContentLoaded` never fires and `page.goto` hangs at any `waitUntil`.
   Register the dialog handler *before* navigating:

   ```js
   page.on('dialog', (d) => d.accept('probe-bot').catch(() => {}))
   ```

3. **Rooms can have several tldraw pages.** New visitors land on the room's
   default page; the content you're looking for may be on another one. Deep
   links are enabled on the `<Tldraw>` component, so navigate by URL:

   ```
   ?room=<room>&d=v<x>.<y>.<w>.<h>.<pageIdWithoutPrefix>
   ```

   `v…` is the viewport in page coordinates; the last segment is the page id
   minus its `page:` prefix (omit it for the current page). Format source:
   `@tldraw/editor/dist-cjs/lib/utils/deepLinks.js`.

4. **tldraw culls off-viewport shapes from the DOM.** `getByText()` only finds
   shapes inside the current viewport — a zero count means "not in view", not
   "doesn't exist". Get true shape coordinates from the room database instead:

   ```js
   // server/data/rooms/<room>.sqlite, table documents(id, state BLOB)
   const rec = JSON.parse(Buffer.from(row.state).toString('utf8'))
   ```

5. **Prefer deep links over keyboard navigation.** Zoom shortcuts (Shift+1)
   are unreliable headlessly; URL deep links are deterministic.

## Minimal working script

```js
// node shot.mjs — screenshot a region of a room
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
page.on('dialog', (d) => d.accept('probe-bot').catch(() => {}))

// Deep link: viewport x.y.w.h plus page id (sans "page:" prefix)
await page.goto(
	'http://localhost:5173/?room=team&d=v1647.-1350.1400.1000.K7jj9az3rZ8EhD5Muccy6',
	{ waitUntil: 'domcontentloaded', timeout: 20000 }
)
await page.waitForTimeout(8000) // let sync deliver the room

await page.screenshot({ path: 'canvas.png' })
console.log('text on screen:', await page.getByText('some sticky text').count())
await browser.close()
```

## Good to know

- The probe shows up to teammates as a participant — name it `probe-bot` so
  nobody wonders who joined.
- Give the page ~8 seconds after load for the sync websocket to deliver
  shapes before screenshotting or querying.
- Note shapes only re-measure their label (`onBeforeUpdate`) when richText,
  font or size change — *not* on x/y moves. To force a re-measure from the
  UI, select the notes and toggle size via the style panel
  (`page.getByTestId('style.size.l')`, then `'style.size.m'`).
- `fontSizeAdjustment` on note shapes is a *multiplier* on the label font
  size (1 = unadjusted, <1 = shrink-to-fit). 0 renders the label at 0px —
  text present in the DOM but invisible on the canvas.
