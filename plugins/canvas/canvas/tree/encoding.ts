// W0 — the tree ENCODING CONTRACT. One module, so every later node (W1's
// reader, W2's arrow renderer, W4's gestures, W5's server queries, W10's
// agent writes) codes against exactly one description of what a tree IS in
// the canvas document. Nothing here reads a doc, renders anything, or talks
// to bb: it is pure schema + builders + readers over canvas-model values.
//
// THE CONTRACT (fixed by the plan's decisions D1/D3, 2026-09-09):
//
//   A TREE is a canvas page carrying the `tree` mark. `treeId` IS the page id.
//   A NODE is an ordinary `note` shape whose `meta` carries the tree fields.
//   An EDGE is an ordinary `arrow` shape whose `meta.tree` is set, plus the
//     two `Binding` rows canvas-model/src/arrow-route.ts already routes.
//
// EDGE DIRECTION IS FIXED HERE AND NOWHERE ELSE. An edge means
// "<blocker> BLOCKS <blocked>": the arrow's START terminal binds the BLOCKER
// and its END terminal binds the BLOCKED, so the drawn arrowhead points AT
// the thing that is blocked — a discovery tree reads as work flowing up into
// the goal it unblocks. Inverting this is the single most common mistake with
// this model, which is why BLOCKER_TERMINAL/BLOCKED_TERMINAL are named
// constants rather than string literals sprinkled through five call sites.
//
// NOTHING RENDERS AN EDGE YET, deliberately (W2 owns that): `arrow` is not in
// canvas-react's registerCoreShapes list, so an edge written by this module
// shows up as the BoxShape fallback until W2 lands. That is a visible,
// honest gap, not a silent one.
//
// WHY meta AND NOT A NEW SHAPE KIND: canvas-model's SHAPE_KINDS is a closed
// zod union shared with client/, but every shape's `meta` is
// `z.record(z.string(), z.unknown())` and per-kind props are looseObject. So
// the whole encoding rides through the existing document schema with no
// canvas-model change at all (explore.md, part 2).
import { z } from "zod";
import type { Binding, Page, Shape } from "@ensembleworks/canvas-model";

/** Bumped when the encoding changes shape in a way a reader must notice.
 * Written into the PAGE mark (one place per tree) rather than onto every
 * node, so a migration reads one value, not N. */
export const TREE_ENCODING_VERSION = 1;

/**
 * The three-way answer every reader in this module returns.
 *
 * `absent` and `invalid` are SEPARATE on purpose. "This shape is not part of
 * a tree" and "this shape claims to be a tree node and is malformed" are
 * different situations, and collapsing the second into the first is how a
 * human's node silently disappears from the agent's view of the tree while
 * still sitting on their screen. W1's invariant pass and W11's repair both
 * need to see the difference; a boolean predicate cannot express it.
 */
export type TreeRead<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "absent" }
  | { readonly status: "invalid"; readonly error: string };

const ok = <T>(value: T): TreeRead<T> => ({ status: "ok", value });
const absent = <T>(): TreeRead<T> => ({ status: "absent" });
const invalid = <T>(error: string): TreeRead<T> => ({ status: "invalid", error });

// ---------------------------------------------------------------------------
// The tree: a page
// ---------------------------------------------------------------------------

/**
 * The one key name the whole encoding hangs off: `page.tree` marks a page as
 * a tree, `shape.meta.tree` names the tree a node or edge belongs to.
 *
 * Deliberately ONE constant for both. canvas-model's `pageSchema` is a
 * `looseObject` and every shape's `meta` is an open record, so this rides
 * through putPage/putShape/listPages untouched with no model change — and
 * "is this thing part of a tree?" is then the same question at both places.
 */
export const TREE_KEY = "tree";

/** The value under `page.tree`. Strict: an unrecognised key here is a
 * malformed mark, not a mark plus decoration — the whole point of the version
 * field is to be the ONLY way this value grows. */
export const treePageMarkSchema = z
  .object({ v: z.literal(TREE_ENCODING_VERSION) })
  .strict();
export type TreePageMark = z.infer<typeof treePageMarkSchema>;

/** Return a copy of `page` marked as a tree. Idempotent. */
export function markTreePage(page: Page): Page {
  return { ...page, [TREE_KEY]: { v: TREE_ENCODING_VERSION } };
}

/** Read a page's tree mark, answering with the treeId (the page id) on `ok`. */
export function readTreePage(page: Page): TreeRead<{ treeId: string; mark: TreePageMark }> {
  const raw = (page as Record<string, unknown>)[TREE_KEY];
  if (raw === undefined) return absent();
  const parsed = treePageMarkSchema.safeParse(raw);
  if (!parsed.success) return invalid(`page ${page.id}: ${parsed.error.message}`);
  return ok({ treeId: page.id, mark: parsed.data });
}

