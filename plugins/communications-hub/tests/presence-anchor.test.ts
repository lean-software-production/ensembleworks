import { describe, expect, it } from "vitest";
import { chooseSidebar, decideAnchor, footerRegion, type AnchorInput, type RegionLayout } from "../src/presence/ui/anchor.js";

/** Opaque element handles: the decision never touches a real DOM. */
const footer = { name: "footer" };
const otherFooter = { name: "footer-2" };
const sidebar = { name: "sidebar" };

function input(overrides: Partial<AnchorInput<object>> = {}): AnchorInput<object> {
  return {
    footer: null,
    sidebar: null,
    attached: null,
    connected: false,
    beforeFooter: false,
    lastInSidebar: false,
    ...overrides,
  };
}

describe("anchor decisions", () => {
  it("sits immediately above the sidebar footer when there is one", () => {
    expect(decideAnchor(input({ footer, sidebar }))).toEqual({ action: "footer", host: footer });
  });

  it("does nothing when it is already exactly there", () => {
    expect(decideAnchor(input({
      footer, sidebar,
      attached: { kind: "footer", host: footer },
      connected: true,
      beforeFooter: true,
    }))).toEqual({ action: "none" });
  });

  it("moves when bb re-rendered the footer, even though it looks the same", () => {
    // Identity, not shape: a new footer element from a route change is not the
    // one we are attached to, and staying put would leave the row orphaned.
    expect(decideAnchor(input({
      footer: otherFooter, sidebar,
      attached: { kind: "footer", host: footer },
      connected: true,
      beforeFooter: true,
    }))).toEqual({ action: "footer", host: otherFooter });
  });

  it("moves back when a re-render shuffled the row away from the footer", () => {
    // React can reorder its own children around a foreign node. Noticing the
    // drift and relocating the ONE node we own is what stops a second row from
    // ever appearing.
    expect(decideAnchor(input({
      footer, sidebar,
      attached: { kind: "footer", host: footer },
      connected: true,
      beforeFooter: false,
    }))).toEqual({ action: "footer", host: footer });
  });

  it("re-attaches when the row was removed from the document", () => {
    expect(decideAnchor(input({
      footer, sidebar,
      attached: { kind: "footer", host: footer },
      connected: false,
      beforeFooter: true,
    }))).toEqual({ action: "footer", host: footer });
  });

  it("falls back to the end of a sidebar that has no footer", () => {
    expect(decideAnchor(input({ sidebar }))).toEqual({ action: "sidebar", host: sidebar });
    expect(decideAnchor(input({
      sidebar,
      attached: { kind: "sidebar", host: sidebar },
      connected: true,
      lastInSidebar: true,
    }))).toEqual({ action: "none" });
  });

  it("is promoted back to the footer as soon as one exists again", () => {
    expect(decideAnchor(input({
      footer, sidebar,
      attached: { kind: "sidebar", host: sidebar },
      connected: true,
      lastInSidebar: true,
    }))).toEqual({ action: "footer", host: footer });
  });

  it("leaves the document entirely on a route with no sidebar", () => {
    expect(decideAnchor(input({
      attached: { kind: "footer", host: footer },
      connected: true,
    }))).toEqual({ action: "detach" });
    // Already gone: nothing to do, and nothing left floating over the page.
    expect(decideAnchor(input())).toEqual({ action: "none" });
  });
});

describe("choosing between bb's two sidebars", () => {
  const desktop = { root: "desktop", footer: "desktop-footer", mobile: false, visible: true };
  const drawer = { root: "drawer", footer: "drawer-footer", mobile: true, visible: true };

  it("takes the desktop sidebar when it is the only one shown", () => {
    expect(chooseSidebar([desktop, { ...drawer, visible: false }])).toBe(desktop);
  });

  it("follows the mobile drawer while it is open", () => {
    // One node moves into the drawer and back out again: a strip in each would
    // be the duplicate this design is not allowed to have.
    expect(chooseSidebar([desktop, drawer])).toBe(drawer);
  });

  it("has nowhere to be when every sidebar is hidden", () => {
    expect(chooseSidebar([{ ...desktop, visible: false }, { ...drawer, visible: false }])).toBeNull();
    expect(chooseSidebar([])).toBeNull();
  });
});

describe("the footer region the row sits above", () => {
  /** A plain tree: each node names its parent, its layout and its children. */
  type Layout = "row" | "column" | "grid";
  interface Node { name: string; parent: Node | null; layout: Layout; children: Node[] }
  const node = (name: string, parent: Node | null, layout: Layout = "column"): Node => {
    const made = { name, parent, layout, children: [] as Node[] };
    parent?.children.push(made);
    return made;
  };
  const layout: RegionLayout<Node> = {
    parent: (n) => n.parent,
    horizontal: (n) => n.layout === "row",
    onlyChild: (n, child) => n.children.every((each) => each === child),
    vertical: (n) => n.layout === "column",
  };

  it("is the footer itself when it already sits in a vertical stack (bb 0.45 / 0.46.0)", () => {
    const root = node("sidebar", null);
    const body = node("app-sidebar-body", root);
    node("content", body);
    const footer = node("footer", body);
    expect(footerRegion(footer, root, layout)?.name).toBe("footer");
  });

  it("is the whole horizontal footer row in bb 0.46.1", () => {
    const root = node("sidebar", null);
    node("rail-and-body", root, "row");
    const row = node("sidebar-footer-row", root, "row");
    node("rail-cell", row);
    const body = node("collapsible-body", row);
    const inner = node("collapsible-inner", body, "row");
    const footer = node("footer", inner);
    expect(footerRegion(footer, root, layout)?.name).toBe("sidebar-footer-row");
  });

  it("is null when the climb stops at bb 0.47.1's grid, which would adopt the row as a grid item", () => {
    const root = node("sidebar", null);
    const grid = node("grid", root, "grid");
    node("nav-rail", grid);
    node("nav-rail-sidebar-body", grid);
    node("settings-cell", grid, "row");
    const cell = node("sidebar-footer-body", grid);
    const inner = node("collapsible-inner", cell, "row");
    const footer = node("footer", inner);
    expect(footerRegion(footer, root, layout)).toBeNull();
  });

  it("never climbs past the sidebar root, and gives no line in a root that is not a vertical stack", () => {
    const shell = node("app-shell", null);
    const root = node("sidebar", shell, "row");
    const footer = node("footer", root);
    expect(footerRegion(footer, root, layout)).toBeNull();
  });
});
