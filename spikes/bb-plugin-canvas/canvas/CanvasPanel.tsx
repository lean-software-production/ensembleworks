// The full-bleed canvas mount: composes canvas-editor (headless editor state +
// tool FSMs), canvas-react (renderer), and canvas-sync (SyncClientPeer +
// PresenceStore) into a live multiplayer canvas inside a bb nav panel.
//
// WIRE MAPPING (bb has no plugin WebSocket surface, so the two directions of
// the canvas-sync protocol ride different bb primitives):
//
//   client -> server   rpc `canvas_frame` (base64 frame)  — transport.send
//   server -> client   bb.realtime on CANVAS_CHANNEL, envelope { to, data }
//
// realtime is broadcast-only, so `useRealtime` below sees EVERY client's
// envelopes and keeps only the ones addressed to this panel's own clientId.
// The one deliberately UNaddressed message on that channel is the room's
// clientId -> name map, which everybody needs (see canvas/identity.ts).
//
// CONSTRUCTION SEQUENCE (once per mount, StrictMode-safe — construct lazily
// inside the effect, tear down in that SAME effect's cleanup, never at module
// or render scope):
//   0. fetchIdentity() — who is at this browser (canvas/identity.ts). FIRST,
//      so the very first join already carries this client's name and peers
//      never see it as an unlabelled stranger. It never rejects, so it cannot
//      wedge the boot.
//   1. createBbTransport({ clientId, sendFrame }) — the rpc half.
//   2. rpc canvas_join (WITH the name), so the room has a server-side transport
//      for us before the first frame. (The backend auto-joins an unknown
//      clientId anyway, so this is belt-and-braces against a reload racing a
//      plugin reload — but an auto-join carries no name.)
//   3. new SyncClientPeer({ peerId, transport, presence }) — a fresh
//      crypto-seeded peer id per panel, never the server's reserved 1n.
//   4. Race peer.ready() (resolves on the server's Frame.SyncDone, sent right
//      after the backfill Update) against a bounded cap, so a healthy room
//      renders as soon as it is caught up and only a transport that never
//      signals readiness waits the whole cap.
//   5. resolvePageId(peer.doc, pageIdFromSubPath(subPath)) -> new Editor(...)
//      -> createToolContext ->
//      registerCoreShapes() -> createToolSet(). `now`/`random` are real and
//      injected HERE: canvas-editor forbids reading a clock or PRNG inside the
//      package, and this mount is the composition edge that is allowed to.
// Disposal: toolContext.dispose() (non-optional — an undisposed context keeps
// its doc listener registered forever), peer.close(), presenceStore.destroy()
// (releases the EphemeralStore expiry timer), transport.close(), rpc
// canvas_leave. A `cancelled` flag guards the async boot so an unmount landing
// mid-connect tears down whatever got constructed.
//
// THE PAGE IS IN THE ROUTE (design doc D-3). bb hands this panel the route
// remainder as `subPath`, so `/plugins/canvas/canvas/page:retro` addresses one
// page. It arrives in two different places for two different jobs: the boot
// effect reads it ONCE, through a ref, to seed the Editor (step 5 above —
// putting it in that effect's dependency array would rebuild the transport,
// the peer and the editor on every page click); and CanvasSession's route
// effect reconciles it with `currentPageId` from then on. Which of the two
// moved, whether a navigation is owed and whether it replaces are all
// canvas/pages/page-route.ts's — nothing below decides any of it.
//
// ABANDONMENT-CANCEL WIRING: four triggers all reach `cancelAndReset` —
// Viewport's onViewportBlur, its onPointerCancel sibling, an Escape keydown,
// and the toolbar's tool-switch handler. Each is a case where a pointerup may
// never arrive, which would otherwise strand a half-created shape in the doc
// where every peer can see it.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import {
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import {
  Editor,
  applyWheel,
  createToolContext,
  type InputEvent,
  type Intent,
  type KeyInputEvent,
  type SelectState,
  type SelectAndTransformState,
  type ToolContext,
} from "@ensembleworks/canvas-editor";
import { PresenceStore, SyncClientPeer } from "@ensembleworks/canvas-sync";
import type { SnapResult } from "@ensembleworks/canvas-model";
import {
  Cursors,
  Grid,
  Overlay,
  ShapeLayer,
  TextEditor,
  Viewport,
  WorldLayer,
  registerCoreShapes,
  useDocSnapshot,
  useEditorState,
  type ViewportSize,
} from "@ensembleworks/canvas-react";
import { toast } from "sonner";
import {
  createBbTransport,
  envelopeBytesFor,
  identitiesFrom,
  isResyncFor,
  newPeerId,
  serverHelloEpoch,
  type BbTransport,
} from "../transport.js";
import { AgentLayer } from "./agents-ui.js";
import type { ThreadOption } from "./thread-picker.js";
import { promptTextFor } from "./agents-view.js";
import {
  AGENT_CHANNEL,
  CANVAS_CHANNEL,
  agentLinkFrom,
  agentUnlinkFrom,
  type CanvasAgentLink,
} from "./wire.js";
import { adaptPresence, fetchIdentity } from "./identity.js";
import { resolvePageId } from "./page.js";
import { redoWithRepair, undoWithRepair } from "./pages/history-repair.js";
import { usePageSwitcher } from "./pages/PageSwitcher.js";
import {
  CHROME_ACCENT,
  CHROME_DOCK_EDGE_GAP_PX,
  CHROME_DOCK_POINTER_EVENTS,
  CHROME_DOCK_TOOLBAR_OVERFLOW,
  CHROME_DOCK_Z_INDEX,
  CHROME_FAINT,
  CHROME_FONT,
  CHROME_HAIRLINE,
  CHROME_INK,
  CHROME_MUTED,
  CHROME_PAPER,
  CHROME_SHADOW,
} from "./pages/chrome-dock.js";
import {
  createPageRouter,
  pageIdFromSubPath,
  type PageRouter,
} from "./pages/page-route.js";
import {
  createPageDocumentTitle,
  type DocumentTitleHost,
  type PageDocumentTitle,
} from "./pages/page-title.js";
import { canvasBus } from "./panel-bus.js";
import { tabClientId } from "./tab-id.js";
import { buildRoster, cameraCenteredOn, panIntentFor } from "./roster.js";
import { SpeakerRings } from "./roster-ui.js";
import {
  createPresencePublisher,
  type PresencePublisher,
} from "./presence-publisher.js";
import {
  cancelActiveTool,
  createInitialToolStates,
  createToolSet,
  deleteSelectionIntents,
  dispatchToActiveTool,
  type ToolId,
  type ToolSet,
  type ToolStates,
} from "./tool-loop.js";
import type { rpcContract } from "../server";

/** Safety cap on the boot handshake (see CONSTRUCTION SEQUENCE step 4). Larger
 * than a raw-socket mount would need: every frame here is an rpc round trip
 * plus a websocket broadcast, not one socket write. */
const READY_TIMEOUT_MS = 4_000;

/** PresenceStore exposes no "a remote peer changed" hook — only onLocalUpdate,
 * which fires for THIS peer's own publishes. So remote cursors are polled.
 * `all()` is an in-memory map read, not a round trip, so this costs nothing
 * measurable at this cadence. */
const PRESENCE_POLL_MS = 150;

/**
 * How often this panel pings the room to say it is still here.
 *
 * A tab that is merely being WATCHED sends nothing at all — presence rides
 * pointer movement and doc updates ride edits — so without a keepalive the
 * backend's idle sweep (CLIENT_IDLE_MS, 2 min) evicts it, stops relaying to it,
 * and it goes silently and permanently stale. Comfortably under half the idle
 * window so a single dropped ping is not an eviction.
 */