/** True only for a page carrying a VALID mark — a malformed mark is not a
 * tree, and `readTreePage` is how a caller finds out why. */
export function isTreePage(page: Page): boolean {
  return readTreePage(page).status === "ok";
}

// ---------------------------------------------------------------------------
// A node: a `note` shape
// ---------------------------------------------------------------------------

/** The shape kind a tree node is. Ordinary, so the select tool drags it, the
 * text editor edits it, and canvas-react already renders it. */
export const TREE_NODE_KIND = "note" as const;

/** A node's lifecycle. `approached` is a separate axis (below), not a fourth
 * state: "we looked at this and nothing came up" is a fact about a `todo`. */
export const NODE_STATES = ["todo", "wip", "done"] as const;
export type NodeState = (typeof NODE_STATES)[number];

/** Ceiling on `meta.context`. Bounded because an agent writes it (W10), it
 * rides every CRDT delta to every connected client, and an unbounded string
 * in a shape's meta is a denial-of-service on a room, not just a big note. */
export const MAX_CONTEXT_LENGTH = 8_000;

/**
 * The tree fields on a node's `meta`.
 *
 * LOOSE, not strict: `meta` is shared with every other feature that stamps a
 * shape (and with whatever the tldraw-era corpus already carries), so
 * rejecting unknown keys here would make the tree fight every other user of
 * the same record. The tree's OWN keys are exactly typed; everything else
 * rides through.
 */
export const treeNodeMetaSchema = z.looseObject({
  /** The page id this node belongs to. Denormalised onto the shape so a
   * reader holding only shapes can filter without resolving the parent
   * chain — a node can sit inside a frame, so `parentId` is not the treeId. */
  tree: z.string().min(1),
  /** The node's own shape id, recorded for legibility. `readTreeNode`
   * REJECTS a shape where this disagrees with `shape.id`: a legibility field
   * that is allowed to lie is worse than no field at all. */
  nodeId: z.string().min(1),
  state: z.enum(NODE_STATES),
  approached: z.boolean(),
  /** Goal / definition of done / knowns / unknowns, as markdown. */
  context: z.string().max(MAX_CONTEXT_LENGTH),
});
export type TreeNodeMeta = z.infer<typeof treeNodeMetaSchema>;

/** Build a node's meta with the defaults a freshly-created node gets. */
export function buildTreeNodeMeta(input: {
  treeId: string;
  nodeId: string;
  state?: NodeState;
  approached?: boolean;
  context?: string;
}): TreeNodeMeta {
  return {
    tree: input.treeId,
    nodeId: input.nodeId,
    state: input.state ?? "todo",
    approached: input.approached ?? false,
    context: input.context ?? "",
  };
}

/** Read the tree fields off a shape. `absent` for any shape that is not
 * tree-marked (including a marked shape of the wrong KIND — a tree node is a
 * note, full stop); `invalid` for a tree-marked note whose fields do not
 * hold. */
export function readTreeNode(shape: Shape): TreeRead<TreeNodeMeta> {
  if (shape.meta[TREE_KEY] === undefined) return absent();
  if (shape.kind !== TREE_NODE_KIND) return absent();
  const parsed = treeNodeMetaSchema.safeParse(shape.meta);
  if (!parsed.success) return invalid(`node ${shape.id}: ${parsed.error.message}`);
  if (parsed.data.nodeId !== shape.id) {
    return invalid(`node ${shape.id}: meta.nodeId is ${parsed.data.nodeId}`);
  }
  return ok(parsed.data);
}

/**
 * Build a whole node shape. Returns a value that passes canvas-model's
 * `validateShape` — the same gate `CanvasDoc.putShape` applies — so a caller
 * cannot half-build a node that the doc then silently refuses.
 *
 * `index` (the fractional z-order string) and the position are the CALLER's:
 * W3 owns layout, and this module must not quietly decide where a node goes.
 */
export function buildTreeNode(input: {
  id: string;
  treeId: string;
  parentId: string;
  index: string;
  x: number;
  y: number;
  state?: NodeState;
  approached?: boolean;
  context?: string;
}): Shape {
  return {
    id: input.id,
    kind: TREE_NODE_KIND,
    parentId: input.parentId,
    index: input.index,
    x: input.x,
    y: input.y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: buildTreeNodeMeta({
      treeId: input.treeId,
      nodeId: input.id,
      state: input.state,
      approached: input.approached,
      context: input.context,
    }),
    props: {},
  } as Shape;
}

// ---------------------------------------------------------------------------
// An edge: an `arrow` shape + two bindings
// ---------------------------------------------------------------------------

/** The shape kind an edge is. Unregistered in canvas-react today — see the
 * module header's note on the visible W2 gap. */
export const TREE_EDGE_KIND = "arrow" as const;

/** Terminal names, exactly as canvas-model's arrow-route reads them. */
export const BLOCKER_TERMINAL = "start" as const;
export const BLOCKED_TERMINAL = "end" as const;

