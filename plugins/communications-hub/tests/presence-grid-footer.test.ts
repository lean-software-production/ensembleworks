// @vitest-environment jsdom
/**
 * bb 0.47.1 lays the rail-navigation sidebar out as a CSS GRID
 * (`grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto]`): nav rail
 * in column 1, the thread-list body in column 2, the settings gear under the
 * rail and the footer body under the thread list. A foreign element inserted
 * into that grid becomes an auto-placed grid item — it lands in an implicit
 * third row of the `auto` first column, widens that column to its own content
 * width and squeezes the thread list to a sliver. These fixtures transcribe the
 * structure from the installed 0.47.1 bundle (`index-PAhC7tf5.js`); the layout
 * that matters is written as INLINE styles, because jsdom computes inline
 * styles but has no Tailwind stylesheet.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, mountPluginContentScripts } from "@get-bb/plugin-sdk/testing/app";
import { mountPresenceStrip, type MountedPresenceStrip } from "../src/presence/ui/mount.js";
import type { PresenceView } from "../src/presence/view.js";

const NOW = 1_800_000_000_000;

const view: PresenceView = {
  rooms: [{ id: "room-1", name: "Team room" }],
  selectedRoomId: "room-1",
  room: {
    roomId: "room-1",
    roomName: "Team room",
    joinUrl: "https://zoom.us/j/12345",
    joinable: true,
    conversationId: "conversation-1",
    conversationTitle: "Team room sitting",
    availability: "live",
    completeness: "partial",
    participants: [{
      id: "conversation-1:1", label: "Ada", initials: "AD", speaking: false,
      speakingMsRemaining: 0, camera: "unknown", portraitAt: null,
    }],
    knownCount: 1,
    portraits: false,
    updatedAt: NOW,
    status: "1 person seen here · list may be incomplete",
  },
  reason: "ok",
  generatedAt: NOW,
};

const FOOTER_ITEMS = ["Server status", "Provider usage", "Mobile", "More"];
const COLUMN = "display: flex; flex-direction: column";
const ROW = "display: flex; flex-direction: row";
const GRID = "display: grid; grid-template-columns: auto minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; min-height: 0; flex: 1 1 0%";

function el(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

interface Host0471 {
  wrapper: HTMLElement;
  root: HTMLElement;
  grid: HTMLElement | null;
  gridChildren: Element[];
  body: HTMLElement;
  footer: HTMLElement;
  threads: HTMLElement[];
  clicks: string[];
}

function button(label: string, clicks: string[], attrs: Record<string, string> = {}): HTMLElement {
  const node = el("button", { type: "button", "aria-label": label, ...attrs }, label[0]!);
  node.addEventListener("click", () => clicks.push(label));
  return node;
}

/**
 * bb 0.47.1. `layout: "rail"` is the grid with the footer in its own cell;
 * `layout: "list"` puts the footer back inside the vertical sidebar body (the
 * body spans both rows and there is no footer cell).
 */
function sidebar0471(options: { layout?: "rail" | "list"; mobile?: boolean; open?: boolean; rootStyle?: string } = {}): Host0471 {
  const layout = options.layout ?? "rail";
  const clicks: string[] = [];
  const threads = ["Thread one", "Thread two", "Thread three"].map((title) =>
    el("a", { href: `#${title}`, "data-sidebar-thread-id": title }, title));
  const footer = el("div", { "data-sidebar": "footer", style: COLUMN },
    el("ul", { "data-sidebar": "menu", style: ROW }, ...FOOTER_ITEMS.map((label) => el("li", {}, button(label, clicks, { "data-footer-item": "" })))));
  const body = el("div", { "data-testid": "app-sidebar-body", style: `${COLUMN}; min-height: 0; min-width: 0; flex: 1 1 0%` },
    el("div", { "data-sidebar": "content", style: `${COLUMN}; min-height: 0; flex: 1 1 0%; overflow: auto` }, ...threads),
    el("div", { "data-testid": "disclosure-area", style: COLUMN }),
    ...(layout === "list" ? [footer] : []));
  const rail = el("nav", { "data-testid": "sidebar-navigation-rail", style: `${COLUMN}; position: relative; flex-shrink: 0; width: 48px` },
    button("Home", clicks), button("Search", clicks));
  const threadBody = el("div", {
    "data-sidebar": "collapsible-body", "data-testid": "nav-rail-sidebar-body",
    style: `position: relative; min-width: 0; flex: 1 1 0%; grid-column-start: 2; grid-row-start: 1${layout === "list" ? "; grid-row-end: span 2" : ""}`,
  }, el("div", { style: "display: flex; position: absolute; top: 0; bottom: 0; right: 0; width: calc(320px - 48px)" }, body));
  const gridChildren: Element[] = [rail, threadBody];
  if (layout === "rail") {
    gridChildren.push(
      el("div", { "data-testid": "settings-cell", style: `${ROW}; grid-column-start: 1; grid-row-start: 2; flex-shrink: 0; width: 48px` }, button("Settings", clicks)),
      el("div", { "data-sidebar": "collapsible-body", "data-testid": "sidebar-footer-body", style: "position: relative; min-width: 0; flex: 1 1 0%; grid-column-start: 2; grid-row-start: 2" },
        el("div", { style: `${ROW}; position: relative; height: 100%; width: calc(320px - 48px)` }, footer)),
    );
  }
  const grid = el("div", { "data-testid": "sidebar-grid", style: GRID }, ...gridChildren);
  const root = el("div", { "data-sidebar": "sidebar", style: options.rootStyle ?? `${COLUMN}; height: 100%; width: 100%` }, grid);
  const wrapper = options.mobile
    ? el("div", { "data-sidebar": "panel", "data-state": options.open === false ? "closed" : "open" }, root)
    : el("div", { "data-testid": "sidebar-wrapper" }, root);
  document.body.append(wrapper);
  return { wrapper, root, grid, gridChildren, body, footer, threads, clicks };
}

