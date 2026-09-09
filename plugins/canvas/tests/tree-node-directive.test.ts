// Run: npx vitest run tests/tree-node-directive.test.ts
//
// W9's first half: what a `::node{id="…"}` reference in an agent's reply says
// before anybody clicks it.
//
// The card is the RETURN leg of D2 — W8 carries a node from the canvas into
// the conversation, this carries one back — and the ways a reference goes
// wrong are all ways of LYING about a tree that has moved on:
//
//  1. THE ATTRIBUTE IS MODEL-EMITTED AND UNTRUSTED. It is a lookup key against
//     the live document and nothing else; a missing, blank or absurd one must
//     be a visible dead reference, never a crash and never a blank.
//  2. THE FACTS ARE LIVE, NOT QUOTED. Title and state come from the document
//     at render time. A card that repeated what the model typed would still be
//     showing "todo" on a node finished an hour ago.
//  3. A DELETED NODE IS SAID OUT LOUD. "Not on the canvas any more" is an
//     answer; a card that still looks clickable is not.
//  4. ONLY A LIVE CARD IS A DESTINATION. The click target is derived from the
//     looked-up node, so there is no path where a click is offered for a node
//     nothing can navigate to.
import { describe, expect, it } from "vitest";
import {
  MAX_CARD_TITLE,
  MAX_NODE_ID_LENGTH,
  NODE_DIRECTIVE_ID,
  NODE_DIRECTIVE_SYNTAX,
  cardTitle,
  nodeCard,
  nodeDirective,
  nodeIdFromAttributes,
} from "../canvas/tree/node-reference.js";

const facts = {
  id: "shape:api",
  treeId: "page:tree",
  title: "Tree service",
  state: "wip" as const,
  isReady: false,
};