/** Anchor at the target's centre. arrow-route clips the drawn segment to the
 * target's rotated boundary anyway, so the centre is the anchor that keeps
 * looking right as a human drags either end around. */
export const TREE_EDGE_ANCHOR = { nx: 0.5, ny: 0.5 } as const;

/** The tree fields on an edge's `meta`. Loose, for the same reason node meta
 * is. An edge carries no state of its own in v0: it is a fact about two
 * nodes, and everything else is derived. */
export const treeEdgeMetaSchema = z.looseObject({ tree: z.string().min(1) });
export type TreeEdgeMeta = z.infer<typeof treeEdgeMetaSchema>;

/** `binding:<arrowId>-start` / `binding:<arrowId>-end` — the convention
 * canvas-editor's StartArrow/CompleteArrow already write and arrow-route
 * already reads. Restated as a function so no later node has to re-derive
 * the string. */
export function edgeBindingId(
  edgeId: string,
  terminal: typeof BLOCKER_TERMINAL | typeof BLOCKED_TERMINAL,
): string {
  return `binding:${edgeId}-${terminal}`;
}

/** One edge, resolved. */
export interface TreeEdge {
  readonly treeId: string;
  readonly edgeId: string;
  /** The node that must be done first. */
  readonly blockerId: string;
  /** The node it unblocks. */
  readonly blockedId: string;
}

/**
 * Read an edge off an arrow shape plus the doc's bindings.
 *
 * `bindings` may be the whole doc-wide list — this filters by `fromId`
 * itself, exactly as `routeArrow` does.
 *
 * An arrow marked with a tree but missing either terminal binding is
 * `invalid`, NOT `absent`: a half-bound edge is precisely the state W11's
 * repair exists to find, and an `absent` answer would hide it.
 */
export function readTreeEdge(
  shape: Shape,
  bindings: readonly Binding[],
): TreeRead<TreeEdge> {
  if (shape.meta[TREE_KEY] === undefined) return absent();
  if (shape.kind !== TREE_EDGE_KIND) return absent();
  const parsed = treeEdgeMetaSchema.safeParse(shape.meta);
  if (!parsed.success) return invalid(`edge ${shape.id}: ${parsed.error.message}`);
  const terminalOf = (terminal: string): Binding | undefined =>
    bindings.find(
      (binding) =>
        binding.fromId === shape.id &&
        (binding.props as { terminal?: unknown }).terminal === terminal,
    );
  const blocker = terminalOf(BLOCKER_TERMINAL);
  const blocked = terminalOf(BLOCKED_TERMINAL);
  if (!blocker) return invalid(`edge ${shape.id}: no ${BLOCKER_TERMINAL} binding`);
  if (!blocked) return invalid(`edge ${shape.id}: no ${BLOCKED_TERMINAL} binding`);
  if (blocker.toId === blocked.toId) {
    return invalid(`edge ${shape.id}: both terminals bind ${blocker.toId}`);
  }
  return ok({
    treeId: parsed.data.tree,
    edgeId: shape.id,
    blockerId: blocker.toId,
    blockedId: blocked.toId,
  });
}

/**
 * Build a whole edge: the arrow shape and its two bindings, in the order a
 * writer should put them (shape first — a binding whose `fromId` names a
 * shape the doc has never seen is a dangling row `repair()` would sweep).
 *
 * The arrow's own x/y and `props.end` are the UNBOUND fallback positions
 * arrow-route uses only if a binding's target vanishes (see arrow-route's
 * VANISHED-TARGET FALLBACK). They are seeded from the caller's two node
 * positions so that fallback lands somewhere sane rather than at the world
 * origin.
 */
export function buildTreeEdge(input: {
  id: string;
  treeId: string;
  parentId: string;
  index: string;
  blockerId: string;
  blockedId: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
}): { shape: Shape; bindings: readonly [Binding, Binding] } {
  const shape = {
    id: input.id,
    kind: TREE_EDGE_KIND,
    parentId: input.parentId,
    index: input.index,
    x: input.from.x,
    y: input.from.y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: { tree: input.treeId } satisfies TreeEdgeMeta,
    props: { end: { x: input.to.x - input.from.x, y: input.to.y - input.from.y } },
  } as Shape;
  const bind = (
    terminal: typeof BLOCKER_TERMINAL | typeof BLOCKED_TERMINAL,
    toId: string,
  ): Binding =>
    ({
      id: edgeBindingId(input.id, terminal),
      fromId: input.id,
      toId,
      props: { terminal, anchor: TREE_EDGE_ANCHOR },
      meta: {},
    }) as Binding;
  return {
    shape,
    bindings: [
      bind(BLOCKER_TERMINAL, input.blockerId),
      bind(BLOCKED_TERMINAL, input.blockedId),
    ],
  };
}