const mounted: { strip: MountedPresenceStrip; controller: AbortController }[] = [];

function mount(options: { width?: () => number } = {}): MountedPresenceStrip {
  const controller = new AbortController();
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const method = String(input).slice(String(input).lastIndexOf("/") + 1);
    const result = method === "presence.portrait" ? null : view;
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) } as unknown as Response;
  }) as typeof fetch;
  const strip = mountPresenceStrip({
    document,
    pluginId: "communications-hub",
    signal: controller.signal,
    fetchImpl,
    now: () => NOW,
    measure: options.width ?? (() => 320),
    viewport: () => ({ width: 1_280, height: 900 }),
    pollMs: 60_000,
  });
  mounted.push({ strip, controller });
  return strip;
}

const rowRoot = () => document.querySelector<HTMLElement>("#ewzp-row-root");
const row = () => document.querySelector<HTMLButtonElement>("#ewzp-row-root .ewzp-row")!;
const popover = () => document.querySelector<HTMLElement>("#ewzp-popover")!;

/** Let the strip's own MutationObserver run: it coalesces to one sync on the next animation frame. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
};

/** True when an element lays its children out on lines of their own. */
function stacksVertically(node: Element): boolean {
  const style = getComputedStyle(node);
  if (style.display.includes("flex")) return style.flexDirection.startsWith("column");
  return style.display === "block" || style.display === "flow-root";
}

/**
 * The grid must be left exactly as bb built it: same children, nothing of ours
 * among them, so no implicit track can appear and no column can be resized by us.
 */
function expectGridUntouched(host: Host0471): void {
  expect(Array.from(host.grid!.children)).toEqual(host.gridChildren);
  expect(rowRoot()?.parentElement).not.toBe(host.grid);
}

/** The row has a line of its own inside the sidebar, below the grid. */
function expectBelowGrid(host: Host0471): void {
  const node = rowRoot()!;
  expect(document.querySelectorAll("#ewzp-row-root")).toHaveLength(1);
  expectGridUntouched(host);
  expect(node.parentElement).toBe(host.root);
  expect(node.previousElementSibling).toBe(host.grid);
  expect(stacksVertically(node.parentElement!)).toBe(true);
  // The thread list and footer keep their own containers.
  expect(host.body.contains(node)).toBe(false);
  expect(host.footer.contains(node)).toBe(false);
}

afterEach(() => {
  for (const { strip, controller } of mounted.splice(0)) {
    controller.abort();
    strip.dispose();
  }
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  vi.restoreAllMocks();
});

