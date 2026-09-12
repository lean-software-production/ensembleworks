// Run: npx vitest run tests/tree-reveal.test.ts
//
// W9's second half: what happens after a `::node` card is clicked.
//
// The click happens in a THREAD — quite possibly with no canvas mounted at
// all, and almost always with the canvas showing a different page. So the
// journey has four legs, and every one of them can fail silently:
//
//   the request  a click in a message, held somewhere the canvas can find it
//   the route    the panel put on the node's page — through the URL, which is
//                the ONE way this plugin changes page (canvas/pages/
//                page-route.ts), never a second SetCurrentPage authority
//   the arrival  the shape actually present in the local document, which lags
//                the route by however long the room's delta takes
//   the show     selected AND centred, at the zoom the human already chose
//
// A reveal that cannot complete must SAY SO and stop, rather than sitting
// armed and firing at some later navigation the human made for another reason.
import { describe, expect, it } from "vitest";
import {
  REVEAL_TIMEOUT_MS,
  createRevealBus,
  decideReveal,
  openNodeOnCanvas,
  revealSubjectFor,
  runReveal,
} from "../canvas/tree/reveal.js";
import { docOf, TREE } from "./lib/tree-fixture.js";

const target = { nodeId: "shape:api", pageId: "page:tree", requestedAt: 1_000 };
const onPage = { pageId: "page:tree", centre: { x: 100, y: 50 } };
const base = {
  target,
  subject: null,
  currentPageId: "page:other",
  livePageIds: ["page:other", "page:tree"],
  routedTo: null,
  now: 1_000,
};

describe("decideReveal", () => {
  it("routes to the node's page when the canvas is elsewhere", () => {
    expect(decideReveal(base)).toEqual({ kind: "route", pageId: "page:tree" });
  });

  it("does not re-route a page it has already asked for", () => {
    // The router's own header says a repeated navigation is noise, not
    // divergence — but noise on every doc change, for as long as the reveal is
    // pending, is a lot of noise. One ask, then wait for it to land.
    expect(decideReveal({ ...base, routedTo: "page:tree" })).toEqual({ kind: "wait" });
  });

  it("waits rather than routing to a page the document does not have yet", () => {
    // A freshly-mounted panel has its own default page and nothing else until
    // the room's first delta lands. Routing at a page that is not live makes
    // the page router bounce the URL straight back (its rule 3), which throws
    // the destination away.
    expect(decideReveal({ ...base, livePageIds: ["page:other"] })).toEqual({ kind: "wait" });
  });

  it("waits, on the right page, until the shape itself has arrived", () => {
    expect(decideReveal({ ...base, currentPageId: "page:tree" })).toEqual({ kind: "wait" });
  });

  it("shows once the canvas is on the page and the shape is there", () => {
    expect(
      decideReveal({ ...base, currentPageId: "page:tree", subject: onPage }),
    ).toEqual({ kind: "show", nodeId: "shape:api", centre: onPage.centre });
  });

  it("follows the shape when it has been dragged to another page since the card was drawn", () => {
    // The card's page came from an rpc read; the document is the newer fact.
    expect(
      decideReveal({
        ...base,
        subject: { pageId: "page:elsewhere", centre: { x: 1, y: 2 } },
        livePageIds: ["page:other", "page:tree", "page:elsewhere"],
      }),
    ).toEqual({ kind: "route", pageId: "page:elsewhere" });
  });

  it("shows a reveal that resolves exactly on the deadline", () => {
    expect(
      decideReveal({
        ...base,
        currentPageId: "page:tree",
        subject: onPage,
        now: target.requestedAt + REVEAL_TIMEOUT_MS,
      }),
    ).toEqual({ kind: "show", nodeId: "shape:api", centre: onPage.centre });
  });

  it("gives up, out loud, when the node never arrives", () => {
    const decision = decideReveal({
      ...base,
      currentPageId: "page:tree",
      now: target.requestedAt + REVEAL_TIMEOUT_MS + 1,
    });
    if (decision.kind !== "give-up") throw new Error(`expected give-up, got ${decision.kind}`);
    expect(decision.message).toMatch(/shape:api/);
  });

  it("gives up differently when the whole page has gone", () => {
    const decision = decideReveal({
      ...base,
      livePageIds: ["page:other"],
      now: target.requestedAt + REVEAL_TIMEOUT_MS + 1,
    });
    if (decision.kind !== "give-up") throw new Error(`expected give-up, got ${decision.kind}`);
    expect(decision.message).toMatch(/page/i);
  });
});

function ports() {
  const applied: unknown[] = [];
  const routed: unknown[] = [];
  const said: string[] = [];
  let cleared = 0;
  return {
    applied,
    routed,
    said,
    cleared: () => cleared,
    ports: {
      apply: (intents: readonly unknown[]) => applied.push(...intents),
      navigate: {
        toPluginPanel: (path: string, options?: { subPath?: string; replace?: boolean }) =>
          routed.push({ path, options }),
      },
      notify: (message: string) => said.push(message),
      clear: () => {
        cleared += 1;
      },
    },
  };
}

