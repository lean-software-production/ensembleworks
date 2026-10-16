// @vitest-environment jsdom
/**
 * Where the presence row lands in each shape of bb's sidebar footer.
 *
 * bb 0.46.1 moved `[data-sidebar="footer"]` out of the vertical sidebar body and
 * into a horizontal footer row (settings-gear rail cell + a clipped collapsible
 * body). A row inserted as the footer's previous sibling then shares that
 * horizontal, clipped line and pushes every footer item out of view. These
 * fixtures transcribe the host structures from the installed bundles
 * (0.45.0 `index-l1a498i5.js`, 0.46.0 `index-Bx7Wj-0K.js`, 0.46.1
 * `index-DLL4t6p_.js`). The layout that matters is written as INLINE styles,
 * because jsdom computes inline styles but has no Tailwind stylesheet.
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

const FOOTER_ITEMS = ["Provider usage", "Server status", "Mobile", "Report a bug", "Customize footer"];

/** Builds an element from a tag, attributes, inline style and children. */
function el(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

const COLUMN = "display: flex; flex-direction: column";
const ROW = "display: flex; flex-direction: row";

function footerMenu(clicks: string[], extra: HTMLElement[] = []): HTMLElement {
  const items = FOOTER_ITEMS.map((label) => {
    const button = el("button", { type: "button", "aria-label": label, "data-footer-item": "" }, label[0]!);
    button.addEventListener("click", () => clicks.push(label));
    return el("li", { "data-sidebar": "menu-item" }, button);
  });
  return el("ul", { "data-sidebar": "menu", style: ROW }, ...extra.map((e) => el("li", {}, e)), ...items);
}

interface Host {
  wrapper: HTMLElement;
  root: HTMLElement;
  footer: HTMLElement;
  /** The element that holds the whole footer region in this host version. */
  region: HTMLElement;
  clicks: string[];
}

/** bb 0.46.1: the footer sits inside a horizontal row, inside a clipped body. */
function sidebar0461(options: { mobile?: boolean; open?: boolean; parent?: HTMLElement } = {}): Host {
  const clicks: string[] = [];
  const settings = el("button", { type: "button", "aria-label": "Settings" }, "⚙");
  settings.addEventListener("click", () => clicks.push("Settings"));
  const footer = el("div", { "data-sidebar": "footer", style: COLUMN }, footerMenu(clicks));
  const region = el("div", { "data-testid": "sidebar-footer-row", style: `${ROW}; align-items: stretch; flex-shrink: 0` },
    el("div", { "data-testid": "rail-cell", style: "display: flex; flex-shrink: 0; width: 44px" }, settings),
    el("div", { "data-sidebar": "collapsible-body", style: "position: relative; min-width: 0; flex: 1 1 0%; clip-path: inset(0 -6px 0 0)" },
      el("div", { "data-testid": "collapsible-inner", style: `${ROW}; position: relative; height: 100%` }, footer)));
  const root = el("div", { "data-sidebar": "sidebar", style: `${COLUMN}; height: 100%; width: 100%` },
    el("div", { "data-testid": "rail-and-body", style: "display: flex; min-height: 0; flex: 1 1 0%" },
      el("div", { "data-testid": "nav-rail", style: "width: 44px" }),
      el("div", { "data-sidebar": "collapsible-body", "data-testid": "nav-rail-sidebar-body", style: "position: relative; min-width: 0; flex: 1 1 0%" },
        el("div", { style: `${ROW}; position: relative; height: 100%` },
          el("div", { "data-testid": "app-sidebar-body", style: `${COLUMN}; min-height: 0; flex: 1 1 0%` },
            el("div", { "data-sidebar": "content" }, "thread list"))))),
    region);
  const wrapper = options.mobile
    ? el("div", { "data-sidebar": "panel", "data-state": options.open === false ? "closed" : "open" }, root)
    : el("div", { "data-testid": "sidebar-wrapper" }, root);
  (options.parent ?? document.body).append(wrapper);
  return { wrapper, root, footer, region, clicks };
}

/** bb 0.45.0: the footer is a direct child of the vertical sidebar body; the gear is a footer item. */
function sidebar045(): Host {
  const clicks: string[] = [];
  const settings = el("button", { type: "button", "aria-label": "Settings" }, "⚙");
  settings.addEventListener("click", () => clicks.push("Settings"));
  const footer = el("div", { "data-sidebar": "footer", style: `${COLUMN}; position: relative` }, footerMenu(clicks, [settings]));
  const root = el("div", { "data-sidebar": "sidebar", style: COLUMN },
    el("div", { "data-testid": "app-sidebar-body", style: `${COLUMN}; min-height: 0; flex: 1 1 0%` },
      el("div", { "data-sidebar": "content" }, "thread list"), footer));
  const wrapper = el("div", {}, root);
  document.body.append(wrapper);
  return { wrapper, root, footer, region: footer, clicks };
}

/** bb 0.46.0: nav rail exists, but the footer is still in the vertical sidebar body. */
function sidebar0460(): Host {
  const clicks: string[] = [];
  const footer = el("div", { "data-sidebar": "footer", style: `${COLUMN}; position: relative` }, footerMenu(clicks));
  const root = el("div", { "data-sidebar": "sidebar", style: COLUMN },
    el("div", { style: "display: flex; min-height: 0; flex: 1 1 0%" },
      el("div", { "data-testid": "nav-rail", style: "width: 44px" }),
      el("div", { "data-sidebar": "collapsible-body", style: "position: relative; min-width: 0; flex: 1 1 0%" },
        el("div", { "data-testid": "app-sidebar-body", style: `${COLUMN}; min-height: 0; flex: 1 1 0%` },
          el("div", { "data-sidebar": "content" }, "thread list"), footer))));
  const wrapper = el("div", {}, root);
  document.body.append(wrapper);
  return { wrapper, root, footer, region: footer, clicks };
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
    measure: options.width ?? (() => 256),
    viewport: () => ({ width: 1_280, height: 900 }),
    pollMs: 60_000,
  });
  mounted.push({ strip, controller });
  return strip;
}