describe("bb 0.47.1: the rail sidebar is a CSS grid", () => {
  it("never becomes a grid item: the row gets its own line below the grid", async () => {
    const host = sidebar0471();
    const strip = mount();
    await strip.refresh();

    expectBelowGrid(host);
  });

  it("leaves every thread, rail and footer control in place and working", async () => {
    const host = sidebar0471();
    const before = Array.from(host.root.querySelectorAll("button, a"));
    const strip = mount();
    await strip.refresh();

    expectGridUntouched(host);
    const after = Array.from(host.root.querySelectorAll("button, a")).filter((node) => !rowRoot()!.contains(node));
    expect(after).toEqual(before);
    for (const node of Array.from(host.root.querySelectorAll<HTMLButtonElement>("button"))) if (!rowRoot()!.contains(node)) node.click();
    expect(host.clicks).toEqual(["Home", "Search", "Settings", ...FOOTER_ITEMS]);
    // Threads stay inside the thread-list body.
    for (const thread of host.threads) expect(host.body.contains(thread)).toBe(true);
  });

  it("keeps the row's button and popover contract below the grid", async () => {
    sidebar0471();
    const strip = mount();
    await strip.refresh();

    const node = row();
    expect(node.getAttribute("aria-haspopup")).toBe("dialog");
    expect(node.getAttribute("aria-controls")).toBe("ewzp-popover");
    expect(node.getAttribute("aria-label")).toContain("Team room");
    node.click();
    expect(node.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(popover().querySelector(".ewzp-close"));
    popover().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(popover().hidden).toBe(true);
    expect(document.activeElement).toBe(node);
  });

  it("stays put through unrelated churn, without moves or computed-style reads", async () => {
    const host = sidebar0471();
    const strip = mount();
    await strip.refresh();
    expectBelowGrid(host);

    const moves: MutationRecord[] = [];
    const watcher = new MutationObserver((records) => moves.push(...records));
    watcher.observe(host.root, { childList: true });
    const reads = vi.spyOn(window, "getComputedStyle");
    for (let index = 0; index < 10; index += 1) {
      host.body.querySelector('[data-sidebar="content"]')!.append(el("span", {}, "streamed token"));
      strip.syncAnchor();
    }
    await settle();
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    moves.push(...watcher.takeRecords());
    watcher.disconnect();
    expect(moves).toHaveLength(0);
    expectBelowGrid(host);
  });

  it("follows a grid that bb re-renders after the row", async () => {
    const host = sidebar0471();
    const strip = mount();
    await strip.refresh();

    // React appends a replacement grid after our node when it rebuilds its last child.
    const fresh = sidebar0471();
    host.grid!.remove();
    host.root.append(fresh.grid!);
    fresh.wrapper.remove();
    await settle();
    expectBelowGrid({ ...fresh, wrapper: host.wrapper, root: host.root });
  });

  it("re-resolves when bb moves the SAME footer from the 0.46.1 footer row into the 0.47.1 grid", async () => {
    const host = sidebar0471();
    // Start in the 0.46.1 shape: the footer in a horizontal row that is a child of the column root.
    const footerCell = host.gridChildren[3]!;
    const oldRow = el("div", { "data-testid": "sidebar-footer-row", style: ROW },
      el("div", { style: `${ROW}; position: relative` }, host.footer));
    host.root.append(oldRow);
    const strip = mount();
    await strip.refresh();
    expect(rowRoot()!.nextElementSibling).toBe(oldRow);

    footerCell.firstElementChild!.append(host.footer);
    oldRow.remove();
    await settle();
    expectBelowGrid(host);
  });

  it("shows the rail tier in a collapsed sidebar and the full row once it expands", async () => {
    let width = 48;
    const host = sidebar0471();
    const strip = mount({ width: () => width });
    await strip.refresh();
    expectBelowGrid(host);
    expect(rowRoot()!.dataset.tier).toBe("rail");

    width = 320;
    strip.syncAnchor();
    expectBelowGrid(host);
    expect(rowRoot()!.dataset.tier).toBe("full");
  });

  it("moves into an open 0.47.1 mobile drawer below its grid, and back out", async () => {
    const desktop = sidebar0471();
    const strip = mount();
    await strip.refresh();
    expectBelowGrid(desktop);

    const drawer = sidebar0471({ mobile: true });
    strip.syncAnchor();
    expectBelowGrid(drawer);

    drawer.wrapper.setAttribute("data-state", "closed");
    strip.syncAnchor();
    expectBelowGrid(desktop);
  });

  it("puts nothing into a sidebar root that does not stack vertically", async () => {
    // Unsupported shape: the root itself is a grid. No safe line exists, so the
    // row stays out rather than becoming a grid item over app content.
    const host = sidebar0471({ rootStyle: GRID });
    const children = Array.from(host.root.children);
    const strip = mount();
    await strip.refresh();

    expect(rowRoot()).toBeNull();
    expect(Array.from(host.root.children)).toEqual(children);
    expectGridUntouched(host);
  });

  it("takes everything away on dispose and leaves the grid untouched", async () => {
    const host = sidebar0471();
    const strip = mount();
    await strip.refresh();

    strip.dispose();
    expect(rowRoot()).toBeNull();
    expect(document.querySelector("#ewzp-popover")).toBeNull();
    expectGridUntouched(host);
    expect(Array.from(host.root.children)).toEqual([host.grid]);
  });
});

describe("bb 0.47.1 list navigation keeps the original position", () => {
  it("sits directly above the footer inside the vertical sidebar body", async () => {
    const host = sidebar0471({ layout: "list" });
    const strip = mount();
    await strip.refresh();

    expectGridUntouched(host);
    expect(host.footer.previousElementSibling!.id).toBe("ewzp-row-root");
    expect(stacksVertically(rowRoot()!.parentElement!)).toBe(true);
  });
});

describe("through the registered content script", () => {
  it("places the production row below bb 0.47.1's grid", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ok: true, result: view }),
    } as unknown as Response);
    const host = sidebar0471();

    const app = await loadPluginApp(() => import("../app"));
    const scripts = await mountPluginContentScripts(app, { pluginId: "communications-hub" });
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    expectBelowGrid(host);
    await scripts.lifecycle.dispose();
    expect(rowRoot()).toBeNull();
  });
});
