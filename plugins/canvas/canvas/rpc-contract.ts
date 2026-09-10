import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { AGENT_STATUSES } from "./wire.js";
import { MAX_PATH_LENGTH } from "./dock/where.js";
import { MAX_QUERY_LIMIT } from "./transcript.js";
import { MAX_NAME_LENGTH } from "./identity.js";
import { MAX_TITLE_LENGTH } from "./tree/write-seam.js";
import { NODE_STATES } from "./tree/encoding.js";
import { MAX_CARD_TITLE, MAX_NODE_ID_LENGTH } from "./tree/node-reference.js";

/** A client address minted by transport.ts's `newClientId()`. */
const clientIdSchema = z.string().trim().min(1).max(128);

/** A cursor label. Bounded because it is broadcast to every client on every
 * membership change and rendered as an SVG label. */
const nameSchema = z.string().trim().min(1).max(MAX_NAME_LENGTH);

/**
 * A bb pathname a client is reporting itself at.
 *
 * Rooted and bounded at the wire, so nothing that could not be a bb route ever
 * reaches the book, let alone another client's `<a href>`. The browser side
 * refuses the same shapes again before it renders one (canvas/dock/where.ts's
 * `jumpHref`) — this is the wire's half, and neither half trusts the other.
 */
const pathSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .refine((value) => value.startsWith("/") && !value.startsWith("//"), {
    message: "path must be a rooted same-origin path",
  })
  .optional();

/** One shape -> thread link, on the wire. Mirrors `CanvasAgentLink`. */
const agentLinkSchema = z
  .object({
    shapeId: z.string().min(1),
    threadId: z.string().min(1),
    status: z.enum(AGENT_STATUSES),
  })
  .strict();

/**
 * What a tree gesture answers with.
 *
 * `problems` is `TreeWriteOutcome.newProblems` rendered as sentences: damage
 * that appeared WHILE the write was in flight, which means another editor
 * landed something at the same time. It is not an error — the write was
 * accepted — so it rides the success answer rather than a rejection, and the
 * panel warns rather than pretending nothing happened. W11 owns the repair.
 */
const treeWriteResultSchema = z
  .object({
    nodeId: z.string().min(1),
    changed: z.array(z.string()),
    problems: z.array(z.string()),
  })
  .strict();