describe("nodeIdFromAttributes", () => {
  it("takes the id attribute, trimmed", () => {
    expect(nodeIdFromAttributes({ id: "  shape:api  " })).toBe("shape:api");
  });

  it("is null when there is no id at all", () => {
    expect(nodeIdFromAttributes({})).toBeNull();
    expect(nodeIdFromAttributes({ title: "Tree service" })).toBeNull();
  });

  it("is null when the id is blank", () => {
    expect(nodeIdFromAttributes({ id: "   " })).toBeNull();
  });

  it("refuses an id longer than the wire will carry", () => {
    // The rpc contract caps the lookup key; a card that sent a longer one
    // would get a schema rejection back and render as unreadable, which reads
    // like a broken canvas rather than a broken reference.
    expect(nodeIdFromAttributes({ id: "s".repeat(MAX_NODE_ID_LENGTH) })).toHaveLength(
      MAX_NODE_ID_LENGTH,
    );
    expect(nodeIdFromAttributes({ id: "s".repeat(MAX_NODE_ID_LENGTH + 1) })).toBeNull();
  });

  it("cuts a note down to a card label", () => {
    // A node's title is the whole note. The card is one line in a chat
    // message, and the wire should not carry the rest of it on every repaint.
    expect(cardTitle("Tree service\nand the whole definition of done")).toBe("Tree service");
    expect(cardTitle("  padded  ")).toBe("padded");
    expect(cardTitle("x".repeat(MAX_CARD_TITLE + 40))).toHaveLength(MAX_CARD_TITLE);
    expect(cardTitle("x".repeat(MAX_CARD_TITLE + 40)).endsWith("\u2026")).toBe(true);
  });

  it("names the directive the host renders", () => {
    // Lowercase kebab-case beginning with a letter, per
    // PluginMessageDirectiveRegistration.
    expect(NODE_DIRECTIVE_ID).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});

describe("nodeCard", () => {
  it("is pending while the lookup is in flight, and says nothing about state", () => {
    const card = nodeCard({
      attributes: { id: "shape:api" },
      source: '::node{id="shape:api"}',
      lookup: { status: "loading" },
    });
    expect(card.kind).toBe("pending");
    expect(card.label).toBe("shape:api");
  });

  it("shows the LIVE title and state, not anything the model typed", () => {
    const card = nodeCard({
      attributes: { id: "shape:api", title: "Something else entirely", state: "done" },
      source: '::node{id="shape:api" title="Something else entirely" state="done"}',
      lookup: { status: "found", node: facts },
    });
    if (card.kind !== "live") throw new Error(`expected a live card, got ${card.kind}`);
    expect(card.label).toBe("Tree service");
    expect(card.state).toBe("wip");
    expect(card.ready).toBe(false);
    expect(card.target).toEqual({ nodeId: "shape:api", pageId: "page:tree" });
  });

  it("labels an untitled node rather than rendering an empty card", () => {
    const card = nodeCard({
      attributes: { id: "shape:api" },
      source: '::node{id="shape:api"}',
      lookup: { status: "found", node: { ...facts, title: "   " } },
    });
    if (card.kind !== "live") throw new Error(`expected a live card, got ${card.kind}`);
    expect(card.label).toBe("(untitled)");
  });

  it("is a dead reference when the node has been deleted", () => {
    const card = nodeCard({
      attributes: { id: "shape:gone" },
      source: '::node{id="shape:gone"}',
      lookup: { status: "gone" },
    });
    if (card.kind !== "dead") throw new Error(`expected a dead card, got ${card.kind}`);
    expect(card.label).toBe("shape:gone");
    expect(card.reason).toMatch(/not on the canvas/i);
  });

  it("is a dead reference when the id never existed, with the same words", () => {
    // A model hallucinating an id and a human deleting a node are the same
    // fact from here: the document does not have it. Two different sentences
    // would be a claim about WHY that this surface cannot support.
    const invented = nodeCard({
      attributes: { id: "shape:never-was" },
      source: '::node{id="shape:never-was"}',
      lookup: { status: "gone" },
    });
    const deleted = nodeCard({
      attributes: { id: "shape:gone" },
      source: '::node{id="shape:gone"}',
      lookup: { status: "gone" },
    });
    if (invented.kind !== "dead" || deleted.kind !== "dead") {
      throw new Error("expected two dead cards");
    }
    expect(invented.reason).toBe(deleted.reason);
  });

  it("is a dead reference when the directive carries no id, labelled with its own source", () => {
    const card = nodeCard({
      attributes: {},
      source: "::node{}",
      lookup: { status: "loading" },
    });
    if (card.kind !== "dead") throw new Error(`expected a dead card, got ${card.kind}`);
    expect(card.label).toBe("::node{}");
    expect(card.reason).toMatch(/no node id/i);
  });

  it("says the canvas could not be read rather than claiming the node is gone", () => {
    // An rpc that failed is not evidence of a deleted node, and saying so
    // would send somebody looking for a node that is still there.
    const card = nodeCard({
      attributes: { id: "shape:api" },
      source: '::node{id="shape:api"}',
      lookup: { status: "unreadable", detail: "network" },
    });
    if (card.kind !== "dead") throw new Error(`expected a dead card, got ${card.kind}`);
    expect(card.reason).toMatch(/could not read the canvas/i);
    expect(card.reason).not.toMatch(/deleted|gone|not on the canvas/i);
  });

  it("gives a click target ONLY to a live card", () => {
    const cards = [
      nodeCard({ attributes: { id: "x" }, source: "", lookup: { status: "loading" } }),
      nodeCard({ attributes: { id: "x" }, source: "", lookup: { status: "gone" } }),
      nodeCard({
        attributes: { id: "x" },
        source: "",
        lookup: { status: "unreadable", detail: "boom" },
      }),
    ];
    for (const card of cards) {
      expect("target" in card).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// W8's emit side, tested against W9's parse side — the ROUND TRIP.
//
// These two halves are the whole of D2: W8 writes `::node{…}` into a human's
// composer, bb parses it and hands the attributes to W9's card. If they ever
// disagree the trip breaks in the least visible way possible — the human sends
// a message containing a line of raw markup and nobody sees a card. So the
// emitter is checked against `nodeIdFromAttributes` itself rather than against
// a second hand-typed fixture of the same string.

/** A deliberately strict stand-in for the host's directive parser: it accepts
 * only the exact form `nodeDirective` claims to produce. If the emitter drifts
 * into anything looser, this stops matching and the round trip fails here
 * rather than in a room. */
const attributesOfDirective = (text: string): Readonly<Record<string, string>> | null => {
  const match = /^::([a-z][a-z0-9-]*)\{id="([^"\n]*)"\}$/.exec(text);
  if (match === null) return null;
  if (match[1] !== NODE_DIRECTIVE_ID) return null;
  return { id: match[2] as string };
};

describe("nodeDirective", () => {
  it("emits a directive whose id survives the trip back through the parse side", () => {
    const emitted = nodeDirective("shape:api");
    expect(emitted).not.toBeNull();
    const attributes = attributesOfDirective(emitted as string);
    expect(attributes).not.toBeNull();
    expect(nodeIdFromAttributes(attributes as Record<string, string>)).toBe("shape:api");
  });

  it("refuses exactly the ids the parse side would refuse", () => {
    for (const id of ["", "   ", "s".repeat(MAX_NODE_ID_LENGTH + 1)]) {
      expect(nodeIdFromAttributes({ id })).toBeNull();
      expect(nodeDirective(id)).toBeNull();
    }
  });

  it("refuses an id that would break out of the attribute it is written into", () => {
    // The parse side takes any string; the EMIT side is where a quote or a
    // newline would produce a directive that parses as something else — or as
    // nothing — so it is refused here rather than written and hoped for.
    for (const id of ['shape:a"', "shape:a\nb", "shape:a}", "shape:a{b"]) {
      expect(nodeDirective(id)).toBeNull();
    }
  });

  it("is the same spelling the brief teaches a model", () => {
    // NODE_DIRECTIVE_SYNTAX is what W7's per-turn brief tells an agent to
    // type. One definition, so a rename cannot teach a syntax the emitter no
    // longer writes.
    expect(NODE_DIRECTIVE_SYNTAX).toBe(
      (nodeDirective("shape:api") as string).replace("shape:api", "<node id>"),
    );
  });
});
