// W9 — A NODE, NAMED IN A REPLY. The return leg of D2.
//
// W8 carries a node from the canvas into the conversation. This carries one
// back: an agent writes `::node{id="shape:…"}` in a message, bb hands the
// directive to the plugin, and the plugin draws a card that a human can click
// to land on that node — selected and centred — on the canvas.
//
// THIS MODULE IS THE DECISION, NOT THE CARD. The component
// (NodeDirectiveCard.tsx) is a transcription of the `NodeCard` union and
// nothing else, because this project has no jsdom: a rule written inline in a
// .tsx is a rule no test can reach (the same split canvas/agent-arms.ts and
// canvas/pages/page-menu.ts already make).
//
// THREE DECISIONS, and the first two are the same argument twice.
//
// 1. THE ID IS THE ONLY ATTRIBUTE, AND IT IS A LOOKUP KEY. A shape id is
//    unique across the whole document, so the id alone identifies the node —
//    and the page it lives on is then read from the document rather than
//    quoted in the message. Carrying `page=` too would be a second copy of a
//    fact that MOVES (a node can be dragged to another page, and the page can
//    be deleted), stored in a message that is kept forever: the copy would win
//    arguments it should lose, and the click would land on the wrong page or
//    on none. One key, one live read.
//
// 2. EVERY FACT ON THE CARD IS READ LIVE. Same reason. A title and a state
//    baked into the directive are a snapshot of the moment the model typed
//    them; the card would then show "todo" on work that finished yesterday and
//    look authoritative doing it. The card asks `canvas_tree_node` (W5's
//    service, over the room's own document) every time it renders, and any
//    `title=`/`state=` a model volunteers is IGNORED rather than used as a
//    fallback — a fallback is exactly the lie, arriving only when the truth is
//    unavailable.
//
// 3. A REFERENCE THAT CANNOT BE FOLLOWED SAYS SO. Deleted node, invented id,
//    malformed directive, canvas unreachable: all four render a visible dead
//    card, none of them crashes and none renders blank. Only a LIVE card
//    carries a `target`, so there is no state in which a click is offered for
//    somewhere nothing can go.
import type { NodeState } from "./encoding.js";
import { titleOf } from "./answers.js";

/** The directive name bb renders — `::node{…}` in a message. Lowercase
 * kebab-case beginning with a letter, per PluginMessageDirectiveRegistration. */
export const NODE_DIRECTIVE_ID = "node";

/** The ONE spelling of the directive. Everything below is derived from it. */
const directiveText = (id: string): string => `::${NODE_DIRECTIVE_ID}{id="${id}"}`;

/**
 * The syntax, exactly as an agent must type it.
 *
 * Lives here rather than in the brief because THREE surfaces spell it: the
 * instructions that teach it (canvas/tree/instructions.ts), the registration
 * that renders it (app.tsx), and W8's affordance that WRITES it into a human's
 * composer (`nodeDirective` below). One constant, so a rename cannot teach a
 * syntax the host no longer answers — or emit one it no longer renders.
 */
export const NODE_DIRECTIVE_SYNTAX = directiveText("<node id>");

/**
 * W8's emit side: the directive text for one node, or null when the id cannot
 * be written as one.
 *
 * THE PARSE SIDE IS ONE FILE AWAY ON PURPOSE. `nodeIdFromAttributes` reads
 * what the host handed back; this writes what the host will read. They are the
 * two ends of D2's round trip, and a disagreement between them is invisible in
 * the worst way — the human sends a message containing a line of raw markup
 * and no card appears. Keeping them adjacent is what lets the suite test them
 * against each other rather than against two hand-typed fixtures.
 *
 * REFUSING IS THE POINT. The parse side accepts any string, because by then
 * the host has already decided where the attribute ended. Here, a quote or a
 * newline or a brace inside the id would produce a directive that parses as
 * something ELSE — a different node, or nothing at all — so an id that cannot
 * survive the trip is refused rather than written and hoped for. Real shape
 * ids (`shape:<nanoid>`) never contain any of these; this is the guard for the
 * day something else mints one.
 */
