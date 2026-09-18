// Real-browser validation of the presence strip.
//
// jsdom proves structure, aria and keyboard wiring; it has no layout engine, so
// it cannot answer the questions this feature is actually judged on: is the row
// 36px, does it clip rather than overflow, does the thread list keep its own
// scroll, and does the popover land on screen. This drives the REAL module in a
// REAL Chromium against a faithful copy of bb's sidebar and measures.
//
// Run:
//   npm run check:browser -- [screenshot-directory]
//
// Needs a Playwright install and a Chromium build. Both are environment, not
// dependencies of this plugin, so they are pointed at by env vars and the check
// REPORTS ITS OWN ABSENCE rather than passing silently:
//   PRESENCE_PLAYWRIGHT=/path/to/playwright/index.mjs
//   PRESENCE_CHROMIUM=/path/to/chrome-headless-shell
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLAYWRIGHT = process.env.PRESENCE_PLAYWRIGHT
  ?? "/home/ensembleworks-agent/ensembleworks/node_modules/playwright/index.mjs";
const pageRoot = fileURLToPath(new URL(".", import.meta.url));
const bundleRoot = fileURLToPath(new URL("../../dist/presence-harness", import.meta.url));
const shots = process.argv[2] ?? bundleRoot;

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer(async (request, response) => {
  const path = request.url === "/" ? "/index.html" : request.url.split("?")[0];
  try {
    const root = path.endsWith(".js") ? bundleRoot : pageRoot;
    const body = await readFile(join(root, path));
    response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
await mkdir(shots, { recursive: true });

let chromium;
try {
  ({ chromium } = await import(PLAYWRIGHT));
} catch (error) {
  console.error(`browser check UNAVAILABLE: no Playwright at ${PLAYWRIGHT} (${error.message})`);
  server.close();
  process.exit(2);
}
// An explicit executable, because a Playwright install often expects a browser
// build that is not on the machine and cannot be downloaded from a sandbox.
// Naming the binary is honest about what was actually driven.
const SHELL = process.env.PRESENCE_CHROMIUM
  ?? "/home/ensembleworks-agent/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell";
let browser;
try {
  browser = await chromium.launch(SHELL ? { executablePath: SHELL } : {});
} catch (error) {
  console.error(`browser check UNAVAILABLE: could not launch ${SHELL} (${error.message})`);
  server.close();
  process.exit(2);
}
console.log(`driving ${SHELL}`);
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : ` — ${detail}`}`);
};

async function open(page, options = {}) {
  await page.goto(base);
  await page.waitForFunction(() => window.__ready === true);
  if (options.sidebarWidth !== undefined) {
    await page.evaluate((width) => {
      document.querySelector("#desktop").style.setProperty("--sidebar-width", `${width}px`);
    }, options.sidebarWidth);
  }
  if (options.view !== undefined || options.count !== undefined || options.rooms !== undefined) {
    await page.evaluate(([view, count, rooms]) => {
      window.__setView(view ?? {}, count ?? 4, rooms ?? [{ id: "room-1", name: "Team room" }]);
    }, [options.view, options.count, options.rooms]);
  }
  await page.evaluate(() => window.__strip.refresh());
  await page.evaluate(() => window.__strip.syncAnchor());
  await page.waitForTimeout(80);
}

// ── Desktop, an occupied room ───────────────────────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 1_280, height: 900 } });
  await open(page, { count: 6 });

  const geometry = await page.evaluate(() => {
    const root = document.querySelector("#ewzp-row-root");
    const row = root.querySelector(".ewzp-row");
    const footer = document.querySelector('[data-sidebar="footer"]');
    const content = document.querySelector('[data-sidebar="content"]');
    return {
      rowHeight: row.getBoundingClientRect().height,
      rootHeight: root.getBoundingClientRect().height,
      rowBottom: row.getBoundingClientRect().bottom,
      footerTop: footer.getBoundingClientRect().top,
      insideContent: content.contains(root),
      overflowX: row.scrollWidth - row.clientWidth,
      faces: Array.from(row.querySelectorAll(".ewzp-face")).map((face) => face.textContent),
      name: row.querySelector(".ewzp-name").textContent,
      rowCount: document.querySelectorAll("#ewzp-row-root").length,
    };
  });
  check("row is exactly 36px tall", geometry.rowHeight === 36, `${geometry.rowHeight}px`);
  check("row costs one line of sidebar", geometry.rootHeight <= 40, `${geometry.rootHeight}px total`);
  check("row sits immediately above the footer", geometry.rowBottom <= geometry.footerTop + 3,
    `row bottom ${geometry.rowBottom}, footer top ${geometry.footerTop}`);
  check("row is outside the scrolling thread list", geometry.insideContent === false);
  check("row clips rather than overflowing", geometry.overflowX <= 0, `${geometry.overflowX}px`);
  check("row shows three faces plus overflow", geometry.faces.join(",") === "AL,SA,IN,+3", geometry.faces.join(","));
  check("row shows the room name at full width", geometry.name === "Team room", geometry.name);
  check("exactly one row exists", geometry.rowCount === 1, String(geometry.rowCount));

  // The thread list keeps its own scroll, before and after the popover opens.
  const scroll = await page.evaluate(async () => {
    const content = document.querySelector('[data-sidebar="content"]');
    content.scrollTop = 120;
    const before = content.scrollTop;
    document.querySelector("#ewzp-row-root .ewzp-row").click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { before, after: content.scrollTop, scrollable: content.scrollHeight > content.clientHeight };
  });
  check("thread list still scrolls", scroll.scrollable);
  check("opening the popover leaves the thread list where it was",
    scroll.before === scroll.after, `${scroll.before} → ${scroll.after}`);

  const popover = await page.evaluate(() => {
    const node = document.querySelector("#ewzp-popover");
    const row = document.querySelector("#ewzp-row-root .ewzp-row").getBoundingClientRect();
    const box = node.getBoundingClientRect();
    const list = node.querySelector(".ewzp-people");
    return {
      hidden: node.hidden,
      box: { top: box.top, left: box.left, right: box.right, bottom: box.bottom, height: box.height },
      rowTop: row.top,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      listScrollable: list.scrollHeight > list.clientHeight,
      people: node.querySelectorAll(".ewzp-person").length,
    };
  });
  check("popover is open", popover.hidden === false);
  check("popover hangs above the row", popover.box.bottom <= popover.rowTop,
    `popover bottom ${popover.box.bottom}, row top ${popover.rowTop}`);
  check("popover is fully on screen",
    popover.box.top >= 0 && popover.box.left >= 0 &&
    popover.box.right <= popover.viewport.width && popover.box.bottom <= popover.viewport.height,
    JSON.stringify(popover.box));
  check("popover is bounded in height", popover.box.height <= 340, `${popover.box.height}px`);
  check("popover lists everybody", popover.people === 6, String(popover.people));
  await page.screenshot({ path: join(shots, "presence-desktop-open.png") });

  // Keyboard: close, then drive the whole interaction from the keyboard alone.
  const keyboard = await page.evaluate(async () => {
    document.querySelector("#ewzp-popover .ewzp-close").click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    document.querySelector("#ewzp-row-root .ewzp-row").focus();
    return document.activeElement.className;
  });
  check("row takes focus", keyboard.includes("ewzp-row"), keyboard);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(60);
  const afterEnter = await page.evaluate(() => ({
    open: document.querySelector("#ewzp-popover").hidden === false,
    focus: document.activeElement.className,
    expanded: document.querySelector("#ewzp-row-root .ewzp-row").getAttribute("aria-expanded"),
  }));
  check("Enter opens the popover", afterEnter.open && afterEnter.expanded === "true", JSON.stringify(afterEnter));
  check("focus moves into the dialog", afterEnter.focus.includes("ewzp-close"), afterEnter.focus);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(60);
  const afterEscape = await page.evaluate(() => ({
    open: document.querySelector("#ewzp-popover").hidden === false,
    focus: document.activeElement.className,
  }));
  check("Escape closes the popover", afterEscape.open === false);
  check("focus returns to the row", afterEscape.focus.includes("ewzp-row"), afterEscape.focus);
  await page.close();
}

// ── A narrow sidebar, and bb's collapsed rail ───────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 1_280, height: 900 } });
  await open(page, { sidebarWidth: 170, count: 6 });
  const narrow = await page.evaluate(() => {
    const row = document.querySelector("#ewzp-row-root .ewzp-row");
    return {
      height: row.getBoundingClientRect().height,
      overflowX: row.scrollWidth - row.clientWidth,
      nameHidden: row.querySelector(".ewzp-name").hidden,
      faces: Array.from(row.querySelectorAll(".ewzp-face")).map((face) => face.textContent),
      tier: document.querySelector("#ewzp-row-root").dataset.tier,
    };
  });
  check("narrow sidebar keeps one 36px line", narrow.height === 36, `${narrow.height}px`);
  check("narrow sidebar drops the room name", narrow.nameHidden === true);
  check("narrow sidebar still clips", narrow.overflowX <= 0, `${narrow.overflowX}px`);
  check("narrow sidebar shows two faces and a count", narrow.faces.join(",") === "AL,SA,+4", narrow.faces.join(","));
  await page.screenshot({ path: join(shots, "presence-narrow.png") });

  await open(page, { sidebarWidth: 60, count: 6 });
  const rail = await page.evaluate(() => {
    const row = document.querySelector("#ewzp-row-root .ewzp-row");
    return {
      height: row.getBoundingClientRect().height,
      overflowX: row.scrollWidth - row.clientWidth,
      count: row.querySelector(".ewzp-count").textContent,
      faces: row.querySelectorAll(".ewzp-face").length,
      tier: document.querySelector("#ewzp-row-root").dataset.tier,
      label: row.getAttribute("aria-label"),
    };
  });
  check("collapsed rail keeps one 36px line", rail.height === 36, `${rail.height}px`);
  check("collapsed rail shows a bare count", rail.count === "6" && rail.faces === 0, JSON.stringify(rail));
  check("collapsed rail still clips", rail.overflowX <= 0, `${rail.overflowX}px`);
  check("collapsed rail keeps its accessible name", rail.label.startsWith("Team room."), rail.label);
  await page.screenshot({ path: join(shots, "presence-rail.png") });
  await page.close();
}

// ── A phone-sized window with bb's drawer ───────────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
  await open(page, { count: 6 });
  await page.evaluate(() => {
    document.querySelector("#drawer").setAttribute("data-state", "open");
    window.__strip.syncAnchor();
  });
  await page.waitForTimeout(60);
  const mobile = await page.evaluate(() => {
    const root = document.querySelector("#ewzp-row-root");
    document.querySelector("#ewzp-row-root .ewzp-row").click();
    const popover = document.querySelector("#ewzp-popover").getBoundingClientRect();
    return {
      inDrawer: document.querySelector("#drawer").contains(root),
      rows: document.querySelectorAll("#ewzp-row-root").length,
      height: root.querySelector(".ewzp-row").getBoundingClientRect().height,
      popover: { top: popover.top, left: popover.left, right: popover.right, bottom: popover.bottom },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
  check("row follows the open mobile drawer", mobile.inDrawer === true);
  check("still exactly one row on a phone", mobile.rows === 1, String(mobile.rows));
  check("still 36px on a phone", mobile.height === 36, `${mobile.height}px`);
  check("popover stays on a phone screen",
    mobile.popover.top >= 0 && mobile.popover.left >= 0 &&
    mobile.popover.right <= mobile.viewport.width && mobile.popover.bottom <= mobile.viewport.height,
    JSON.stringify(mobile.popover));
  await page.screenshot({ path: join(shots, "presence-mobile.png") });
  await page.close();
}

// ── A room with no live stream ──────────────────────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 1_280, height: 900 } });
  await open(page, {
    count: 0,
    view: {
      availability: "unavailable",
      completeness: "unknown",
      participants: [],
      knownCount: 0,
      status: "No active stream — BB cannot tell who is here",
    },
  });
  const quiet = await page.evaluate(() => {
    const row = document.querySelector("#ewzp-row-root .ewzp-row");
    row.click();
    return {
      height: row.getBoundingClientRect().height,
      note: row.querySelector(".ewzp-note").textContent,
      message: document.querySelector("#ewzp-popover .ewzp-empty").textContent,
    };
  });
  check("quiet room keeps the same single line", quiet.height === 36, `${quiet.height}px`);
  check("quiet room offers the door", quiet.note === "Open Zoom", quiet.note);
  check("quiet room does not claim to be empty",
    quiet.message.includes("BB cannot tell who is here"), quiet.message);
  await page.screenshot({ path: join(shots, "presence-no-stream.png") });
  await page.close();
}

// ── An answer that has stopped being refreshed ──────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 1_280, height: 900 } });
  await open(page, { count: 6 });
  const live = await page.evaluate(() => ({
    speaking: document.querySelectorAll('#ewzp-row-root .ewzp-face[data-speaking="true"]').length,
    faces: document.querySelectorAll("#ewzp-row-root .ewzp-face:not(.ewzp-more)").length,
  }));
  check("a live answer lights the speaker and shows faces",
    live.speaking === 1 && live.faces === 3, JSON.stringify(live));

  const stale = await page.evaluate(async () => {
    window.__rpcBroken = true;
    window.__clockOffset = 60_000;
    await window.__strip.refresh();
    const root = document.querySelector("#ewzp-row-root");
    const row = root.querySelector(".ewzp-row");
    row.click();
    const popover = document.querySelector("#ewzp-popover").getBoundingClientRect();
    return {
      height: row.getBoundingClientRect().height,
      overflowX: row.scrollWidth - row.clientWidth,
      speaking: root.querySelectorAll('.ewzp-face[data-speaking="true"]').length,
      faces: root.querySelectorAll(".ewzp-face:not(.ewzp-more)").length,
      note: row.querySelector(".ewzp-note").textContent,
      label: row.getAttribute("aria-label"),
      message: document.querySelector("#ewzp-popover .ewzp-empty").textContent,
      onScreen: popover.top >= 0 && popover.left >= 0 &&
        popover.right <= window.innerWidth && popover.bottom <= window.innerHeight,
    };
  });
  check("a minute of failed polls puts the ring out", stale.speaking === 0, String(stale.speaking));
  check("a minute of failed polls shows nobody", stale.faces === 0, String(stale.faces));
  check("the stale row says so", stale.note === "No updates", stale.note);
  check("the stale row names the problem for a screen reader",
    stale.label.includes("Presence unavailable"), stale.label);
  check("the stale popover explains rather than claims",
    stale.message.includes("has not been able to refresh"), stale.message);
  check("the stale row is still exactly 36px", stale.height === 36, `${stale.height}px`);
  check("the stale row still clips rather than overflowing", stale.overflowX <= 0, `${stale.overflowX}px`);
  check("the stale popover is still on screen", stale.onScreen === true);
  await page.screenshot({ path: join(shots, "presence-stale.png") });
  await page.close();
}

// ── A still the validator accepts and the browser cannot draw ───────────────
//
// `isJpeg` validates STRUCTURE, not entropy-coded data, and that boundary is
// only defensible if the UI covers the residue. These bytes are the exact shape
// the store accepts — SOI, a two-component frame with distinct identifiers, a
// coherent scan, one byte of scan data, EOI — and Chromium still refuses to
// decode them. jsdom cannot answer this: it has no image decoder, so only a
// real browser can say whether the face ends up as a picture, an empty hole, or
// initials.
{
  const page = await browser.newPage({ viewport: { width: 1_280, height: 900 } });
  const undecodable = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0e, 0x08, 0x00, 0x01, 0x00, 0x01, 0x02, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x42,
    0xff, 0xd9,
  ]).toString("base64");
  /** The duplicate-identifier frame the validator now refuses outright. */
  const duplicateIds = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0e, 0x08, 0x00, 0x01, 0x00, 0x01, 0x02, 0x01, 0x11, 0x00, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x42,
    0xff, 0xd9,
  ]).toString("base64");

  await page.goto(base);
  await page.waitForFunction(() => window.__ready === true);

  const decoded = await page.evaluate(async ([valid, duplicate]) => {
    const load = (base64) => new Promise((resolve) => {
      const image = new Image();
      image.addEventListener("load", () => resolve({ loaded: true, width: image.naturalWidth }));
      image.addEventListener("error", () => resolve({ loaded: false, width: image.naturalWidth }));
      image.src = `data:image/jpeg;base64,${base64}`;
    });
    return { valid: await load(valid), duplicate: await load(duplicate) };
  }, [undecodable, duplicateIds]);
  check("Chromium refuses the duplicate-identifier frame",
    decoded.duplicate.loaded === false, JSON.stringify(decoded.duplicate));
  check("Chromium refuses a structurally valid frame with no real picture in it",
    decoded.valid.loaded === false, JSON.stringify(decoded.valid));

  const face = await page.evaluate(async (base64) => {
    window.__portrait = {
      participantId: "conversation-1:0",
      capturedAt: Date.now(),
      dataUrl: `data:image/jpeg;base64,${base64}`,
    };
    window.__setView({ portraits: true }, 2);
    window.__view.room.participants[0].portraitAt = window.__portrait.capturedAt;
    await window.__strip.refresh();
    await new Promise((resolve) => setTimeout(resolve, 60));
    document.querySelector("#ewzp-row-root .ewzp-row").click();
    // Long enough for the decode to fail and the error handler to run.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const person = document.querySelector("#ewzp-popover .ewzp-person .ewzp-face");
    return {
      images: document.querySelectorAll("#ewzp-popover .ewzp-person img").length,
      text: person.textContent,
      size: person.getBoundingClientRect().width,
    };
  }, undecodable);
  check("a still the browser cannot draw leaves no broken image", face.images === 0, String(face.images));
  check("the face falls back to initials", face.text === "AL", face.text);
  check("the face keeps its circle", face.size >= 16, `${face.size}px`);
  await page.screenshot({ path: join(shots, "presence-undecodable-still.png") });
  await page.close();
}

await browser.close();
server.close();

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