const rowRoot = () => document.querySelector<HTMLElement>("#ewzp-row-root");
const row = () => document.querySelector<HTMLButtonElement>("#ewzp-row-root .ewzp-row")!;
const popover = () => document.querySelector<HTMLElement>("#ewzp-popover")!;

/** Every focusable control in the sidebar, in document (= Tab) order. */
function tabOrder(root: Element): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>("button, a[href], select, [tabindex]:not([tabindex='-1'])"))
    .map((node) => node.getAttribute("aria-label") ?? node.textContent ?? "")
    .map((label) => (label.includes("Team room") ? "ZOOM" : label));
}

/** The row must sit on its own line in a vertical stack, never inside the footer region. */
function expectAboveRegion(host: Host): void {
  const node = rowRoot()!;
  expect(document.querySelectorAll("#ewzp-row-root")).toHaveLength(1);
  expect(node.nextElementSibling).toBe(host.region);
  expect(host.region.contains(node)).toBe(false);
  // Its parent stacks children vertically (a column, or plain block flow).
  const parent = getComputedStyle(node.parentElement!);
  expect(parent.display.includes("flex") && !parent.flexDirection.startsWith("column")).toBe(false);
  expect(host.root.contains(node)).toBe(true);
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

describe("bb 0.46.1: the footer lives in a horizontal, clipped row", () => {
  it("puts the row above the whole footer row, not inside the clipped footer body", async () => {
    const host = sidebar0461();
    const strip = mount();
    await strip.refresh();

    expectAboveRegion(host);
    expect(rowRoot()!.parentElement).toBe(host.root);
    // Nothing of ours joined the horizontal footer line.
    expect(host.region.querySelector("#ewzp-row-root")).toBeNull();
    expect(host.footer.previousElementSibling).toBeNull();
  });

  it("leaves every footer control in place, working, and after the row in Tab order", async () => {
    const host = sidebar0461();
    const before = Array.from(host.region.querySelectorAll("button"));
    const strip = mount();
    await strip.refresh();

    const after = Array.from(host.region.querySelectorAll("button"));
    expect(after).toEqual(before);
    for (const button of after) button.click();
    expect(host.clicks).toEqual(["Settings", ...FOOTER_ITEMS]);
    expect(tabOrder(host.root).filter((label) => label !== "thread list")).toEqual(["ZOOM", "Settings", ...FOOTER_ITEMS]);
  });

  it("keeps the row's button and popover contract in the new position", async () => {
    sidebar0461();
    const strip = mount();
    await strip.refresh();

    const button = row();
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-controls")).toBe("ewzp-popover");
    expect(button.getAttribute("aria-label")).toContain("Team room");
    expect(button.getAttribute("aria-expanded")).toBe("false");

    button.click();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(popover().hidden).toBe(false);
    expect(document.activeElement).toBe(popover().querySelector(".ewzp-close"));
    expect(popover().querySelector(".ewzp-join")!.getAttribute("aria-label")).toContain("Team room");

    popover().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(popover().hidden).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it("is idempotent: repeated syncs and unrelated mutations neither move nor duplicate it", async () => {
    const host = sidebar0461();
    const strip = mount();
    await strip.refresh();
    expectAboveRegion(host);

    const moves: MutationRecord[] = [];
    const watcher = new MutationObserver((records) => moves.push(...records));
    watcher.observe(host.wrapper, { childList: true, subtree: true });
    for (let index = 0; index < 5; index += 1) {
      document.body.append(el("span", {}, "streamed token"));
      strip.syncAnchor();
    }
    moves.push(...watcher.takeRecords());
    watcher.disconnect();
    expect(moves).toHaveLength(0);
    expectAboveRegion(host);
  });

  it("re-anchors after bb replaces the footer row, and after React shuffles the row into the footer body", async () => {
    const host = sidebar0461();
    const strip = mount();
    await strip.refresh();

    // React shuffle: the foreign node ends up where the 0.46.1 regression put it.
    host.footer.parentElement!.insertBefore(rowRoot()!, host.footer);
    strip.syncAnchor();
    expectAboveRegion(host);

    // Re-render: an identical-looking footer row replaces the old one.
    const fresh = sidebar0461();
    host.region.replaceWith(fresh.region);
    fresh.wrapper.remove();
    strip.syncAnchor();
    expectAboveRegion({ ...host, region: fresh.region, footer: fresh.footer });
  });

  it("follows a whole-sidebar rebuild, and waits for a sidebar that mounts late", async () => {
    const strip = mount();
    await strip.refresh();
    expect(rowRoot()).toBeNull();

    const late = sidebar0461();
    strip.syncAnchor();
    expectAboveRegion(late);

    late.wrapper.remove();
    const rebuilt = sidebar0461();
    strip.syncAnchor();
    expectAboveRegion(rebuilt);
  });

  it("shows the rail tier in a collapsed sidebar and the full row once it expands", async () => {
    let width = 44;
    const host = sidebar0461();
    const strip = mount({ width: () => width });
    await strip.refresh();

    // The collapsed rail hides the footer body; the row is outside it.
    expectAboveRegion(host);
    expect(rowRoot()!.dataset.tier).toBe("rail");

    width = 256;
    strip.syncAnchor();
    expectAboveRegion(host);
    expect(rowRoot()!.dataset.tier).toBe("full");
  });

  it("moves into an open 0.46.1 mobile drawer above its footer row, and back out", async () => {
    const desktop = sidebar0461();
    const strip = mount();
    await strip.refresh();
    expectAboveRegion(desktop);

    const drawer = sidebar0461({ mobile: true });
    strip.syncAnchor();
    expectAboveRegion(drawer);

    drawer.wrapper.setAttribute("data-state", "closed");
    strip.syncAnchor();
    expectAboveRegion(desktop);
  });

  it("never climbs out of the sidebar root into the app around it", async () => {
    // The app shell around the sidebar is itself a column; the row must still
    // stop at the sidebar's own root.
    const shell = el("div", { "data-testid": "app-shell", style: COLUMN });
    document.body.append(shell);
    const host = sidebar0461({ parent: shell });
    // A horizontal root with the footer row as its only child: nothing inside
    // the root is a column, so there is no footer region to sit above.
    host.root.setAttribute("style", ROW);
    host.root.replaceChildren(host.region);
    const strip = mount();
    await strip.refresh();

    expect(document.querySelectorAll("#ewzp-row-root")).toHaveLength(1);
    expect(shell.contains(rowRoot())).toBe(true);
    expect(host.root.contains(rowRoot())).toBe(true);
    expect(host.region.contains(rowRoot())).toBe(false);
    expect(rowRoot()!.parentElement).toBe(host.root);
  });

  it("stops at a vertical stack that holds other content, rather than jumping above it", async () => {
    // A block that stacks the thread list and the footer region: the row belongs
    // between them, never above the thread list.
    const host = sidebar0461();
    const stack = el("div", { "data-testid": "stack" });
    const content = host.root.querySelector('[data-testid="rail-and-body"]')!;
    host.root.append(stack);
    stack.append(content, host.region);
    const strip = mount();
    await strip.refresh();

    expectAboveRegion(host);
    expect(rowRoot()!.parentElement).toBe(stack);
    expect(rowRoot()!.previousElementSibling).toBe(content);
  });

  it("takes everything away on dispose and leaves the footer row untouched", async () => {
    const host = sidebar0461();
    const children = Array.from(host.region.children);
    const strip = mount();
    await strip.refresh();

    strip.dispose();
    expect(rowRoot()).toBeNull();
    expect(document.querySelector("#ewzp-popover")).toBeNull();
    expect(document.querySelector("#ewzp-styles")).toBeNull();
    expect(Array.from(host.region.children)).toEqual(children);
  });
});

describe("the remembered footer region follows host re-parenting", () => {
  /** Let the strip's own MutationObserver run: it coalesces to one sync on the next animation frame. */
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  };

  it("re-resolves when bb moves the SAME footer from the column body into the 0.46.1 footer row, without a resize", async () => {
    const old = sidebar045();
    const strip = mount();
    await strip.refresh();
    expectAboveRegion(old);

    // The footer element survives; bb re-parents it into a 0.46.1 footer row.
    const next = sidebar0461();
    next.region.querySelector('[data-testid="collapsible-inner"]')!.replaceChildren(old.footer);
    old.root.append(next.region);
    next.wrapper.remove();
    const moved = { ...old, region: next.region };

    await settle();
    expectAboveRegion(moved);
    // And the poll path keeps it there.
    for (let index = 0; index < 3; index += 1) await strip.refresh();
    expectAboveRegion(moved);
    expect(document.querySelector('[data-sidebar="footer"]')).toBe(old.footer);
  });

  it("re-resolves when the remembered footer row itself is moved into a new horizontal wrapper", async () => {
    const host = sidebar0461();
    const strip = mount();
    await strip.refresh();
    expectAboveRegion(host);

    const outer = el("div", { "data-testid": "outer-row", style: ROW });
    host.root.append(outer);
    outer.append(host.region);

    await settle();
    expectAboveRegion({ ...host, region: outer });
    await strip.refresh();
    expectAboveRegion({ ...host, region: outer });
  });

  it("reuses the remembered region through unrelated churn without reading computed styles", async () => {
    const host = sidebar0461();
    const strip = mount();
    await strip.refresh();
    expectAboveRegion(host);

    const reads = vi.spyOn(window, "getComputedStyle");
    for (let index = 0; index < 10; index += 1) {
      host.root.querySelector('[data-sidebar="content"]')!.append(el("span", {}, "streamed token"));
      strip.syncAnchor();
    }
    await settle();
    await strip.refresh();
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    expectAboveRegion(host);
  });
});

describe("older hosts keep the original position", () => {
  it("bb 0.45.0: directly above the footer inside the vertical sidebar body", async () => {
    const host = sidebar045();
    const strip = mount();
    await strip.refresh();

    expectAboveRegion(host);
    expect(host.footer.previousElementSibling!.id).toBe("ewzp-row-root");
    expect(tabOrder(host.root).filter((label) => label !== "thread list")).toEqual(["ZOOM", "Settings", ...FOOTER_ITEMS]);
  });

  it("bb 0.46.0: directly above the footer inside the vertical sidebar body", async () => {
    const host = sidebar0460();
    const strip = mount();
    await strip.refresh();

    expectAboveRegion(host);
    expect(host.footer.previousElementSibling!.id).toBe("ewzp-row-root");
  });
});

describe("through the registered content script", () => {
  it("places the production row above bb 0.46.1's footer row", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ok: true, result: view }),
    } as unknown as Response);
    const host = sidebar0461();

    const app = await loadPluginApp(() => import("../app"));
    const scripts = await mountPluginContentScripts(app, { pluginId: "communications-hub" });
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    expectAboveRegion(host);
    await scripts.lifecycle.dispose();
    expect(rowRoot()).toBeNull();
  });
});