const viewport = { width: 800, height: 600 };

describe("runReveal", () => {
  it("routes through the canvas panel's own path, and records what it asked for", () => {
    const p = ports();
    const routedTo = runReveal({ ...base, viewport, zoom: 1 }, p.ports);
    expect(p.routed).toEqual([
      { path: "canvas", options: { subPath: "page:tree" } },
    ]);
    expect(routedTo).toBe("page:tree");
    expect(p.cleared()).toBe(0);
  });

  it("selects AND centres, keeping the human's zoom", () => {
    const p = ports();
    runReveal(
      { ...base, currentPageId: "page:tree", subject: onPage, viewport, zoom: 2 },
      p.ports,
    );
    expect(p.applied).toEqual([
      { type: "SetSelection", ids: ["shape:api"] },
      // screen = (world + camera.xy) * z, solved for the centre of an 800x600
      // viewport at z=2: 800/2/2 - 100 = 100, 600/2/2 - 50 = 100.
      { type: "SetCamera", x: 100, y: 100, z: 2 },
    ]);
    expect(p.cleared()).toBe(1);
  });

  it("says why it gave up, and disarms", () => {
    const p = ports();
    runReveal(
      {
        ...base,
        currentPageId: "page:tree",
        now: target.requestedAt + REVEAL_TIMEOUT_MS + 1,
        viewport,
        zoom: 1,
      },
      p.ports,
    );
    expect(p.said).toHaveLength(1);
    expect(p.applied).toEqual([]);
    expect(p.cleared()).toBe(1);
  });

  it("touches nothing while it waits", () => {
    const p = ports();
    const routedTo = runReveal(
      { ...base, routedTo: "page:tree", viewport, zoom: 1 },
      p.ports,
    );
    expect(routedTo).toBe("page:tree");
    expect(p.applied).toEqual([]);
    expect(p.routed).toEqual([]);
    expect(p.said).toEqual([]);
    expect(p.cleared()).toBe(0);
  });
});

describe("the reveal bus", () => {
  it("hands the panel the target a message asked for", () => {
    const bus = createRevealBus(() => 5_000);
    expect(bus.snapshot()).toBeNull();
    bus.request({ nodeId: "shape:api", pageId: "page:tree" });
    expect(bus.snapshot()).toEqual({
      nodeId: "shape:api",
      pageId: "page:tree",
      requestedAt: 5_000,
    });
  });

  it("notifies subscribers, and stops when they leave", () => {
    const bus = createRevealBus(() => 1);
    let ticks = 0;
    const off = bus.subscribe(() => {
      ticks += 1;
    });
    bus.request({ nodeId: "a", pageId: "p" });
    expect(ticks).toBe(1);
    off();
    bus.request({ nodeId: "b", pageId: "p" });
    expect(ticks).toBe(1);
  });

  it("makes a second click on the SAME card a new request", () => {
    // Otherwise the second click hands the panel an identical object, React
    // sees no change, and a card that worked once looks broken ever after.
    let clock = 10;
    const bus = createRevealBus(() => (clock += 5));
    bus.request({ nodeId: "shape:api", pageId: "page:tree" });
    const first = bus.snapshot();
    bus.request({ nodeId: "shape:api", pageId: "page:tree" });
    expect(bus.snapshot()).not.toBe(first);
    expect(bus.snapshot()?.requestedAt).toBe(20);
  });

  it("clears, so a completed reveal cannot fire twice", () => {
    const bus = createRevealBus(() => 1);
    bus.request({ nodeId: "a", pageId: "p" });
    bus.clear();
    expect(bus.snapshot()).toBeNull();
  });
});

describe("revealSubjectFor", () => {
  const doc = docOf({ nodes: { "shape:a": "todo", "shape:b": "todo" }, edges: [] });

  it("reads the page and the CENTRE of the node's box", () => {
    // The fixture places node i at x = i * 200, y = 0, and a tree node is a
    // 200x200 note — so the centre of the second one is (300, 100), not its
    // corner at (200, 0). A corner in the middle of the viewport does not read
    // as "centred on that node".
    expect(revealSubjectFor(doc, "shape:b")).toEqual({
      pageId: TREE,
      centre: { x: 300, y: 100 },
    });
  });

  it("is null for a shape this browser has not received yet", () => {
    expect(revealSubjectFor(doc, "shape:not-here")).toBeNull();
  });
});

describe("openNodeOnCanvas", () => {
  it("leaves the request BEFORE it asks bb for the canvas", () => {
    const order: string[] = [];
    const bus = createRevealBus(() => 1);
    bus.subscribe(() => order.push("requested"));
    openNodeOnCanvas(
      { nodeId: "shape:api", pageId: "page:tree" },
      {
        bus,
        navigate: {
          toPluginPanel: (path, options) =>
            order.push(`navigated:${path}:${options?.subPath}`),
        },
      },
    );
    expect(order).toEqual(["requested", "navigated:canvas:page:tree"]);
    expect(bus.snapshot()?.nodeId).toBe("shape:api");
  });
});
