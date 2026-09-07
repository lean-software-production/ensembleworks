// bb-plugin-canvas — a BB plugin backend entry.
//
// The default export is a factory that receives the plugin API. BB supplies
// the tiny defineRpcContract runtime helper; the API type remains type-only.
//
// This backend is the canvas room host: one authoritative SyncServerPeer for
// room "main" plus the rpc half of its transport. See canvas/room.ts for the
// bb-specific wire mapping and transport.ts for the client half that
// canvas/CanvasPanel.tsx mounts.
import os from "node:os";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { AccessToken } from "livekit-server-sdk";
import { z } from "zod";
import { AgentLinks, threadTitleFor } from "./canvas/agents.js";
import { attachVerdictFor } from "./canvas/agent-attach.js";
import { resolveCanvasProjectId } from "./canvas/agent-project.js";
import { threadListArgsFor, threadPickerOptions } from "./canvas/thread-picker.js";
import {
  LIVEKIT_ROOM,
  NOT_CONFIGURED_DETAIL,
  TOKEN_TTL,
  avIdentityFor,
  livekitConfigFrom,
} from "./canvas/av.js";
import { base64ToBytes } from "./canvas/base64.js";
import {
  CF_ACCESS_EMAIL_HEADER,
  IDENTITY_ROUTE_PATH,
  MAX_NAME_LENGTH,
  resolveIdentity,
} from "./canvas/identity.js";
import { LocationBook } from "./canvas/locations.js";
import { CanvasRoomHost } from "./canvas/room.js";
import { MAX_PATH_LENGTH } from "./canvas/dock/where.js";
import { CANVAS_MIGRATIONS, CanvasStore } from "./canvas/store.js";
import {
  DEFAULT_QUERY_LIMIT,
  MAX_QUERY_LIMIT,
  TranscriptStore,
  filterFor,
  mentionItems,
  mentionWindowFor,
  parseIngest,
  parseTranscriptArgs,
  transcriptBlock,
} from "./canvas/transcript.js";
import { formatTranscriptLine } from "./canvas/transcript-view.js";
import {
  AGENT_CHANNEL,
  AGENT_STATUSES,
  CANVAS_CHANNEL,
  TRANSCRIPT_CHANNEL,
} from "./canvas/wire.js";

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