const KEEPALIVE_MS = 45_000;

const TOOL_BUTTONS: ReadonlyArray<{ readonly id: ToolId; readonly label: string }> = [
  { id: "select", label: "Select" },
  { id: "hand", label: "Hand" },
  { id: "note", label: "Note" },
  { id: "frame", label: "Frame" },
  { id: "text", label: "Text" },
  { id: "geo", label: "Shape" },
];

// ---- the floating chrome's paint -------------------------------------------
//
// EVERY DECISION IN THESE OBJECTS THAT IS NOT PAINT LIVES IN
// canvas/pages/chrome-dock.ts — the edge gap, the layer, the pointer-events
// policy, the overflow answer and the fit ladder are all named from there,
// never written here, because a number in a .tsx is a number no test in this
// jsdom-free project can read.
//
// THE COLOURS ARE THE CANVAS'S OWN, NOT bb's TOKENS, and that is a change: this
// bar used to be `bg-card` / `border-border` / `text-muted-foreground` because
// it was a row in bb's chrome band. It now floats OVER the drawing surface,
// which is a document with its own paper colour, so a host token would be a
// colour chosen against a different background — under a dark bb theme, a
// foreground that is legible on bb's card lands on this light one. Same house
// rule the presence dock learned the hard way: declare, never inherit.
const chromeWrapperStyle: CSSProperties = {
  position: "absolute",
  // Bottom-centred, and STRETCHED across the surface by the same gap on both
  // sides — the stretch is what lets `justifyContent: center` centre the card
  // without measuring anything, and it is also why the wrapper must not take
  // pointer events (see below).
  bottom: CHROME_DOCK_EDGE_GAP_PX,
  left: CHROME_DOCK_EDGE_GAP_PX,
  right: CHROME_DOCK_EDGE_GAP_PX,
  zIndex: CHROME_DOCK_Z_INDEX,
  // THE DEAD-STRIP GUARD. This box spans the full width of the drawing surface;
  // if it took the pointer, every gesture starting in the bottom band of the
  // canvas would hit it instead of <Viewport> and silently draw nothing.
  pointerEvents: CHROME_DOCK_POINTER_EVENTS.wrapper,
  display: "flex",
  justifyContent: "center",
};

/**
 * The page tab strip's row — IN THE FLOW, at the top of the canvas column.
 *
 * OWNER REQUEST 2026-09-06, reversing the previous arrangement: "The tabs
 * should be at the top (where the control bar used to be); not attached to the
 * floating control bar at the bottom." So this row deliberately takes its own
 * height back off the drawing surface, which is what "where the control bar
 * used to be" means — unlike the toolbar, which stays floating.
 *
 * No `position: absolute` and no z-index: a flow row needs neither, and
 * layering belongs to canvas/pages/chrome-dock.ts and
 * canvas/dock/popover-place.ts (tests/page-switcher-layering.test.ts refuses a
 * numeric one outside them).
 */
const chromeTabRowStyle: CSSProperties = {
  flexShrink: 0,
  background: CHROME_PAPER,
  borderBottom: `1px solid ${CHROME_FAINT}`,
  minWidth: 0,
};

const chromeCardColumnStyle: CSSProperties = {
  // `pointer-events` INHERITS, so a child of a `none` wrapper is `none` too
  // unless it says otherwise. This is where the chrome starts taking clicks
  // again, and it is the smallest box that can: only what is painted.
  pointerEvents: CHROME_DOCK_POINTER_EVENTS.card,
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  // Never wider than the surface it floats on; the wrapper's own insets have
  // already taken the edge gap off both sides.
  maxWidth: "100%",
  minWidth: 0,
};

const chromeToolbarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  // WRAP, never scroll: canvas/pages/chrome-dock.ts's
  // CHROME_DOCK_TOOLBAR_OVERFLOW carries the argument.
  flexWrap: CHROME_DOCK_TOOLBAR_OVERFLOW,
  padding: "5px 6px",
  borderRadius: 10,
  border: `1px solid ${CHROME_HAIRLINE}`,
  background: CHROME_PAPER,
  // Legibility over arbitrary drawn content — an opaque fill, a hairline and a
  // shadow, so the bar reads over a dark sticky or a photo. NOT verified
  // against real content; there is no browser in this spike.
  boxShadow: CHROME_SHADOW,
  color: CHROME_INK,
  font: CHROME_FONT,
  minWidth: 0,
};

function chromeToolStyle(active: boolean): CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 6,
    border: "none",
    background: active ? CHROME_ACCENT : "transparent",
    color: active ? CHROME_PAPER : CHROME_INK,
    font: CHROME_FONT,
    fontWeight: active ? 600 : 400,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

interface Session {
  readonly peer: SyncClientPeer;
  readonly editor: Editor;
  readonly toolContext: ToolContext;
  readonly tools: ToolSet;
  /** Owned by this mount, not by SyncClientPeer — disposal calls destroy() on
   * it directly to release the EphemeralStore's expiry timer. */
  readonly presenceStore: PresenceStore;
  readonly presencePublisher: PresencePublisher;
  /** This peer's own key in the presence map; Cursors filters it out. */
  readonly selfKey: string;
}

/** Crypto-seeded [0, 1) float — canvas-editor's create tools use it for shape
 * id generation, and real entropy is what keeps ids from colliding across
 * sessions. */
function cryptoRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** The `canvas_join` input, omitting `name` entirely when we do not have one
 * yet — the schema's optional field wants an absent key, not a null. */
function joinInput(
  clientId: string,
  name: string | null,
): { clientId: string; name?: string } {
  return name === null ? { clientId } : { clientId, name };
}

/** Whether this tab asked for the `window.__canvas` debug handle — either
 * `?canvasDebug=1` on the URL or a persistent localStorage opt-in. Both reads
 * are wrapped: a sandboxed or storage-denied context throws on either. */
function canvasDebugEnabled(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get("canvasDebug") === "1") {
      return true;
    }
  } catch {
    // fall through to the storage check
  }
  try {
    return window.localStorage.getItem("canvas.debug") === "1";
  } catch {
    return false;
  }
}

/** True for a real text input/textarea/contentEditable. Duck-typed on tagName
 * rather than `instanceof Element` so this stays safe in any DOM-less test
 * environment. */
function isEditableTarget(node: Node | null): boolean {
  if (!node || typeof (node as { tagName?: unknown }).tagName !== "string") return false;
  const element = node as HTMLElement;
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.isContentEditable === true
  );
}

/** The select tool's live SnapResult, if any — drives Overlay's snap guides.
 * undefined whenever there is nothing to show: another tool is active, the
 * composite's active leg is transform, or select is not mid-drag. */
function currentSnapResult(states: ToolStates, active: ToolId): SnapResult | undefined {
  if (active !== "select") return undefined;
  const composite = states.select as SelectAndTransformState;
  if (composite.active !== "select") return undefined;
  const select = composite.select as SelectState;
  if (select.mode !== "dragging") return undefined;
  return select.snapResult ?? undefined;
}