// Schemas run at the wire boundary. Handler input/output are inferred from
// this shared contract; CanvasPanel.tsx imports only its type.
export const rpcContract = defineRpcContract({
  // The client half of the canvas transport. Replies are never returned here:
  // every server -> client frame goes out over bb.realtime on CANVAS_CHANNEL,
  // because a SyncRequest can produce several frames and some server -> client
  // traffic (another peer's update) is not a reply to anything.
  // `name` is the display name the panel got from the identity route (see
  // canvas/identity.ts). Optional, because a join can also happen before that
  // fetch has ever succeeded — such a client simply has no cursor label.
  canvas_join: {
    input: z
      .object({ clientId: clientIdSchema, name: nameSchema.optional() })
      .strict(),
    output: z.object({ room: z.string() }).strict(),
  },
  canvas_frame: {
    input: z
      .object({ clientId: clientIdSchema, data: z.string().max(4_000_000) })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /**
   * Keepalive. A tab that is only being WATCHED sends no frames at all
   * (presence rides pointer movement, updates ride edits), so without this the
   * idle sweep would evict a perfectly healthy viewer after CLIENT_IDLE_MS and
   * it would silently stop receiving updates. `connected: false` means this
   * room has no transport for the caller — the panel answers with a full
   * resync rather than assuming the ping repaired anything.
   */
  canvas_ping: {
    input: z.object({ clientId: clientIdSchema }).strict(),
    output: z.object({ connected: z.boolean() }).strict(),
  },
  canvas_leave: {
    input: z.object({ clientId: clientIdSchema }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /**
   * Run a note as an agent: spawn a bb thread on the note's text and bind it to
   * the note. `shapeId` is the note the panel had selected; `text` is the live
   * document text it read at click time (the panel reads it, not the backend —
   * the backend's own copy of the doc is authoritative but the click is about
   * what the user can SEE, and reading it once on the client keeps this handler
   * from having to guess which of a shape's text fields the user meant).
   */
  canvas_run_note: {
    input: z
      .object({
        shapeId: z.string().min(1).max(200),
        // Capped rather than unbounded: this becomes an agent prompt, and a
        // note is a sticky, not a document.
        text: z.string().trim().min(1).max(20_000),
      })
      .strict(),
    output: agentLinkSchema,
  },
  /**
   * Bind a shape to a thread that ALREADY EXISTS in bb — the attach arm of the
   * launch-or-attach affordance.
   *
   * NO PROMPT, AND THEREFORE NO KIND GATE. `canvas_run_note` above needs a
   * note's body to spawn on; this needs two ids, so a frame, a rectangle or an
   * image can carry a badge just as well (canvas/agent-arms.ts owns that
   * asymmetry). What it does need is a thread that resolves AND is usable, and
   * both halves of that check are the handler's — see canvas/agent-attach.ts.
   *
   * REJECTS RATHER THAN RETURNING A REFUSAL SHAPE, like `canvas_run_note` and
   * unlike `canvas_av_token`. The panel already toasts `cause.message` for a
   * failed run, so the refusals arrive on a path that exists; and every refusal
   * here is a sentence for a human, not a code a caller branches on.
   */
  canvas_attach_thread: {
    input: z
      .object({
        shapeId: z.string().min(1).max(200),
        threadId: z.string().min(1).max(200),
      })
      .strict(),
    /**
     * THE LINK, AND ANYTHING THE ATTACH HAS TO SAY ABOUT ITSELF (W16/F4).
     *
     * A wrapper rather than an extra field on the link, because a warning is a
     * fact about this ACT and the link is a durable value that gets stored in
     * panel state and re-broadcast on the agent channel — a transient sentence
     * riding inside it would outlive the moment it is about.
     */
    output: z
      .object({
        link: agentLinkSchema,
        warning: z.string().optional(),
      })
      .strict(),
  },
  /**
   * W4's TWO NODE GESTURES — "add a goal" and "add a blocker under this node".
   *
   * WHY THESE ARE RPC AT ALL, which is the most consequential decision in W4.
   * The panel holds a live CRDT document and could have created the note, the
   * arrow and its two bindings locally, in one frame, with no round trip. It
   * does not, for three reasons that all say the same thing:
   *
   *  1. THE REFUSALS ARE THE FEATURE. W10's engine refuses a write that would
   *     cycle, duplicate a relationship, overflow the encoding's caps or land
   *     on a broken tree, and re-reads the whole tree through W1 afterwards to
   *     report damage a concurrent peer caused. A client-side create would be
   *     a SECOND definition of what a legal tree is, and the two would drift.
   *  2. `TreeWriteTarget` HAS NO DELETE, BY TYPE (C2's finding 1). That
   *     guarantee is a property of the one seam every write goes through;
   *     a gesture writing straight into the local doc goes around it.
   *  3. DURABILITY IS THE ROOM'S. `commitLocalWrite` broadcasts AND appends to
   *     the room's update log; a client frame is durable by the inbound path.
   *     Both are the room's business, and neither is the panel's.
   *
   * The cost is honest and stated: the new node appears on the human's canvas
   * only once the server's delta comes back, so this is not an optimistic
   * create. That is why the title is typed BEFORE the write rather than into
   * an empty note afterwards — there is no local shape to focus.
   *
   * REJECTS RATHER THAN RETURNING A REFUSAL SHAPE, like `canvas_run_note`:
   * every refusal here is a sentence for a human, and the panel already toasts
   * `cause.message`.
   */
  canvas_tree_add_goal: {
    input: z
      .object({
        /** The PAGE the goal goes on. Marked as a tree by the write if it is
         * not one yet — that is the act that starts a tree. */
        treeId: z.string().min(1).max(200),
        title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
      })
      .strict(),
    output: treeWriteResultSchema,
  },
  canvas_tree_add_blocker: {
    input: z
      .object({
        /** The node the new one will BLOCK — W0's direction, fixed here so the
         * panel cannot invert it. */
        parentId: z.string().min(1).max(200),
        title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
      })
      .strict(),
    output: treeWriteResultSchema,
  },
  /**
   * ONE NODE, FOR A `::node{id="\u2026"}` CARD IN A MESSAGE (W9).
   *
   * WHY THE CARD ASKS AT ALL, rather than reading the message it is drawn in.
   * The directive's attributes were written by a model at some point in the
   * past, into a message that is kept forever; a title and a state quoted
   * there are a snapshot of a tree that has since moved on. So the directive
   * carries the id and nothing else, and every fact on the card is read HERE,
   * live, through W5's service over the room's own document
   * (canvas/tree/node-reference.ts argues it at the other end).
   *
   * `node: null` IS A NORMAL ANSWER, not an error: a deleted node, an id a
   * model invented, and a shape that is not a tree node at all are the same
   * fact from here — this document does not have that node — and an old
   * message containing a dead reference is an ordinary thing. The card renders
   * it as a visible dead reference; a thrown error would render as "the canvas
   * is broken", which would be a lie about a healthy canvas.
   *
   * The reply is small on purpose. It feeds one line of chrome, so it carries
   * no context note and a title already cut to a label by `cardTitle`.
   */
  canvas_tree_node: {
    input: z.object({ nodeId: z.string().min(1).max(MAX_NODE_ID_LENGTH) }).strict(),
    output: z
      .object({
        node: z
          .object({
            id: z.string().min(1),
            /** The PAGE, which is where a click on the card goes. */
            treeId: z.string().min(1),
            title: z.string().max(MAX_CARD_TITLE),
            state: z.enum(NODE_STATES),
            isReady: z.boolean(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  },
  /**
   * W12 — START A THREAD TO WORK ON ONE NODE.
   *
   * NOT `canvas_run_note` WITH A BETTER PROMPT, and the difference is where the
   * prompt comes from. `canvas_run_note` is handed the text the panel read off
   * the shape; this is handed an ID, and the prompt is built HERE, from W5's
   * service over the room's own document — the node's path to root, what
   * blocks it and its context note. The panel has the document but not the
   * service, and the prompt has to be the tree as the SERVER sees it for the
   * same reason every tree write goes server-side (see the two gesture methods
   * above): one reading of the tree, not two.
   *
   * IT MINTS AN ORDINARY LINK. `AgentLinks.record`, the same badge broadcast,
   * the same three thread lifecycle events, the same canvas-gc sweep. There is
   * no tree-specific link store and there must not be one — see
   * canvas/tree/launch.ts.
   *
   * REJECTS RATHER THAN RETURNING A REFUSAL SHAPE, like `canvas_run_note`: a
   * shape that is not a usable tree node produces W5's own sentence, and the
   * panel already toasts `cause.message`.
   */
  canvas_tree_launch: {
    input: z.object({ nodeId: z.string().min(1).max(MAX_NODE_ID_LENGTH) }).strict(),
    output: agentLinkSchema,
  },
  /**
   * The threads the attach picker may offer. Server-side because the frontend
   * has no bb SDK at all — `bb.sdk` exists only in this process.
   *
   * WHICH threads, in what ORDER, and how many, are all
   * canvas/thread-picker.ts's decisions; this method is the fetch around them.
   * The query the user types is NOT one of them: filtering happens in the
   * browser over this answer, so typing does not cost a round trip per
   * keystroke, which is the same call the page popover's filter makes.
   */
  canvas_thread_options: {
    input: z.null(),
    output: z
      .object({
        options: z.array(
          z
            .object({
              threadId: z.string().min(1),
              label: z.string(),
              updatedAt: z.number(),
              attachedShapeId: z.string().min(1).nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  /**
   * Break a note's link to its agent thread, on a human's say-so ("Unlink
   * thread" on the badge).
   *
   * The THREAD IS UNTOUCHED — not archived, not deleted, not stopped. This is
   * the "get this badge off my sticky" action, and destroying a conversation is
   * a decision that belongs to bb's own thread UI, where it can be confirmed
   * and undone. `unlinked: false` is the honest answer for a shape that had no
   * link (a stale second tab pressing the same button); it is not an error,
   * because "there is no link on this note" is precisely the state the caller
   * asked for.
   */
  canvas_unlink_agent: {
    input: z.object({ shapeId: z.string().min(1).max(200) }).strict(),
    output: z.object({ unlinked: z.boolean() }).strict(),
  },
  /**
   * Every shape -> thread link the room knows. A freshly mounted panel calls
   * this once so badges are on screen immediately, rather than appearing only
   * for threads that happen to change status while it is watching; it is also
   * what a panel calls after a realtime reconnect, because status messages are
   * ephemeral and whatever was published during the gap is simply gone.
   */
  canvas_agents: {
    input: z.null(),
    output: z.object({ links: z.array(agentLinkSchema) }).strict(),
  },
  /**
   * Who is in the room, by name. What the sidebar accessory's "N online" count
   * seeds itself from: the room broadcasts membership changes on
   * CANVAS_CHANNEL, but a sidebar that has just mounted has missed every
   * broadcast so far and would show nothing until the next join.
   *
   * Deliberately NOT `canvas_debug`, which is spike introspection that returns
   * shape ids and snapshot sizes: this one is a product surface with a shape
   * the UI depends on.
   */
  canvas_roster: {
    // WIDENED, DELIBERATELY, RATHER THAN GROWING A SECOND CHANNEL. Every bb tab
    // already polls this method to draw the presence strip; making that same
    // call carry "and here is where I am" is one request per tab per tick
    // instead of two, and it means a location can never be newer or older than
    // the membership it arrived with.
    //
    // Still `.strict()`, and still accepts `null` — `CanvasOnlineCount` (the
    // sidebar's "N online") is a read-only consumer that has no location to
    // report, and a bb window running an older bundle must not start failing
    // its polls.
    //
    // TRUST: `name`, `path` and `title` are the CALLER'S CLAIMS about itself,
    // exactly as `canvas_join`'s `name` already is — an rpc handler never sees
    // the request, so the Cloudflare Access header that identifies a human is
    // not available here (see canvas/identity.ts's trust-boundary note). Fine
    // for a spike on a trusted LAN, wrong for anything else.
    input: z
      .object({
        clientId: clientIdSchema,
        name: nameSchema.optional(),
        path: pathSchema,
        title: z.string().trim().max(200).optional(),
        // `document.hasFocus()` in the reporting tab. OPTIONAL, so an older bb
        // bundle keeps polling successfully, and absent reads as false.
        // It exists because "which of this person's tabs do we mean" cannot be
        // answered by recency: two live windows poll on drifting 2s timers, so
        // argmax(seenMs) flips between them with nothing in the world changing
        // (see WHERE_STICKY_LEAD_MS in canvas/dock/model.ts). Only one window
        // can hold the focus, so one bit settles it.
        focused: z.boolean().optional(),
      })
      .strict()
      .nullable(),
    output: z
      .object({
        members: z.array(
          z
            .object({
              clientId: z.string(),
              name: z.string(),
              /** Null is PRESENT, LOCATION UNKNOWN — never "not here". */
              path: z.string().nullable(),
              title: z.string().nullable(),
              seenMs: z.number().nullable(),
              /** Null whenever `path` is — see LocatedMember. */
              focused: z.boolean().nullable(),
              /**
               * Whether this clientId is in the SYNC ROOM, i.e. has an open
               * canvas panel. The roster answers "who is in the building"; this
               * one bit answers "and which of them are on the canvas".
               *
               * It is here for the sidebar's "N on the canvas" badge
               * (`CanvasOnlineCount`), which seeds from this reply and then
               * follows the `identities` realtime broadcast. Before the
               * widening both read the same set; after it, `members.length`
               * counted every bb tab while the broadcast still counted canvas
               * clients, so the badge disagreed with itself and flipped
               * whenever a join/leave/sweep published. Sending the room's own
               * subset keeps the two sources symmetrical instead of asking the
               * client to re-derive it from `path`, which it cannot.
               */
              inRoom: z.boolean(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  /**
   * Mint a LiveKit access token for the audio room.
   *
   * `clientId` is OPTIONAL and is a lookup key, not a claim: the backend
   * resolves the participant identity from the room's own clientId -> name map
   * (see avIdentityFor), so a caller cannot mint a token naming somebody else,
   * and a caller whose canvas session has not booted yet still gets a token
   * under the server's local identity.
   *
   * The unconfigured case is a RESULT, not a throw — see AvTokenResult.
   */
  canvas_av_token: {
    input: z.object({ clientId: clientIdSchema.optional() }).strict(),
    output: z.discriminatedUnion("ok", [
      z
        .object({
          ok: z.literal(true),
          url: z.string(),
          token: z.string(),
          room: z.string(),
          identity: z.string(),
        })
        .strict(),
      z
        .object({
          ok: z.literal(false),
          error: z.literal("not_configured"),
          detail: z.string(),
        })
        .strict(),
    ]),
  },
  /**
   * Read the room transcript — what was SAID in the room (see
   * canvas/transcript.ts), as opposed to what was drawn on it.
   *
   * `sinceMs` is an ABSOLUTE epoch-millisecond lower bound, not a duration:
   * the caller is a browser tab or an agent that already knows the clock, and
   * `bb canvas transcript --since 10m` turns its duration into one of these
   * before it gets here. Every filter is an AND; `search` is a substring of the
   * utterance text, `speaker` an exact (case-insensitive) name.
   *
   * `limit` is the TAIL: the newest N matching entries, then returned oldest
   * first so a caller renders it top to bottom without reversing anything.
   */
  canvas_transcript_query: {
    input: z
      .object({
        sinceMs: z.number().optional(),
        search: z.string().max(500).optional(),
        speaker: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(MAX_QUERY_LIMIT).optional(),
      })
      .strict(),
    output: z
      .object({
        entries: z.array(
          z
            .object({ ts: z.number(), speaker: z.string(), text: z.string() })
            .strict(),
        ),
      })
      .strict(),
  },
  /** Spike-only introspection; the UI does not need it, tests and humans do. */
  canvas_debug: {
    input: z.null(),
    output: z
      .object({
        room: z.string(),
        shapeIds: z.array(z.string()),
        clientIds: z.array(z.string()),
        identities: z.record(z.string(), z.string()),
        pendingUpdates: z.number(),
        snapshotBytes: z.number(),
      })
      .strict(),
  },
});