/** Abortable sleep — a plain setTimeout would sleep through the stop window. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  // Where the canvas's agent threads live. Declared with no `default`, so the
  // value is `string | undefined` — and unset is now a REFUSAL, not a shrug:
  // see canvas/agent-project.ts for why guessing a project was worse than an
  // error that names this setting.
  //
  // The three LiveKit settings are what turns "Join audio" from a toast into a
  // call. The two credentials are `secret: true`, so they live in this plugin's
  // 0600 secrets file, never reach the plugin database, and are never served to
  // the frontend — only the minted, short-lived token crosses to the browser.
  // `livekitUrl` is not secret: it is a hostname the client has to be told
  // anyway.
  const settings = bb.settings.define({
    project: {
      type: "project",
      label: "Project for canvas agents",
      description:
        "Which project the canvas's agent threads live in — spawned into, listed from, and attached within. Required: unset refuses the launch rather than guessing.",
    },
    livekitUrl: {
      type: "string",
      label: "LiveKit URL",
      description: "wss://… of the LiveKit server that carries canvas audio.",
      default: "",
    },
    livekitApiKey: {
      type: "string",
      label: "LiveKit API key",
      description: "Used only to sign access tokens; never sent to a browser.",
      secret: true,
    },
    livekitApiSecret: {
      type: "string",
      label: "LiveKit API secret",
      description: "Used only to sign access tokens; never sent to a browser.",
      secret: true,
    },
  });

  /** This server's own identity, used as the LiveKit participant name for a
   * caller the room does not (yet) know. Resolved with no request header
   * because an rpc handler never sees one — the `local:<user>` branch. */
  const localName = resolveIdentity(undefined, os.userInfo().username).name;

  // Persisted shape -> thread links, mirrored in memory. Loaded HERE, in the
  // factory, so the very first `canvas_agents` call after a reload already has
  // every badge — a panel that mounted before this plugin reloaded would
  // otherwise show a blank canvas of unlinked notes until each thread happened
  // to change status.
  const agents = new AgentLinks(bb.storage.kv);
  await agents.load();
  bb.log.info(`restored ${agents.links.length} agent link(s)`);

  /**
   * The project every canvas thread lives in — spawned, listed for the attach
   * picker, or checked at attach time. The `project` setting, and NOTHING ELSE:
   * the "else the first project bb lists" fallback that used to be here was a
   * silent guess that landed the owner's threads in an unrelated project, and
   * canvas/agent-project.ts is the whole argument for removing it.
   *
   * Re-read per call rather than captured at load, so changing the setting
   * takes effect without a reload (settings saves do not reload a healthy
   * plugin). The refusal itself is `resolveCanvasProjectId`'s, so it is
   * unit-tested rather than only reachable by driving the plugin.
   */
  async function resolveProjectId(): Promise<string> {
    const { project } = await settings.get();
    return resolveCanvasProjectId(project);
  }

  // One authoritative SyncServerPeer for room "main", restored from this
  // plugin's own SQLite and re-persisted durable-first on every inbound
  // update. Constructed at load so the room is live before the first client.
  const db = bb.storage.database();
  bb.storage.migrate(db, CANVAS_MIGRATIONS);
  const room = new CanvasRoomHost({
    store: new CanvasStore(db),
    publish: (envelope) => bb.realtime.publish(CANVAS_CHANNEL, envelope),
    log: (message) => bb.log.info(message),
  });
  // Who is WHERE, which is a different question from who is in the sync room:
  // every bb tab reports here on its roster poll, including the many that will
  // never open a canvas. Deliberately not folded into CanvasRoomHost — a room
  // member owns a transport and every canvas delta is published once per
  // transport, so making every bb tab a room member would multiply canvas
  // traffic by the number of tabs that cannot render a canvas. See
  // canvas/locations.ts.
  const locations = new LocationBook();

  // The room's OTHER half: what was said in it. Same database, entirely
  // separate table — the canvas document is a CRDT nobody queries and the
  // transcript is a query surface nobody edits.
  const transcript = new TranscriptStore(db);
  // LIFO: this runs before the host closes the database handle, so the final
  // compaction still has somewhere to write.
  bb.onDispose(() => room.close());

  // Idle-client GC, plus the one-shot server hello. The hello is published
  // HERE rather than in the factory body deliberately: a service starts only
  // after the factory completes and the host has swapped the new registration
  // set in, so a client that re-joins in response is guaranteed to reach THIS
  // room host and not the one being disposed.
  //
  // Frames refresh a client's last-seen; anything silent past the window gets
  // its transport closed so the server peer stops relaying to a tab that is
  // gone.
  bb.background.service("canvas-gc", {
    async start(signal) {
      bb.realtime.publish(CANVAS_CHANNEL, { hello: Date.now() });
      // Startup hygiene, AFTER the hello: a stranded tab re-joining is
      // time-critical and this is N round trips, so it must never be in front
      // of it. In this service rather than in the factory because a service
      // runs only once the host has swapped this registration set in, so the
      // removals it publishes actually reach clients (a factory-time publish
      // races the swap — the same reason the hello lives here).
      //
      // `thread.archived`/`thread.deleted` only reach a LOADED plugin, so a
      // thread archived while bb ran without this one leaves a kv row pointing
      // at a conversation nobody can open. This is the one place that catches
      // up on that.
      const dropped = await agents.sweep(async (threadId) => {
        const thread = await bb.sdk.threads.get({ threadId });
        return { archivedAt: thread.archivedAt, deletedAt: thread.deletedAt };
      });
      for (const link of dropped) {
        bb.realtime.publish(AGENT_CHANNEL, {
          shapeId: link.shapeId,
          unlinked: true,
        });
        bb.log.info(`note ${link.shapeId} unlinked: thread ${link.threadId} is gone`);
      }
      while (!signal.aborted) {
        await sleep(30_000, signal);
        if (signal.aborted) break;
        const nowMs = Date.now();
        room.sweep(nowMs);
        // Same clock, same window (LOCATION_IDLE_MS is CLIENT_IDLE_MS): a
        // location must never outlive the person it belongs to.
        locations.sweep(nowMs);
      }
    },
  });

  // Who is at the other end of this request. The ONLY place this plugin can
  // learn that: Cloudflare Access stamps its header on the HTTP request it
  // forwards, and an rpc handler never sees a request at all. The panel fetches
  // this once on mount and carries the name it gets back up on `canvas_join`.
  //
  // `auth: "local"` (the default) is right: the caller is the bb frontend on a
  // bb app origin. Locally there is no Access edge and so no header, which is
  // the `local:<username>` branch — the same shape, honestly labelled.
  bb.http.route("GET", IDENTITY_ROUTE_PATH, (context) =>
    context.json(
      resolveIdentity(
        context.req.header(CF_ACCESS_EMAIL_HEADER),
        os.userInfo().username,
      ),
    ),
  );

  // Scribe ingest. On the production VM a systemd service (LiveKit -> Whisper)
  // POSTs one utterance, or a catch-up batch of them, here.
  //
  // `auth: "token"` is the only right mode: the caller is a MACHINE, not a bb
  // app origin ("local" would reject it) and not a webhook with a signature of
  // its own to verify ("none" would let anything on the box write into the
  // room's memory). The service carries `bb plugin token canvas` in
  // `x-bb-plugin-token`.
  bb.http.route(
    "POST",
    "/scribe",
    async (context) => {
      // A body that is not JSON at all is the same class of caller error as a
      // body that is the wrong JSON — both get a 400 with a sentence, never a
      // 500 that reads like the plugin broke.
      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        return context.json({ ok: false, error: "body must be JSON" }, 400);
      }
      const parsed = parseIngest(body, Date.now());
      if (!parsed.ok) {
        bb.log.warn(`scribe rejected a payload: ${parsed.error}`);
        return context.json({ ok: false, error: parsed.error }, 400);
      }
      transcript.insert(parsed.entries);
      // Durable first, then live: a subscriber that reacts to the message can
      // always re-read the row it names.
      for (const entry of parsed.entries) {
        bb.realtime.publish(TRANSCRIPT_CHANNEL, entry);
      }
      return context.json({ ok: true, inserted: parsed.entries.length });
    },
    { auth: "token" },
  );

  // `@transcript` in any composer. The items are WINDOWS, not rows: `resolve`
  // runs at send time (possibly minutes after the pill was inserted), and an
  // agent asked for "the last 15 minutes" means the 15 minutes before it reads
  // them, not before the user typed the @.
  bb.ui.registerMentionProvider({
    id: "transcript",
    label: "Room transcript",
    search: ({ query }) =>
      mentionItems(query, Date.now(), (filter) => transcript.count(filter)),
    resolve: (itemId) => {
      const window = mentionWindowFor(itemId);
      // Throwing here BLOCKS the user's send, so an id we cannot decode
      // resolves to a sentence saying so rather than to an error dialog over a
      // message they have already written.
      if (window === null) {
        return { context: `Room transcript: unknown window "${itemId}".` };
      }
      const now = Date.now();
      return {
        context: transcriptBlock(
          window.label,
          transcript.query(filterFor(window, now)),
        ),
      };
    },
  });

  bb.rpc.register(rpcContract, {
    canvas_join: ({ clientId, name }) => {
      room.join(clientId, Date.now(), name);
      return { room: room.room };
    },
    canvas_frame: ({ clientId, data }) => {
      // Auto-joins an unknown clientId (see CanvasRoomHost.frame) so a plugin
      // reload does not strand still-open browser tabs.
      room.frame(clientId, base64ToBytes(data), Date.now());
      return { ok: true } as const;
    },
    canvas_ping: ({ clientId }) => ({
      connected: room.touch(clientId, Date.now()),
    }),
    canvas_leave: ({ clientId }) => {
      room.leave(clientId);
      return { ok: true } as const;
    },
    canvas_run_note: async ({ shapeId, text }) => {
      const projectId = await resolveProjectId();
      const thread = await bb.sdk.threads.spawn({
        projectId,
        environment: { type: "project-default" },
        prompt: text,
        title: threadTitleFor(text),
      });
      // Born "running": spawn starts a turn, and waiting for the thread.active
      // event to paint the first badge would leave the note looking untouched
      // for as long as the agent takes to start.
      const link = await agents.record(shapeId, thread.id, "running");
      bb.realtime.publish(AGENT_CHANNEL, link);
      bb.log.info(`note ${shapeId} -> thread ${thread.id} in project ${projectId}`);
      return link;
    },
    canvas_attach_thread: async ({ shapeId, threadId }) => {
      // THE PROJECT FIRST, before bb is asked anything. An unconfigured plugin
      // has no idea which project this canvas belongs to, so it cannot rule on
      // a thread at all — and failing on the setting is a better answer than a
      // round trip whose result is discarded a line later.
      const canvasProjectId = await resolveProjectId();
      // THEN THE PROBE, AND IT RUNS BEFORE ANYTHING IS WRITTEN. A kv row
      // pointing at a thread that does not resolve mounts a ThreadChat on
      // nothing, which is the same failure canvas/agents.ts's `sweep` and
      // `linkFrom` already exist to clean up after; a throw here is bb saying
      // "no such thread" and is left to reject the rpc as-is.
      const thread = await bb.sdk.threads.get({ threadId });
      // ...and resolving is only HALF the check: `threads.get` answers for an
      // archived or deleted thread too. The rest of the ruling — liveness,
      // project, and who already holds the thread — is the pure verdict, and
      // the badge's starting status comes out of the same call because it is
      // derived from this thread rather than assumed.
      const verdict = attachVerdictFor({
        thread,
        shapeId,
        holderShapeId: agents.shapeForThread(threadId),
        canvasProjectId,
      });
      if (!verdict.ok) throw new Error(verdict.message);
      // The SAME record-and-publish the launch arm uses, deliberately: the
      // badge, the thread.active/idle/failed subscription, canvas_unlink_agent
      // and the startup sweep are then all unchanged code working on an
      // attached link.
      const link = await agents.record(shapeId, threadId, verdict.status);
      bb.realtime.publish(AGENT_CHANNEL, link);
      bb.log.info(`shape ${shapeId} attached to thread ${threadId} (${verdict.status})`);
      return link;
    },
    canvas_thread_options: async () => {
      const projectId = await resolveProjectId();
      const rows = await bb.sdk.threads.list(threadListArgsFor(projectId));
      // threadId -> the shape holding it, which is what marks an
      // already-attached row. Built from the live mirror rather than a second
      // query, so the picker cannot disagree with the badges on screen.
      const attachedBy = Object.fromEntries(
        agents.links.map((link) => [link.threadId, link.shapeId]),
      );
      return { options: threadPickerOptions(rows, attachedBy) };
    },
    canvas_unlink_agent: async ({ shapeId }) => {
      const link = await agents.remove(shapeId);
      if (link === null) return { unlinked: false };
      // Only broadcast a removal a tab could actually act on: publishing for a
      // shape nobody has a badge for is a message every open tab decodes and
      // throws away.
      bb.realtime.publish(AGENT_CHANNEL, { shapeId, unlinked: true });
      bb.log.info(`note ${shapeId} unlinked from thread ${link.threadId}`);
      return { unlinked: true };
    },
    canvas_agents: () => ({ links: agents.links }),
    canvas_roster: (report) => {
      const now = Date.now();
      // The caller's own report, when it made one. `null` is a read-only
      // consumer (the sidebar's "N online"), which has no location to give.
      if (report !== null && report.path !== undefined) {
        locations.seen(
          {
            clientId: report.clientId,
            name: report.name ?? null,
            path: report.path,
            title: report.title ?? null,
            focused: report.focused === true,
          },
          now,
        );
      }
      // Swept here as well as on the gc tick: on a quiet server the gc runs
      // every 30 seconds, and a roster answer must never name somebody the
      // clock says is gone just because no timer has fired yet.
      locations.sweep(now);
      return { members: locations.members(room.identities, now) };
    },
    canvas_av_token: async ({ clientId }) => {
      // Re-read per call rather than captured at load: a settings save does not
      // reload a healthy plugin, so pasting a key and clicking Join has to work
      // without `bb plugin reload`.
      const config = livekitConfigFrom(await settings.get());
      if (config === null) {
        bb.log.info("canvas_av_token: LiveKit is not configured");
        return {
          ok: false as const,
          error: "not_configured" as const,
          detail: NOT_CONFIGURED_DETAIL,
        };
      }
      const identity = avIdentityFor(clientId, room.identities, localName);
      const accessToken = new AccessToken(config.apiKey, config.apiSecret, {
        identity,
        name: identity,
        ttl: TOKEN_TTL,
      });
      // The room name is the CONSTANT from av.ts, never a setting and never
      // caller input: this spike can only ever join "bb-spike", never the
      // production EnsembleWorks room on the same LiveKit server.
      accessToken.addGrant({
        room: LIVEKIT_ROOM,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
      });
      return {
        ok: true as const,
        url: config.url,
        token: await accessToken.toJwt(),
        room: LIVEKIT_ROOM,
        identity,
      };
    },
    canvas_transcript_query: ({ sinceMs, search, speaker, limit }) => ({
      entries: transcript.query({
        sinceMs,
        search,
        speaker,
        limit: limit ?? DEFAULT_QUERY_LIMIT,
      }),
    }),
    canvas_debug: () => ({
      room: room.room,
      shapeIds: room.peer.doc.listShapes().map((shape) => shape.id),
      clientIds: room.clientIds,
      identities: room.identities,
      pendingUpdates: room.pendingUpdates,
      snapshotBytes: room.peer.snapshot().length,
    }),
  });

  // Live badge status. These three events fire for EVERY thread on the server,
  // not just ours — `agents.apply` answers null for anything we did not spawn,
  // which is the overwhelmingly common case and the only filter needed. The
  // handlers are observe-only (they can never delay or veto a transition) and
  // errors are caught and counted by the host, so a publish that throws costs
  // one badge update rather than the thread's turn.
  const STATUS_EVENTS = [
    ["thread.active", "running"],
    ["thread.idle", "idle"],
    ["thread.failed", "failed"],
  ] as const;
  for (const [event, status] of STATUS_EVENTS) {
    bb.events.on(event, async ({ thread }) => {
      const link = await agents.apply(thread.id, status);
      if (link !== null) bb.realtime.publish(AGENT_CHANNEL, link);
    });
  }

  // The other end of a link's life. An archived or deleted thread is not a
  // fourth badge state — it is no badge: the thread is out of bb's sidebar, so
  // the badge is a button that cannot open anything, and the kv row behind it
  // would otherwise outlive the conversation forever.
  //
  // Both events are handled identically and both are idempotent (`removeByThread`
  // answers null the second time), which matters because bb archives a parent
  // and its children in one cascade and can delete a thread that was already
  // archived — the same link may legitimately be retired twice.
  for (const event of ["thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, async ({ thread }) => {
      const link = await agents.removeByThread(thread.id);
      if (link === null) return;
      bb.realtime.publish(AGENT_CHANNEL, { shapeId: link.shapeId, unlinked: true });
      bb.log.info(`note ${link.shapeId} unlinked: thread ${thread.id} ${event}`);
    });
  }

  // The `bb canvas` command: read-only introspection of the live room, for
  // humans and agents debugging the spike from a shell.
  const usage = [
    "Usage:",
    "  bb canvas status [--json]   Room, connected clients, shape count",
    "  bb canvas shapes [--json]   Every shape id in the room",
    "  bb canvas agents [--json]   Every shape -> agent-thread link",
    "  bb canvas transcript [--since 10m|2h|1d] [--search TEXT] [--speaker NAME] [--limit N] [--json]",
    "                              What was said in the room",
  ].join("\n");
  bb.cli.register({
    name: "canvas",
    summary: "Inspect the Canvas plugin's live room",
    commands: [
      {
        name: "status",
        summary: "Show the room, its connected clients, and its shape count",
        usage: "bb canvas status [--json]",
      },
      {
        name: "shapes",
        summary: "List every shape id in the room",
        usage: "bb canvas shapes [--json]",
      },
      {
        name: "agents",
        summary: "List every note -> agent-thread link and its status",
        usage: "bb canvas agents [--json]",
      },
      {
        name: "transcript",
        summary:
          "Read what was said in the room, filtered by time, speaker or text",
        usage:
          "bb canvas transcript [--since 10m|2h|1d] [--search TEXT] [--speaker NAME] [--limit N] [--json]",
      },
    ],
    run(argv) {
      const json = argv.includes("--json");
      const [command] = argv.filter((arg) => arg !== "--json");

      // Handled before the shared prelude below: `transcript` is the one
      // subcommand with flags of its own, and it has no use for the shape list
      // the others all share.
      if (command === "transcript") {
        // Sliced at the subcommand rather than at 0, so `bb canvas --json
        // transcript` parses the same as `bb canvas transcript --json`.
        const parsed = parseTranscriptArgs(
          argv.slice(argv.indexOf("transcript") + 1),
          Date.now(),
        );
        if (!parsed.ok) {
          return {
            exitCode: 1,
            stderr: `bb canvas transcript: ${parsed.error}\n\n${usage}`,
          };
        }
        const entries = transcript.query(parsed.filter);
        return {
          exitCode: 0,
          stdout: (parsed.json || json)
            ? JSON.stringify(entries)
            : entries.length === 0
              ? "No transcript entries."
              : entries.map(formatTranscriptLine).join("\n"),
        };
      }

      const shapeIds = room.peer.doc.listShapes().map((shape) => shape.id);
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "status": {
          const identities = room.identities;
          const status = {
            room: room.room,
            // Named where a name is known: "who is on the canvas" is the
            // question a human asks this command, and a bare 16-hex clientId
            // never answered it.
            clients: room.clientIds.map((clientId) =>
              identities[clientId] === undefined
                ? clientId
                : `${identities[clientId]} (${clientId})`,
            ),
            shapes: shapeIds.length,
            pendingUpdates: room.pendingUpdates,
          };
          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify(status)
              : [
                  `room:     ${status.room}`,
                  `clients:  ${status.clients.length === 0 ? "none" : status.clients.join(", ")}`,
                  `shapes:   ${status.shapes}`,
                  `pending:  ${status.pendingUpdates} update(s) since last snapshot`,
                ].join("\n"),
          };
        }
        case "shapes":
          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify(shapeIds)
              : shapeIds.length === 0
                ? "No shapes."
                : shapeIds.join("\n"),
          };
        case "agents": {
          const links = agents.links;
          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify(links)
              : links.length === 0
                ? "No shapes are linked to agent threads."
                : links
                    .map(
                      (link) =>
                        `${link.status.padEnd(7)} ${link.shapeId}  ->  ${link.threadId}`,
                    )
                    .join("\n"),
          };
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  // Cleanup on reload/disable/shutdown; hooks run LIFO. The sanctioned place
  // to clear timers and close connections.
  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