export function nodeDirective(nodeId: string): string | null {
  const id = nodeIdFromAttributes({ id: nodeId });
  if (id === null) return null;
  if (/["{}\n\r]/.test(id)) return null;
  return directiveText(id);
}

/**
 * The longest id the card will send.
 *
 * Matches the rpc contract's own cap on the lookup key. Refusing here rather
 * than at the wire means an absurd id renders as a dead REFERENCE — which is
 * what it is — instead of a schema rejection that reads like a broken canvas.
 */
export const MAX_NODE_ID_LENGTH = 200;

/** The most of a malformed directive's source a dead card will echo back. */
const MAX_SOURCE_LABEL = 80;

/**
 * The most of a node's title the card carries.
 *
 * A node's title is `plainText(shape)` — the whole note, newlines and all, as
 * long as somebody typed it. That is right for a tool answer and wrong for a
 * chip in a chat message, and it is wrong on the WIRE too: the card renders on
 * every message repaint, and an unbounded field would put a whole note through
 * the rpc each time. Cut to a line and a bound, at the server, once.
 */
export const MAX_CARD_TITLE = 120;

/**
 * A node's title as a card label: its FIRST line, bounded.
 *
 * Exported for the rpc handler, which is where it runs — the wire carries the
 * short form, so there is no second opinion about the label between the
 * server's copy and the browser's.
 */
export function cardTitle(raw: string): string {
  const line = (raw.split("\n")[0] ?? "").trim();
  return line.length <= MAX_CARD_TITLE ? line : `${line.slice(0, MAX_CARD_TITLE - 1)}\u2026`;
}

/** What `canvas_tree_node` answers with: the handful of facts a one-line card
 * shows, and nothing else. A context note has no business in the middle of a
 * message the model is already writing prose into. */
export interface NodeCardFacts {
  readonly id: string;
  /** The PAGE the node is on — the canvas's tree id, and where a click goes. */
  readonly treeId: string;
  readonly title: string;
  readonly state: NodeState;
  readonly isReady: boolean;
}

/** What the plugin knows about the reference at render time. */
export type NodeLookup =
  /** The rpc is in flight, or has not been sent yet. */
  | { readonly status: "loading" }
  | { readonly status: "found"; readonly node: NodeCardFacts }
  /** The document does not have this node: deleted, or never existed. */
  | { readonly status: "gone" }
  /** The read itself failed. NOT evidence about the node. */
  | { readonly status: "unreadable"; readonly detail: string };

/** Where a click on a live card goes. */
export interface RevealRequest {
  readonly nodeId: string;
  readonly pageId: string;
}

export type NodeCard =
  | { readonly kind: "pending"; readonly label: string }
  | {
      readonly kind: "live";
      readonly label: string;
      readonly state: NodeState;
      readonly ready: boolean;
      readonly target: RevealRequest;
    }
  | { readonly kind: "dead"; readonly label: string; readonly reason: string };

/**
 * The id a directive is asking about, or null when it is not asking about
 * anything usable.
 *
 * UNTRUSTED INPUT, in the same terms as `pageIdFromSubPath`: a model wrote it,
 * and it is only ever COMPARED against live shape ids by the plugin server. It
 * is never concatenated into a URL or a path, so there is no character filter
 * here — only a length bound, because this string does go on a wire.
 */
export function nodeIdFromAttributes(
  attributes: Readonly<Record<string, string>>,
): string | null {
  const raw = attributes.id;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NODE_ID_LENGTH) return null;
  return trimmed;
}

/** Said for a node the document does not have. ONE sentence for "deleted" and
 * "never existed" alike: from here they are the same fact, and two sentences
 * would be a claim about WHY that this surface cannot support. */
const GONE = "not on the canvas any more";

/** Said when the READ failed. Deliberately not the sentence above: an rpc that
 * did not answer is no evidence that the node is gone, and saying it is would
 * send somebody hunting for a node that is still there. */
const UNREADABLE = "could not read the canvas";

/** Said for a directive with no usable id — the model's own mistake, shown
 * with the text it wrote so it is recognisable in the message. */
const NO_ID = "no node id in this reference";

/** The card, from the directive's attributes and whatever the lookup knows. */
export function nodeCard(input: {
  readonly attributes: Readonly<Record<string, string>>;
  /** The directive's original source text, for a card that has nothing else
   * to be labelled with. */
  readonly source: string;
  readonly lookup: NodeLookup;
}): NodeCard {
  const id = nodeIdFromAttributes(input.attributes);
  if (id === null) {
    return { kind: "dead", label: clip(input.source), reason: NO_ID };
  }
  switch (input.lookup.status) {
    case "loading":
      return { kind: "pending", label: id };
    case "gone":
      return { kind: "dead", label: id, reason: GONE };
    case "unreadable":
      return { kind: "dead", label: id, reason: UNREADABLE };
    case "found": {
      const node = input.lookup.node;
      return {
        kind: "live",
        // `titleOf`, so an untitled node reads the same word here as it does
        // in every answer W6 gives a model — and never renders as an empty
        // card.
        label: titleOf(node),
        state: node.state,
        ready: node.isReady,
        // The PAGE COMES FROM THE LOOKUP, never from the message: decision 1
        // in this file's header.
        target: { nodeId: node.id, pageId: node.treeId },
      };
    }
  }
}

function clip(source: string): string {
  const trimmed = source.trim();
  return trimmed.length <= MAX_SOURCE_LABEL
    ? trimmed
    : `${trimmed.slice(0, MAX_SOURCE_LABEL - 1)}…`;
}