export function CanvasPanel({ subPath }: PluginNavPanelProps) {
  // The deep-linked page, held for the boot effect to read at mount.
  //
  // A REF, NOT A DEPENDENCY. `subPath` changes every time anybody switches
  // pages (CanvasSession's route effect writes it), and the boot effect tears
  // its whole session down in cleanup — so depending on it would close the
  // transport, the peer and the presence store and re-run the join handshake
  // on every page click. Assigned during render, so the effect's first read is
  // the value bb rendered with.
  const subPathRef = useRef(subPath);
  subPathRef.current = subPath;

  const rpc = useRpc<typeof rpcContract>();
  // The boot effect and the transport's send path both need the CURRENT rpc
  // client, but neither should re-run when its identity churns.
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;

  // ONE ADDRESS PER TAB — not per mounted panel, and not a Loro peer id (that
  // is newPeerId()). The presence strip reports this same tab's whereabouts
  // under this same id (canvas/tab-id.ts), so a canvas tab is one member of
  // the room rather than a sync member and a location reporter that look like
  // two different people.
  const clientId = tabClientId();
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const transportRef = useRef<BbTransport | null>(null);

  // This client's display name, fetched once on mount from the identity route.
  // The ref is what `resync` reads (it must not re-create itself when the name
  // lands, or the boot effect would tear the session down); the state is what
  // the toolbar renders.
  const [selfName, setSelfName] = useState<string | null>(null);
  const selfNameRef = useRef<string | null>(null);

  // Everyone's names, keyed by clientId, from the room's broadcast. Joined to
  // cursors in adaptPresence.
  const [identities, setIdentities] = useState<Record<string, string>>({});

  // Note -> agent-thread links, keyed by shape id. Seeded from the backend (so
  // badges are on screen the moment the panel mounts, not only for threads that
  // change status while it watches) and then kept live off AGENT_CHANNEL.
  const [agentLinks, setAgentLinks] = useState<Record<string, CanvasAgentLink>>({});
  const refreshAgents = useCallback(() => {
    rpcRef.current
      .call("canvas_agents")
      .then(({ links }) => {
        setAgentLinks(
          Object.fromEntries(links.map((link) => [link.shapeId, link])),
        );
      })
      // Badges are an enhancement, not the canvas: a failed refresh leaves the
      // last known set on screen rather than blanking it or nagging.
      .catch(() => {});
  }, []);
  useEffect(refreshAgents, [refreshAgents]);
  const dropAgentLink = useCallback((shapeId: string) => {
    setAgentLinks((previous) => {
      if (previous[shapeId] === undefined) return previous;
      const { [shapeId]: _dropped, ...rest } = previous;
      return rest;
    });
  }, []);
  useRealtime(
    AGENT_CHANNEL,
    useCallback(
      (payload: unknown) => {
        // Two message kinds share this channel; each decoder rejects the
        // other's payload, so the order of these two branches is not load
        // bearing (see wire.ts's CanvasAgentUnlink).
        const link = agentLinkFrom(payload);
        if (link !== null) {
          setAgentLinks((previous) => ({ ...previous, [link.shapeId]: link }));
          return;
        }
        const removal = agentUnlinkFrom(payload);
        if (removal !== null) dropAgentLink(removal.shapeId);
      },
      [dropAgentLink],
    ),
  );

  // The shape whose spawn is in flight, so the button can say so and a second
  // click cannot spawn a second thread for the same note.
  const [pendingShapeId, setPendingShapeId] = useState<string | null>(null);
  const runNote = useCallback((shapeId: string, text: string) => {
    setPendingShapeId(shapeId);
    rpcRef.current
      .call("canvas_run_note", { shapeId, text })
      .then((link) => {
        setAgentLinks((previous) => ({ ...previous, [link.shapeId]: link }));
      })
      .catch((cause: unknown) => {
        // A toast rather than the panel's error banner: the banner is about the
        // canvas CONNECTION being broken, and a refused spawn (no project, a
        // provider that will not start) leaves the canvas perfectly healthy.
        toast.error(
          `Could not run this note: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      })
      .finally(() => setPendingShapeId(null));
  }, []);

  /**
   * Break a note's link to its thread. Optimistic: the badge goes on click
   * rather than on the round trip, because the backend's broadcast is what
   * every OTHER tab reacts to and waiting for it here would leave the tab that
   * pressed the button as the last one still showing the badge.
   *
   * A failure puts it back — `canvas_agents` is the room's own answer, so the
   * refresh restores the badge if and only if the link really is still there.
   */
  const unlinkNote = useCallback(
    (shapeId: string) => {
      dropAgentLink(shapeId);
      rpcRef.current.call("canvas_unlink_agent", { shapeId }).catch((cause: unknown) => {
        toast.error(
          `Could not unlink this note: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        refreshAgents();
      });
    },
    [dropAgentLink, refreshAgents],
  );

  /**
   * Bind a shape to a thread that already exists in bb — the attach arm.
   *
   * NOT OPTIMISTIC, unlike `unlinkNote` above, and the asymmetry is the point:
   * an unlink is certain to succeed locally (the worst case is a badge that
   * comes back), whereas an attach can be REFUSED by the backend — the thread
   * may be archived, in another project, or already on another shape
   * (canvas/agent-attach.ts). Painting a badge before the verdict would show a
   * link the room does not have, on exactly the paths where the answer is no.
   */
  const attachThread = useCallback((shapeId: string, threadId: string) => {
    rpcRef.current
      .call("canvas_attach_thread", { shapeId, threadId })
      .then((link) => {
        setAgentLinks((previous) => ({ ...previous, [link.shapeId]: link }));
      })
      .catch((cause: unknown) => {
        // A toast, for the same reason a refused spawn gets one: the canvas
        // connection is perfectly healthy, so the error banner would be lying.
        toast.error(
          `Could not attach this shape: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      });
  }, []);

  /** The picker's offer. Fetched per open rather than cached: which threads
   * exist, and which are already spoken for, both change while the panel is
   * open, and a stale list would offer a thread whose attach is now refused. */
  const loadThreadOptions = useCallback(
    () =>
      rpcRef.current
        .call("canvas_thread_options", null)
        .then((result) => result.options),
    [],
  );

  const makeTransport = useCallback(
    (): BbTransport =>
      createBbTransport({
        clientId,
        sendFrame: (payload) => rpcRef.current.call("canvas_frame", payload),
        onError: (cause) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
      }),
    [clientId],
  );

  // One resync at a time. Several triggers can fire at once for one underlying
  // event (a plugin reload publishes a hello AND answers the next ping with
  // connected:false), and overlapping resyncs would each mint a transport and
  // each call reconnect(), leaving the peer wired to whichever landed last
  // while inbound frames went to another.
  const resyncInFlight = useRef(false);

  /**
   * Re-establish this panel's half of the connection on a live session: a
   * fresh transport, a fresh join, and peer.reconnect — which re-arms ready()
   * and pushes our full history, so both directions resynchronize. Used by
   * everything that invalidates the connection without unmounting us: a
   * realtime socket that dropped and came back, a plugin reload that threw away
   * the server-side transport, and the server telling us directly that it does
   * not have us (a CanvasResync push, or a ping answered `connected: false`).
   */
  const resync = useCallback(
    (reason: string) => {
      const current = sessionRef.current;
      // No session yet means boot is still in flight and will do this itself.
      if (current === null) return;
      if (resyncInFlight.current) return;
      resyncInFlight.current = true;
      const transport = makeTransport();
      rpcRef.current
        // The name goes up on EVERY join, not just the first: a plugin reload
        // takes the room's whole identity map with it, and re-joining is the
        // only thing that puts this client back in it.
        .call("canvas_join", joinInput(clientId, selfNameRef.current))
        .then(() => {
          // The panel may have unmounted while the join was in flight.
          if (sessionRef.current !== current) {
            transport.close();
            return;
          }
          // Swap only once the join succeeded, so a failed one leaves inbound
          // frames going to the transport the peer is still actually using.
          transportRef.current = transport;
          // reconnect() closes the old transport, re-arms ready(), and pushes
          // our full history back up.
          current.peer.reconnect(transport);
          setError(null);
        })
        .catch((cause) => {
          setError(
            `${reason}: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        })
        .finally(() => {
          resyncInFlight.current = false;
        });
    },
    [clientId, makeTransport],
  );

  // The epoch of the last server hello acted on, so a re-delivered hello (or
  // this panel's own boot-time one) does not trigger a redundant resync.
  const lastHelloRef = useRef<number | null>(null);

  // Every server -> client frame arrives here: realtime is broadcast-only, so
  // this sees every client's envelopes and keeps only its own. Declared BEFORE
  // the boot effect so the subscription is live by the time the first frame
  // goes out — the server's SyncDone reply comes back through this channel,
  // and a missed one would leave ready() hanging until the cap.
  const onRealtime = useCallback(
    (payload: unknown) => {
      const epoch = serverHelloEpoch(payload);
      if (epoch !== null) {
        if (lastHelloRef.current === epoch) return;
        lastHelloRef.current = epoch;
        resync("canvas server restarted");
        return;
      }
      // "You are not in my client set" — the room saw a frame from a clientId
      // it had already dropped (idle sweep, or a reload it replaced). It
      // auto-joined us, but only a real handshake refetches what we missed.
      if (isResyncFor(clientId, payload)) {
        resync("canvas session was dropped");
        return;
      }
      // Who is in the room. Broadcast unaddressed (everyone needs every name)
      // and replaces the map wholesale — it is always the room's full truth.
      const names = identitiesFrom(payload);
      if (names !== null) {
        setIdentities(names);
        return;
      }
      const bytes = envelopeBytesFor(clientId, payload);
      if (bytes !== null) transportRef.current?.deliver(bytes);
    },
    [clientId, resync],
  );
  useRealtime(CANVAS_CHANNEL, onRealtime);

  // Keepalive. Two jobs, both about a tab nobody is touching: it keeps the
  // room's idle sweep from evicting a live viewer, and — should this panel ever
  // find itself dropped anyway (a reload whose hello we missed, a sweep that
  // beat the first ping) — `connected: false` is how it finds out, instead of
  // rendering a frozen document forever. Runs for the whole mount, not just
  // once a session exists: resync is a no-op before boot finishes, and the join
  // boot performs is what the first ping confirms.
  useEffect(() => {
    const id = setInterval(() => {
      rpcRef.current
        .call("canvas_ping", { clientId })
        .then(({ connected }) => {
          if (!connected) resync("canvas session expired");
        })
        // A failed ping is not itself evidence of anything — the next one, or
        // the realtime connection banner, covers a genuinely broken server.
        .catch(() => {});
    }, KEEPALIVE_MS);
    return () => clearInterval(id);
  }, [clientId, resync]);

  useEffect(() => {
    let cancelled = false;

    async function boot(): Promise<void> {
      // Identity FIRST, so this client's very first join already carries its
      // name and peers never see it as an unlabelled stranger. fetchIdentity
      // never rejects — worst case it resolves to an anonymous local name — so
      // this cannot wedge the boot.
      const identity = await fetchIdentity();
      if (cancelled) return;
      selfNameRef.current = identity.name;
      setSelfName(identity.name);

      const transport = makeTransport();
      transportRef.current = transport;
      await rpcRef.current.call("canvas_join", joinInput(clientId, identity.name));
      if (cancelled) {
        transport.close();
        return;
      }
      const presenceStore = new PresenceStore(clientId);
      const peer = new SyncClientPeer({
        peerId: newPeerId(),
        transport,
        presence: presenceStore,
      });
      await Promise.race([peer.ready(), delay(READY_TIMEOUT_MS)]);
      if (cancelled) {
        presenceStore.destroy();
        peer.close();
        return;
      }
      // THROUGH resolvePageId, not around it: canvas/page.ts already owns
      // "adopt the requested page iff it names a live one, else fall back",
      // and a stale bookmark landing on an empty canvas is indistinguishable
      // from data loss to the person looking at it.
      const pageId = resolvePageId(peer.doc, pageIdFromSubPath(subPathRef.current));
      const editor = new Editor({
        doc: peer.doc,
        now: () => performance.now(),
        random: cryptoRandom,
        pageId,
      });
      const toolContext = createToolContext(editor);
      registerCoreShapes();
      const next: Session = {
        peer,
        editor,
        toolContext,
        tools: createToolSet(toolContext),
        presenceStore,
        presencePublisher: createPresencePublisher(presenceStore),
        selfKey: clientId,
      };
      sessionRef.current = next;
      setSession(next);
    }

    boot().catch((cause) => {
      if (cancelled) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    });

    return () => {
      cancelled = true;
      const current = sessionRef.current;
      sessionRef.current = null;
      setSession(null);
      if (current) {
        current.toolContext.dispose();
        // Before peer.close(): a pending trailing presence flush would
        // otherwise publish through a peer that is already gone.
        current.presencePublisher.dispose();
        current.peer.close();
        current.presenceStore.destroy();
      }
      transportRef.current?.close();
      transportRef.current = null;
      // Fire-and-forget: the panel is already gone, and the backend sweeps an
      // idle client anyway if this never lands.
      void rpcRef.current.call("canvas_leave", { clientId }).catch(() => {});
    };
  }, [clientId, makeTransport]);

  // Realtime signals are ephemeral and never replayed, so a socket that went
  // away and came back has silently dropped whatever the server published in
  // between. Only on the transition BACK to connected: the first connect is
  // what the boot effect already handled.
  const connectionState = useRealtimeConnectionState();
  const previousConnectionState = useRef(connectionState);
  useEffect(() => {
    const previous = previousConnectionState.current;
    previousConnectionState.current = connectionState;
    if (connectionState !== "connected" || previous !== "reconnecting") return;
    resync("canvas reconnect");
    // Same reasoning, for the other half of what rides realtime: every agent
    // status published while the socket was away is gone, so re-read the
    // authoritative set rather than trusting badges frozen at the last one we
    // happened to see.
    refreshAgents();
  }, [connectionState, resync, refreshAgents]);

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      {error === null ? null : (
        <div
          role="alert"
          className="border-b border-border bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
        >
          {error}
        </div>
      )}
      {connectionState === "connected" ? null : (
        <div className="border-b border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
          {connectionState === "connecting"
            ? "Connecting to bb…"
            : "Connection lost — reconnecting…"}
        </div>
      )}
      {session === null ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Opening canvas…
        </div>
      ) : (
        <CanvasSession
          session={session}
          subPath={subPath}
          identities={identities}
          selfName={selfName}
          agentLinks={agentLinks}
          pendingShapeId={pendingShapeId}
          onRunNote={runNote}
          onUnlinkNote={unlinkNote}
          onAttachThread={attachThread}
          loadThreadOptions={loadThreadOptions}
        />
      )}
    </div>
  );
}

function CanvasSession({
  session,
  subPath,
  identities,
  selfName,
  agentLinks,
  pendingShapeId,
  onRunNote,
  onUnlinkNote,
  onAttachThread,
  loadThreadOptions,
}: {
  readonly session: Session;
  /** bb's route remainder for this panel — which page the URL names. See the
   * "THE PAGE IS IN THE ROUTE" note at the top of this file. */
  readonly subPath: string;
  /** clientId -> display name, from the room's broadcast. */
  readonly identities: Readonly<Record<string, string>>;
  /** This client's own name, or null until the identity fetch has landed. */
  readonly selfName: string | null;
  /** shape id -> its agent thread and that thread's live status. */
  readonly agentLinks: Readonly<Record<string, CanvasAgentLink>>;
  /** The shape whose spawn is in flight, if any. */
  readonly pendingShapeId: string | null;
  /** Spawn an agent thread for `shapeId` on `text`. */
  readonly onRunNote: (shapeId: string, text: string) => void;
  /** Drop `shapeId`'s link. The thread itself is left alone. */
  readonly onUnlinkNote: (shapeId: string) => void;
  /** Bind `shapeId` to a thread that already exists in bb. */
  readonly onAttachThread: (shapeId: string, threadId: string) => void;
  /** The threads the attach picker may offer. */
  readonly loadThreadOptions: () => Promise<ThreadOption[]>;
}) {
  const { editor, toolContext, tools, presenceStore, presencePublisher, selfKey } =
    session;
  const editorState = useEditorState(editor);
  const snapshot = useDocSnapshot(toolContext);

  const [activeToolId, setActiveToolId] = useState<ToolId>("select");
  const activeToolIdRef = useRef(activeToolId);
  activeToolIdRef.current = activeToolId;

  const [toolStates, setToolStates] = useState<ToolStates>(() =>
    createInitialToolStates(tools),
  );
  const toolStatesRef = useRef(toolStates);
  toolStatesRef.current = toolStates;

  const panelRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState<ViewportSize>({
    width: 1024,
    height: 768,
  });
  const viewportSizeRef = useRef(viewportSize);
  viewportSizeRef.current = viewportSize;

  // THE SAME ELEMENT, MEASURED HONESTLY, and a second state rather than a
  // second reader of the first one. `viewportSize` above starts at 1024x768 and
  // substitutes 1024/768 for a zero read, deliberately: it feeds shape CULLING,
  // and culling against a zero rect culls the whole document, so a plausible
  // guess is better than nothing there. It is not better than nothing here.
  // canvas/pages/page-tabs-fit.ts's contract is "0 means nothing has been
  // measured yet, so draw no row" — its stated safety property is that a
  // phone-width panel never gets a tab bar flashed onto it — and handing it a
  // fabricated 1024 answers "wide enough" on the first render of every panel,
  // however narrow. So the gate gets the raw number, 0 and all.
  const [columnWidth, setColumnWidth] = useState(0);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    // Measure synchronously as well as observing: a real browser's first
    // ResizeObserver callback can lag a frame, and until it lands every shape
    // is culled against a stale rect.
    setColumnWidth(element.clientWidth);
    setViewportSize({
      width: element.clientWidth || 1024,
      height: element.clientHeight || 768,
    });
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setColumnWidth(entry.contentRect.width);
      setViewportSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Remote cursors: poll the presence map (see PRESENCE_POLL_MS).
  const [presenceTick, setPresenceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setPresenceTick((tick) => tick + 1), PRESENCE_POLL_MS);
    return () => clearInterval(id);
  }, []);
  const presenceAll = useMemo(
    () => presenceStore.all(),
    // presenceTick is the whole point: `all()` is a live map read with no
    // change notification of its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [presenceStore, presenceTick],
  );
  const remotePresence = useMemo(
    () => adaptPresence(presenceAll, identities),
    [presenceAll, identities],
  );

  // THE ROSTER, published to the panel bus for BB's title bar to render (see
  // canvas/panel-bus.ts: headerContent mounts outside this component's tree, so
  // props cannot reach it). Membership comes from the room's identity
  // broadcast; presence only decides whether an avatar has a cursor to jump to
  // — and that question is page-scoped (design doc D-4), which is what the
  // current page is doing here: a peer whose cursor this view no longer draws
  // must not be offered as a place to fly to. The rule is canvas/roster.ts's.
  const roster = useMemo(
    () =>
      buildRoster(
        identities,
        presenceAll,
        selfKey,
        selfName,
        editorState.currentPageId,
      ),
    [identities, presenceAll, selfKey, selfName, editorState.currentPageId],
  );
  useEffect(() => {
    canvasBus.setRoster(roster);
  }, [roster]);
  useEffect(() => () => canvasBus.clearRoster(), []);

  // Audio state flows the other way: av-room.ts writes it into the same bus and
  // this reads it back, because a speaking ring belongs on the CURSOR as well
  // as on the header avatar.
  const av = useSyncExternalStore(
    canvasBus.subscribe,
    canvasBus.snapshot,
    canvasBus.snapshot,
  ).av;

  // Header -> body: clicking an avatar flies the camera to that person.
  //
  // Both inputs are read AT CLICK TIME, not from the render the header painted
  // from — the roster is a presence-poll behind, so jumping to where somebody
  // was 150ms ago is the wrong answer for a moving pointer, and the page can
  // have changed since this handler was registered (it re-registers only when
  // identities change, and the header lives outside this component's tree, so
  // the click can arrive on a page the closure never saw). Hence the ref,
  // which follows viewportSizeRef's pattern above.
  //
  // WHETHER the jump is honest at all is canvas/roster.ts's `panIntentFor` —
  // the same call `buildRoster` uses for `hasCursor`, so the avatar the dock
  // draws enabled is exactly the avatar whose click lands somewhere. Zoom is
  // preserved: the click means "show me where they are", not "and change how
  // far in I am".
  const currentPageIdRef = useRef(editorState.currentPageId);
  currentPageIdRef.current = editorState.currentPageId;
  useEffect(
    () =>
      canvasBus.setPanHandler((clientId) => {
        const intent = panIntentFor(
          presenceStore.all()[clientId],
          identities[clientId],
          currentPageIdRef.current,
        );
        if (intent.kind === "refuse") {
          // Reachable despite the header disabling these avatars: presence
          // entries expire and peers change page between render and click.
          toast.message(intent.message);
          return;
        }
        const { z } = editor.get().camera;
        editor.apply({
          type: "SetCamera",
          ...cameraCenteredOn(intent.point, viewportSizeRef.current, z),
        });
      }),
    [editor, presenceStore, identities],
  );

  // WHICH PAGE THIS PEER IS ON, published to everyone else (design doc D-4).
  //
  // Keyed on the page rather than folded into the viewport publish below, so a
  // SWITCH goes out the moment it happens instead of waiting for the next
  // pointer move — somebody who changes page and then sits still would
  // otherwise stay advertised on the page they left, and every peer there
  // would keep drawing their cursor. Whether that write is owed at all, and
  // what "unknown" looks like on the wire, are canvas/pages/page-presence.ts's
  // (via the publisher); this effect only says when to ask.
  //
  // DECLARED BEFORE the viewport publish deliberately: effects run in order,
  // so the very first presence write this panel makes already names the page,
  // and the viewport write that follows is absorbed by the publisher's
  // throttle into one trailing flush rather than being a second immediate hit
  // on the wire.
  useEffect(() => {
    presencePublisher.setPage(editorState.currentPageId);
  }, [presencePublisher, editorState.currentPageId]);

  // Publish this peer's viewport on every editor-state change. editor.subscribe
  // fires for ANY EditorState change, not just SetCamera, so this republishes a
  // little more often than strictly necessary; the publisher's throttle absorbs
  // that. The same write re-derives the world cursor from the last screen point
  // — a wheel pan with a stationary mouse moves the world point under an
  // unmoved cursor, and peers would otherwise see it frozen.
  useEffect(() => {
    const publish = () => {
      const { camera } = editor.get();
      const size = viewportSizeRef.current;
      presencePublisher.setViewport(
        { x: camera.x, y: camera.y, z: camera.z, w: size.width, h: size.height },
        camera,
      );
    };
    publish();
    return editor.subscribe(publish);
  }, [editor, presencePublisher]);

  const cancelAndReset = useCallback(() => {
    const { states, intents } = cancelActiveTool(
      tools,
      toolStatesRef.current,
      activeToolIdRef.current,
      editor,
    );
    if (intents.length > 0) editor.applyAll(intents);
    toolStatesRef.current = states;
    setToolStates(states);
  }, [editor, tools]);

  // THE single source of truth for "which keys are app shortcuts and what each
  // does". Both keydown entry points call it — Viewport's own onKeyDown for a
  // viewport-focused keydown, and the panel-level fallback below for a keydown
  // delivered to a focused toolbar button (a DOM sibling, whose keydown never
  // bubbles into Viewport). Returns true iff it CONSUMED the event.
  //
  // The editingId gate lives here so it can never diverge: while a shape is
  // being text-edited, TextEditor's textarea owns Escape (ends editing) and
  // Delete/Backspace (edits the character), and neither stops propagation — so
  // this policy must fully defer rather than cancel a gesture or delete the
  // shape out from under the user.
  const handleGlobalShortcut = useCallback(
    (event: KeyInputEvent, editingId: string | null): boolean => {
      if (editingId !== null) return false;
      if (event.key === "Escape") {
        cancelAndReset();
        return true;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        const intents = deleteSelectionIntents(editor);
        if (intents.length > 0) editor.applyAll(intents);
        // Consumed even on an empty selection: it is still an app shortcut
        // handled here, never forwarded to a tool.
        return true;
      }
      // Undo/redo. Lower-cased because a real browser reports the shifted
      // letter's case differently across platforms. Ctrl+Y is the Windows redo
      // convention; Cmd+Y is Safari's "Show All History", so the y branch
      // requires ctrl specifically. Mac users get redo via Cmd+Shift+Z.
      const key = event.key.toLowerCase();
      const withModifier = event.modifiers.ctrl || event.modifiers.meta;
      // BOTH BRANCHES REPAIR, and they repair the same two things: a selection
      // naming shapes the history move removed, and a currentPageId naming a
      // page it removed (design doc R-1 — the render filter would then paint
      // NOTHING).
      //
      // THE MOVE AND ITS REPAIR ARE ONE CALL, in canvas/pages/history-repair.ts,
      // rather than three lines of sequencing written twice here. This panel
      // spelled it out until 2026-09-05, and mutation showed what that cost:
      // deleting the repair from EITHER branch typechecked and left the whole
      // suite green, because the behavioural test was driving its own copy of
      // these lines rather than the panel's. There is no jsdom here to catch
      // it; the composition being a named function is what lets a test reach
      // it at all.
      if (withModifier && key === "z" && !event.modifiers.shift) {
        undoWithRepair(editor);
        return true;
      }
      if (
        (withModifier && key === "z" && event.modifiers.shift) ||
        (event.modifiers.ctrl && key === "y")
      ) {
        redoWithRepair(editor);
        return true;
      }
      return false;
    },
    [editor, cancelAndReset],
  );

  const handleInput = useCallback(
    (event: InputEvent) => {
      if (event.type === "pointermove") {
        // Unconditional, not tool-gated — mirrors wheel's own
        // handled-uniformly policy just below.
        presencePublisher.setCursorFromScreen(
          { x: event.x, y: event.y },
          editor.get().camera,
        );
      }
      if (event.type === "wheel") {
        // Wheel is handled uniformly regardless of the active tool: zoom and
        // pan must work whichever button is pressed.
        const next = applyWheel(editor.get().camera, event);
        editor.apply({ type: "SetCamera", ...next });
        return;
      }
      if (
        event.type === "keydown" &&
        handleGlobalShortcut(event, editor.get().editingId)
      ) {
        return;
      }
      const next = dispatchToActiveTool(
        tools,
        toolStatesRef.current,
        activeToolIdRef.current,
        editor,
        event,
      );
      toolStatesRef.current = next;
      setToolStates(next);
    },
    [editor, tools, presencePublisher, handleGlobalShortcut],
  );
  const handleInputRef = useRef(handleInput);
  handleInputRef.current = handleInput;

  const selectTool = useCallback(
    (id: ToolId) => {
      // A toolbar click mid-drag is the same abandonment case blur covers,
      // just triggered explicitly — cancel the tool being LEFT first.
      cancelAndReset();
      setActiveToolId(id);
    },
    [cancelAndReset],
  );

  // Keyboard fallback for a focused toolbar button. SCOPED TO THIS PANEL: the
  // listener bails unless the keydown's target is inside the panel root, so it
  // can never steal Delete or Escape from the rest of the bb app. It also bails
  // when the target is already inside the viewport (Viewport's own onKeyDown
  // handled it — letting it through here too would fire every shortcut twice).
  useEffect(() => {
    function handleKeydown(event: KeyboardEvent): void {
      const panel = panelRef.current;
      const viewport = viewportRef.current;
      if (!panel) return;
      const target = event.target as Node | null;
      if (!target || !panel.contains(target)) return;
      if (viewport && viewport.contains(target)) return;
      if (isEditableTarget(target)) return;
      handleGlobalShortcut(
        {
          type: "keydown",
          key: event.key,
          modifiers: {
            shift: event.shiftKey,
            alt: event.altKey,
            ctrl: event.ctrlKey,
            meta: event.metaKey,
          },
          t: event.timeStamp,
        },
        editor.get().editingId,
      );
    }
    document.addEventListener("keydown", handleKeydown);
    return () => document.removeEventListener("keydown", handleKeydown);
  }, [editor, handleGlobalShortcut]);

  // Debug hook, mirroring the EnsembleWorks client's own `window.__ew`: lets a
  // browser-driving agent read editor/doc state (and drive input) without
  // reverse-engineering it from the DOM. Spike-only; nothing in the UI reads it.
  //
  // OPT-IN, because this bundle loads in every bb window: an always-on global
  // handle to a live editor is more surface than a debugging convenience is
  // worth. Turn it on per-tab with `?canvasDebug=1`, or persistently with
  // localStorage `canvas.debug = "1"`.
  useEffect(() => {
    if (!canvasDebugEnabled()) return;
    const globalWindow = window as unknown as {
      __canvas?: {
        editor: Editor;
        toolContext: ToolContext;
        presence: PresenceStore;
        input: (event: InputEvent) => void;
        bus: typeof canvasBus;
      };
    };
    globalWindow.__canvas = {
      editor,
      toolContext,
      presence: presenceStore,
      input: (event) => handleInputRef.current(event),
      // The roster/audio seam. Exposed for the same reason `input` is: the
      // header renders in BB's title bar from this store, so driving it is how
      // a browser-driving agent exercises the live-audio states (`bus.setAv({
      // status: "live", speaking: ["alice"] })`) without a LiveKit server.
      bus: canvasBus,
    };
    return () => {
      delete globalWindow.__canvas;
    };
  }, [editor, toolContext, presenceStore]);

  // Read the note's prompt at CLICK time, from the live document, and hand it
  // to the backend. The text is read here rather than server-side deliberately:
  // the backend holds the same document, but "what the user is looking at" is a
  // client fact, and resolving it here keeps the rpc a plain (shapeId, text)
  // pair instead of a second text-resolution policy that could disagree.
  const handleRunNote = useCallback(
    (shapeId: string) => {
      const text = promptTextFor(
        snapshot.byId.get(shapeId),
        editor.doc.getText(shapeId),
      );
      if (text.length === 0) {
        toast.error("This note is empty — type a prompt into it first.");
        return;
      }
      onRunNote(shapeId, text);
    },
    [editor, snapshot, onRunNote],
  );

  const dispatch = useCallback(
    (intents: Intent[]) => editor.applyAll(intents),
    [editor],
  );
  const handleTextChange = useCallback(
    (id: string, text: string) => editor.apply({ type: "SetText", id, text }),
    [editor],
  );
  const handleEndEdit = useCallback(() => editor.apply({ type: "EndEdit" }), [editor]);

  // ---- the page in the URL (design doc D-3) -------------------------------
  //
  // Two arrows into one fact: the URL drives `currentPageId` (a deep link, a
  // Back press) and switching pages drives the URL. WHICH ONE MOVED is not
  // visible from the values — "they differ" is true either way — so the
  // arbitration, the loop safety and the push-vs-replace call all live in
  // canvas/pages/page-route.ts. The ACTING is there too, behind two ports,
  // because an `if` written here would be a branch no test in this jsdom-free
  // project could watch — which is exactly how a review deleted the whole
  // URL-drives-the-editor arm from this file and saw the suite stay green.
  //
  // THE PORT BODIES AND THE THREE INPUTS BELOW ARE STILL WRITTEN HERE, and
  // nothing at runtime watches them either: mutation on 2026-09-05 emptied
  // `apply` to `() => {}`, blanked `livePageIds` to `[]`, and passed
  // `subPath: null`, one at a time — each left `npx tsc --noEmit` at exit 0
  // and the whole suite at 39 files / 868 tests passed while killing
  // Back/Forward, deep links, or both. So each of them is now pinned, bounded
  // to this call's own argument list, by tests/page-route.test.ts's "the panel
  // is wired to the route". Change a line here and that file has to agree;
  // that is the only thing standing behind these five lines.
  //
  // It re-runs on every doc change, because `snapshot.pages` is a fresh array
  // each time. That is deliberately not optimised away: the decision is a few
  // string comparisons, and a memo keyed on a derived page-id list would be
  // one more thing to keep true.
  //
  // The router REMEMBERS what it last reconciled, and that memory used to be a
  // ref here, threaded out of the call and back into the next one. Mutation on
  // 2026-09-05 showed the thread was unguarded — passing `settled: null`, and
  // separately dropping the store, each typechecked and left the whole suite
  // green while breaking every page switch (the effect would re-adopt the URL
  // and snap the canvas back). So the memory is inside `createPageRouter` now
  // and this file has no `settled` to get wrong.
  //
  // HELD IN A REF, not a useMemo: React is free to discard a memoised value and
  // recompute it, and a router recomputed mid-life would forget what it
  // reconciled — i.e. behave exactly like the mutation above. `??=` is the
  // documented lazy-ref idiom; it constructs once and decides nothing.
  const navigate = useBbNavigate();
  const pageRouterRef = useRef<PageRouter | null>(null);
  pageRouterRef.current ??= createPageRouter();
  const pageRouter = pageRouterRef.current;
  useEffect(() => {
    pageRouter.reconcile(
      {
        subPath,
        currentPageId: editorState.currentPageId,
        livePageIds: snapshot.pages.map((page) => page.id),
      },
      {
        apply: (intent) => editor.apply(intent),
        navigate,
      },
    );
  }, [pageRouter, editor, navigate, subPath, editorState.currentPageId, snapshot.pages]);

  // ---- what the tab is called (design doc D-5) ----------------------------
  //
  // `document.title` is a WIRE FIELD in this plugin: the presence strip reads
  // its own on every roster poll and sends it as `LocationReport.title`
  // (canvas/dock/dock.ts's `selfReport`), which is the only route by which a
  // page's NAME reaches another person's dock — the path carries an id. So
  // what to write, and when to hand the title back, are decisions, and they
  // are canvas/pages/page-title.ts's.
  //
  // The original is captured on the first render of this component, which is
  // the last moment it is still bb's own.
  //
  // The two `document.title` references below are the ONLY ones in this file,
  // and both are inside this adapter — reading and writing are hands, the
  // rules are canvas/pages/page-title.ts's.
  //
  // The ARGUMENTS to the sync call are pinned the same way the route call's
  // are, and for the same reason: `pages: []` there typechecked and left the
  // whole suite green on 2026-09-05 while the page name stopped reaching
  // `document.title` — i.e. stopped reaching every other person's dock, which
  // is the only thing this title is for. See tests/page-title.test.ts's "the
  // panel is wired to the title".
  const titleHost = useMemo<DocumentTitleHost>(
    () => ({
      read: () => document.title,
      write: (title) => {
        document.title = title;
      },
    }),
    [],
  );
  // BOTH REMEMBERED VALUES — bb's own title, and the last title this panel
  // wrote — are inside the controller. They were two refs here, threaded out of
  // the sync effect and into the unmount cleanup, and mutation on 2026-09-05
  // showed neither end was guarded: dropping the `wrote` store, and separately
  // seeding the original with `useRef("")`, each typechecked and left the whole
  // suite green while silently deleting the restore. Constructing the
  // controller is also what captures bb's title, at the first render — the last
  // moment it is still bb's.
  //
  // HELD IN A REF for the same reason the router above is: React may discard a
  // memoised value, and a controller rebuilt mid-life would re-read `original`
  // from a title THIS PANEL wrote, so the restore would put the page name back
  // instead of bb's.
  const pageTitleRef = useRef<PageDocumentTitle | null>(null);
  pageTitleRef.current ??= createPageDocumentTitle(titleHost);
  const pageTitle = pageTitleRef.current;
  useEffect(() => {
    pageTitle.sync({
      pages: snapshot.pages,
      currentPageId: editorState.currentPageId,
    });
  }, [pageTitle, snapshot.pages, editorState.currentPageId]);

  // Restore on unmount — its own effect, depending only on the controller
  // (which is ref-held and so never changes), so a page change can never run
  // it. A canvas page name left behind after you navigate away is published to
  // everybody else on the next 2s roster poll, from a tab that is no longer on
  // the canvas at all.
  useEffect(() => () => pageTitle.restore(), [pageTitle]);

  // Multi-page (design doc D-2). Everything this decides — the row model, the
  // filter, the open/closed machine, whether the tab bar is wide enough to be
  // worth its row — is in canvas/pages/, unit-tested without a DOM; the hook
  // hands back the two nodes and the panel only places them. `columnWidth` is
  // the CANVAS COLUMN's raw measured width (the ResizeObserver above), which is
  // the width the tab bar would have to fit in — and raw rather than
  // `viewportSize.width` for the reason written where it is declared: a
  // culling fallback must never be the reason a row appears.
  const pageSwitcher = usePageSwitcher({
    editor,
    snapshot,
    currentPageId: editorState.currentPageId,
    containerWidth: columnWidth,
  });


  return (
    // A ROW WITH ONE CHILD, as of 2026-09-08. It held two: the canvas column
    // and a <ThreadAside>, and the row existed so opening a thread genuinely
    // NARROWED the canvas (its ResizeObserver saw the new width, so culling and
    // cursor coordinates stayed correct) instead of half the drawing surface
    // disappearing under a floating panel. The aside is gone — opening a thread
    // now leaves the plugin for bb's own thread window — so the row is doing
    // nothing a column would not, and is kept only because panelRef hangs off
    // it: the keyboard fallback below scopes itself to the panel ROOT, so a
    // shortcut typed with a toolbar button focused still reaches it.
    <div ref={panelRef} className="flex h-full min-h-0 w-full flex-row">
      {/* The canvas COLUMN. `relative` because it is the containing block for
          the floating chrome below: the chrome has to hang off the column
          rather than off the viewport element, since a keyboard shortcut typed
          with a TOOL BUTTON focused is dispatched by the panel-level fallback,
          which deliberately bails when the target is inside `viewportRef`
          (Viewport's own onKeyDown would already have handled it). Put the bar
          inside that box and every shortcut typed from a focused tool button
          would be swallowed by both. */}
      <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
        {/* The page tabs, first in the column so they sit where the old control
            bar did, with the canvas directly beneath them — that adjacency is
            what makes the current tab read as attached to what it shows.
            Still width-gated exactly as before (canvas/pages/page-tabs-fit.ts)
            — `null` on a narrow column, and then this row draws nothing and
            costs no height.

            NO FEEDBACK LOOP, and this is why the gate stays safe here: the
            ResizeObserver watches `data-canvas-viewport`, and showing this row
            changes that box's HEIGHT while the gate reads its WIDTH. Inferred
            from the flex layout, not observed — there is no browser here. */}
        <div data-canvas-page-tab-row style={chromeTabRowStyle}>
          {pageSwitcher.tabs}
        </div>
        {/* The canvas is a DOCUMENT SURFACE, so its own paper color is
            canvas-owned rather than a host token; the chrome around it above is
            host-tokened. Grid dots read --canvas-grid-dot with a neutral
            fallback, so they work over either. */}
        <div
          ref={viewportRef}
          data-canvas-viewport
          className="relative min-h-0 flex-1"
          style={{ background: "var(--canvas-paper, #fafaf7)" }}
        >
          <Viewport
            onInput={handleInput}
            onViewportBlur={cancelAndReset}
            onPointerCancel={cancelAndReset}
            style={{ position: "absolute", inset: 0 }}
          >
            <Grid camera={editorState.camera} />
            <WorldLayer camera={editorState.camera}>
              <ShapeLayer
                toolContext={toolContext}
                camera={editorState.camera}
                viewportSize={viewportSize}
                dispatch={dispatch}
              />
              <TextEditor
                toolContext={toolContext}
                onTextChange={handleTextChange}
                onEndEdit={handleEndEdit}
              />
            </WorldLayer>
            <Overlay
              editorState={editorState}
              snapshot={snapshot}
              camera={editorState.camera}
              viewportSize={viewportSize}
              index={toolContext.index()}
              snapResult={currentSnapResult(toolStates, activeToolId)}
            />
            {/* Painted last, so nothing occludes a collaborator's cursor
                (Viewport's stacking contract: later DOM siblings paint over
                earlier ones). */}
            <Cursors
              presence={remotePresence}
              selfKey={selfKey}
              camera={editorState.camera}
              viewportSize={viewportSize}
              // D-4's reading half. Omitting this prop is not "no page" — it
              // is "this caller is not page-aware", and the filter then does
              // nothing at all, which is how a peer on another page kept
              // being drawn here. The hiding rule itself is canvas-react's
              // `isOnOtherPage`; this only says which page is local.
              currentPageId={editorState.currentPageId}
            />
          </Viewport>
          {/* Plugin chrome, OUTSIDE <Viewport> and after it: a later sibling in
              the same stacking context paints over it, and being outside the
              viewport's subtree means a click on a badge or the run button is
              never also a canvas pointer gesture. */}
          <AgentLayer
            doc={snapshot}
            camera={editorState.camera}
            viewportSize={viewportSize}
            selection={editorState.selection}
            links={agentLinks}
            // The page filter for the AGENT chrome, and the same argument as
            // <Cursors> above: a link is keyed by shape id, every page's shapes
            // are in one document, so a badge with no page to check against
            // outlives the page switch that hid its note. Owner report,
            // 2026-09-08.
            currentPageId={editorState.currentPageId}
            pendingShapeId={pendingShapeId}
            onRun={handleRunNote}
            // STRAIGHT OUT OF THE PLUGIN. Owner request, 2026-09-08: open the
            // thread in bb's real thread window, not in a <ThreadChat> mounted
            // beside the canvas. bb owns the thread surface; the canvas only
            // says which thread.
            onOpen={(threadId) => navigate.toThread(threadId)}
            onUnlink={onUnlinkNote}
            onAttach={onAttachThread}
            loadThreadOptions={loadThreadOptions}
          />
          {/* Who is talking, drawn on their cursor. Same layering rules as the
              agent badges: a later sibling outside <Viewport>, pointer-events
              none, so it can never intercept a canvas gesture. */}
          <SpeakerRings
            presence={presenceAll}
            identities={identities}
            speaking={av.speaking}
            camera={editorState.camera}
            viewportSize={viewportSize}
            selfKey={selfKey}
            // Same reason as <Cursors> above, and it has to be BOTH: a ring is
            // drawn on a cursor, so page-scoping one overlay and not the other
            // leaves a talking peer from another page as a ring around
            // nothing.
            currentPageId={editorState.currentPageId}
          />
        </div>
        {/* THE FLOATING CHROME, docked bottom-centre over a full-bleed canvas.
            Owner request, 2026-09-05: "can we make the command palette
            something that floats over the canvas; perhaps docked at the
            bottom?" — and the page tabs came with it, so the drawing surface
            gets the whole column instead of the two rows of chrome that used
            to sit above it.

            WHAT THIS MOVED, MEASUREMENT-WISE. The ResizeObserver is unchanged
            and still observes the `data-canvas-viewport` element, so
            `columnWidth` (the tab-bar gate) and `viewportSize` (culling and
            cursor coordinates) come from the same box they always did. Its
            WIDTH is unchanged — the chrome rows were full-width flex siblings
            and took no width. Its HEIGHT grows by exactly the chrome that
            left, which is the point of the change: the viewport is now the
            whole column. INFERRED FROM THE FLEX LAYOUT AND THE OBSERVER'S
            TARGET, NOT OBSERVED — there is no browser in this spike.

            A SIBLING OF THE VIEWPORT BOX, NOT A CHILD OF IT, and absolutely
            positioned against the column: see the column's own comment on the
            keyboard fallback for why being inside `viewportRef` would be
            wrong. */}
        <div data-canvas-chrome-dock style={chromeWrapperStyle}>
          <div style={chromeCardColumnStyle}>
            <div style={chromeToolbarStyle}>
              {/* NO PAGES BUTTON. Owner request 2026-09-06: "Lets remove the
                  page selector from the control bar." The bar is the tools and
                  the self-name chip; pages live in the tab strip at the top of
                  the column, and each tab carries its own rename/delete context
                  menu (canvas/pages/page-tab-menu.ts).

                  THE POPOVER ITSELF STAYS — see {pageSwitcher.overlays} below.
                  It is still opened by the command palette's "Canvas: go to
                  page…", and it is the only KEYBOARD path to REORDERING now
                  that reordering is a pointer drag. */}
              {TOOL_BUTTONS.map((button) => (
                <button
                  key={button.id}
                  type="button"
                  data-canvas-tool={button.id}
                  aria-pressed={activeToolId === button.id}
                  onClick={() => selectTool(button.id)}
                  style={chromeToolStyle(activeToolId === button.id)}
                >
                  {button.label}
                </button>
              ))}
              {/* AND NOTHING ELSE. There used to be a self-name chip here —
                  your name in the colour peers see your cursor in — behind the
                  only width gate this bar had. Owner request, 2026-09-08:
                  "Please remove the presence icon from the control bar." The
                  gate went with it (canvas/pages/chrome-dock.ts says why), so
                  the bar is now the tools, unconditionally. */}
            </div>
          </div>
        </div>
        {/* THE PAGE SWITCHER'S <body> SURFACES — the Pages popover and a tab's
            context menu. Both are `createPortal`s onto <body>, so this renders
            nothing HERE and its position in the column is immaterial; what
            matters is that it is rendered UNCONDITIONALLY, outside the width
            gate the tab strip is behind. The popover is still reachable from
            bb's command palette on a column too narrow to draw a single tab —
            and, since Task 1 made reordering a pointer drag, its ◂ / ▸ buttons
            are the only way to reorder a page without a pointer. */}
        {pageSwitcher.overlays}
      </div>
    </div>
  );
}
