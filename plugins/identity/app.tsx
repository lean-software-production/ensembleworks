import "./identity.css";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  useBbContext,
  useComposerView,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  MachineList,
  PresenceLocation,
  PresentPerson,
  rpcContract,
  ThreadOwnership,
  WhoAmI,
} from "./server.js";
import { initials, presenceLabel } from "./presence-labels.js";
import {
  composerBanner,
  headerChip,
  ownershipRowStatus,
  readOnlyBanner,
} from "./ownership-labels.js";
import {
  readableInk,
  resolvePersonColor,
} from "./person-colors.js";
import {
  mountThreadStatusFallback,
  replaceThreadStatuses,
  type ThreadStatus,
} from "./sidebar-fallback.js";
import { IdentityPicker } from "./components/IdentityPicker.js";
import { IdentitySettings } from "./components/settings/IdentitySettings.js";

export { IdentityPicker };

const HEARTBEAT_MS = 10_000;
const REFRESH_MS = 5_000;
/** Ownership is durable, so it is polled far less often than presence. */
const OWNERSHIP_REFRESH_MS = 60_000;
const volatileIds = new Map<string, string>();
const IDENTITY_PROMPT_SESSION_KEY = "bb.identity.picker.prompted.v3";

function claimIdentityPrompt(): boolean {
  try {
    if (sessionStorage.getItem(IDENTITY_PROMPT_SESSION_KEY) !== null) return false;
    sessionStorage.setItem(IDENTITY_PROMPT_SESSION_KEY, "1");
    return true;
  } catch {
    if (volatileIds.has(IDENTITY_PROMPT_SESSION_KEY)) return false;
    volatileIds.set(IDENTITY_PROMPT_SESSION_KEY, "1");
    return true;
  }
}

function stableId(storage: Storage, key: string): string {
  const next = crypto.randomUUID();
  try {
    const current = storage.getItem(key);
    if (current !== null) return current;
    storage.setItem(key, next);
  } catch { /* Private or ephemeral WebViews may deny storage. */ }
  const existing = volatileIds.get(key);
  if (existing) return existing;
  volatileIds.set(key, next);
  return next;
}

function viewerId(): string {
  try { return stableId(localStorage, "bb-presence-viewer-id"); }
  catch { return volatileId("bb-presence-viewer-id"); }
}

function tabId(): string {
  try { return stableId(sessionStorage, "bb-presence-tab-id"); }
  catch { return volatileId("bb-presence-tab-id"); }
}

function volatileId(key: string): string {
  const existing = volatileIds.get(key);
  if (existing) return existing;
  const next = crypto.randomUUID();
  volatileIds.set(key, next);
  return next;
}

function PresenceCoordinator() {
  const rpc = useRpc<typeof rpcContract>();
  const context = useBbContext();
  const connection = useRealtimeConnectionState();
  const ownViewerId = useMemo(viewerId, []);
  const ownTabId = useMemo(tabId, []);
  const location: PresenceLocation = context.threadId
    ? { kind: "thread", threadId: context.threadId }
    : context.projectId
      ? { kind: "project", projectId: context.projectId }
      : { kind: "elsewhere" };
  const locationKey = location.kind === "thread"
    ? `thread:${location.threadId}`
    : location.kind === "project"
      ? `project:${location.projectId}`
      : "elsewhere";

  const heartbeat = useCallback(() => {
    if (document.visibilityState === "hidden") return;
    void rpc.call("presence_heartbeat", {
      tabId: ownTabId,
      viewerId: ownViewerId,
      location,
    }).catch(() => undefined);
  }, [locationKey, ownTabId, ownViewerId, rpc]);

  /**
   * The two glyph sources, kept apart and merged on every paint: PRESENCE WINS.
   * A thread someone is looking at (or typing in) shows that; every other row falls
   * back to who started it.
   */
  const ownershipRef = useRef(new Map<string, ThreadStatus>());
  // The directory, for dealing per-person colours. A ref, not state: it only ever feeds
  // the next paint, and a change of roster must not re-run the ownership fetch.
  const rosterRef = useRef<readonly string[]>([]);
  /** The colours people chose, so the badge and tint paint the override, not the deal. */
  const colorsRef = useRef<Readonly<Record<string, string>>>({});
  const presenceRef = useRef(new Map<string, ThreadStatus>());
  const paint = useCallback(() => {
    const merged = new Map(ownershipRef.current);
    for (const [threadId, status] of presenceRef.current) merged.set(threadId, status);
    replaceThreadStatuses(merged);
  }, []);

  const refresh = useCallback(() => {
    void rpc.call("presence_snapshot", { excludeViewerId: ownViewerId }).then(({ threads }) => {
      presenceRef.current = new Map(threads.map((entry) => [entry.threadId, {
        icon: entry.typing > 0 ? "Edit" : "UsersRound",
        label: presenceLabel(entry),
        tone: entry.typing > 0 ? "running" as const : "default" as const,
        badge: String(entry.viewers),
        badgeColor: entry.typing > 0 ? "var(--warning, #f59e0b)" : "var(--success, #22c55e)",
      }]));
      paint();
    }).catch(() => undefined);
  }, [ownViewerId, paint, rpc]);

  useEffect(() => {
    heartbeat();
    const timer = window.setInterval(heartbeat, HEARTBEAT_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        void rpc.call("presence_leave", { tabId: ownTabId }).catch(() => undefined);
      } else {
        heartbeat();
        refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [heartbeat, ownTabId, refresh, rpc]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (connection === "connected") {
      heartbeat();
      refresh();
    }
  }, [connection, heartbeat, refresh]);

  useEffect(() => () => {
    replaceThreadStatuses(new Map());
    void rpc.call("presence_leave", { tabId: ownTabId }).catch(() => undefined);
  }, [ownTabId, rpc]);

  // Ownership glyphs: one batched call for the threads the sidebar is showing.
  const sidebar = experimental_useSidebarThreads();
  const threadIds = useMemo(
    () => sidebar.threads.map((thread) => thread.id).sort().join(","),
    [sidebar.threads],
  );
  const refreshOwnership = useCallback(() => {
    const ids = threadIds.length === 0 ? [] : threadIds.split(",");
    if (ids.length === 0) {
      ownershipRef.current = new Map();
      paint();
      return;
    }
    void rpc.call("identity_thread_ownership", { threadIds: ids }).then(({ threads }) => {
      ownershipRef.current = new Map(threads.map((entry) => {
        const status = ownershipRowStatus(entry);
        // The CHOSEN colour wins over the dealt one here, exactly as it does on the
        // people page — the badge fill and the row tint are the two surfaces the
        // override exists for — and the ink follows whatever colour that turns out to
        // be, so a pale choice does not render as invisible initials.
        const resolved = resolvePersonColor(
          entry.starter?.person ?? null, rosterRef.current, colorsRef.current,
        );
        return [entry.threadId, {
          icon: status.icon,
          label: status.label,
          tone: status.tone,
          badge: status.badge,
          badgeColor: resolved.color,
          badgeInk: readableInk(resolved.color),
        }] as const;
      }));
      paint();
    }).catch(() => undefined);
  }, [paint, rpc, threadIds]);

  useEffect(() => {
    refreshOwnership();
    const timer = window.setInterval(refreshOwnership, OWNERSHIP_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refreshOwnership]);

  // The roster, for dealing per-person colours. Fetched once and refreshed on the same
  // cadence as ownership: a directory edit should recolour without a reload, and the
  // colours are only read on the next paint anyway.
  useEffect(() => {
    let live = true;
    const readRoster = () => {
      void rpc.call("identity_machines").then((result: MachineList) => {
        if (!live) return;
        const next = result.roster ?? [];
        const nextColors = result.colors ?? {};
        // Repaint when EITHER the roster or the chosen colours moved: a colour change
        // leaves the roster identical, so comparing only the roster would leave the
        // sidebar showing the old colour until something else happened to change.
        const same = next.join(",") === rosterRef.current.join(",")
          && JSON.stringify(nextColors) === JSON.stringify(colorsRef.current);
        if (same) return;
        rosterRef.current = next;
        colorsRef.current = nextColors;
        refreshOwnership();
      }).catch(() => undefined);
    };
    readRoster();
    const timer = window.setInterval(readRoster, OWNERSHIP_REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [refreshOwnership, rpc]);

  useRealtime("presence-changed", refresh);
  return null;
}

/**
 * The thread header chip: "Started by David · runs as ensembleworks-agent on
 * <machine>", the machine shown only when it differs from the starter (option B).
 * Display only — it never blocks or alters anything.
 *
 * In `audit` mode it also carries what enforcement WOULD have done ("would be refused —
 * Matt's thread"), so the team can evaluate the guardrail by using bb rather than by
 * reading logs.
 */
function ThreadOwnershipChip({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const ownViewerId = useMemo(viewerId, []);
  const [ownership, setOwnership] = useState<ThreadOwnership | null>(null);
  const [list, setList] = useState<MachineList | null>(null);
  const [presence, setPresence] = useState<{ viewers: number; typing: number; people: PresentPerson[] }>({
    viewers: 0,
    typing: 0,
    people: [],
  });
  const [me, setMe] = useState<WhoAmI | null>(null);
  useEffect(() => {
    let live = true;
    void rpc.call("identity_thread_ownership", { threadIds: [threadId] }).then(({ threads }) => {
      if (live) setOwnership(threads[0] ?? null);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [rpc, threadId]);
  useEffect(() => {
    let live = true;
    // Keep People colour choices in step with the sidebar without reloading the plugin.
    const refresh = () => {
      void rpc.call("identity_machines").then((result: MachineList) => {
        if (live) setList(result);
      }).catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, OWNERSHIP_REFRESH_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [rpc]);
  const refreshPresence = useCallback(() => {
    void rpc.call("presence_thread", { threadId, excludeViewerId: ownViewerId })
      .then(({ viewers, typing, people }) => setPresence({ viewers, typing, people: people ?? [] }))
      .catch(() => undefined);
  }, [ownViewerId, rpc, threadId]);
  useEffect(() => {
    let live = true;
    const refresh = () => void rpc.call("identity_whoami").then((result) => {
      if (live) setMe(result);
    }).catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [rpc]);
  useEffect(() => {
    refreshPresence();
    const timer = window.setInterval(refreshPresence, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refreshPresence]);
  useRealtime("presence-changed", (payload: unknown) => {
    if (typeof payload !== "object" || payload === null) return;
    const threadIds = (payload as { threadIds?: unknown }).threadIds;
    if (Array.isArray(threadIds) && threadIds.includes(threadId)) refreshPresence();
  });
  if (ownership === null) return null;
  const chip = headerChip(ownership, {
    sharedUser: list?.sharedMachineUser ?? "ensembleworks-agent",
    enforcement: list?.enforcement ?? "off",
    me: list?.me ?? null,
    meViaFallback: list?.meViaFallback === true,
    meProvenance: list?.meProvenance,
  });
  const row = ownershipRowStatus(ownership);
  const { color } = resolvePersonColor(
    ownership.starter?.person ?? null, list?.roster ?? [], list?.colors ?? {},
  );
  const ownerPresence = ownership.starter === null
    ? null
    : presence.people.find((entry) => entry.person === ownership.starter?.person) ?? null;
  const otherNamedViewers = presence.people.filter((entry) => entry.person !== ownership.starter?.person);
  const otherViewerCount = Math.max(0, presence.viewers - (ownerPresence === null ? 0 : 1));
  const visibleViewers = otherNamedViewers.slice(0, otherViewerCount > 2 ? 1 : 2);
  const hiddenViewerCount = Math.max(0, otherViewerCount - visibleViewers.length);
  const presenceSummary = combinedPresenceLabel(presence);
  const triggerLabel = `${row.label}.${presenceSummary === null ? "" : ` ${presenceSummary}.`} Show thread details`;
  return (
    <Popover.Root key={threadId}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="identity-ownership-button"
          aria-label={triggerLabel}
          title={chip.text}
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            minWidth: 44, height: 44, flexShrink: 0, padding: "0 2px",
            border: 0, borderRadius: 8, background: "transparent", cursor: "pointer",
          }}
        >
          <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center" }}>
            <span data-identity-bubble="owner" style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 26, borderRadius: "50%", fontSize: 11, fontWeight: 700,
              background: color, color: readableInk(color), zIndex: 10,
              border: ownerPresence?.typing
                ? "2px solid var(--warning, #f59e0b)"
                : "2px solid var(--background)",
              boxSizing: "border-box",
            }}>{row.badge}</span>
            {visibleViewers.map((entry, index) => {
              const viewerColor = resolvePersonColor(entry.person, list?.roster ?? [], list?.colors ?? {}).color;
              return (
                <span key={entry.person} data-identity-bubble="viewer" style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  width: 20, height: 20, marginLeft: -6, borderRadius: "50%",
                  fontSize: 8, fontWeight: 700, boxSizing: "border-box",
                  background: viewerColor, color: readableInk(viewerColor), zIndex: 9 - index,
                  border: entry.typing
                    ? "2px solid var(--warning, #f59e0b)"
                    : "2px solid var(--background)",
                }}>{initials(entry.displayName)}</span>
              );
            })}
            {hiddenViewerCount > 0 ? (
              <span data-identity-bubble="viewer" style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, marginLeft: -6, borderRadius: "50%",
                fontSize: 8, fontWeight: 700, boxSizing: "border-box",
                background: "var(--muted)", color: "var(--muted-foreground)",
                border: "2px solid var(--background)", zIndex: 7,
              }}>+{hiddenViewerCount}</span>
            ) : null}
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          aria-label="Thread details"
          style={{
            boxSizing: "border-box", width: 360,
            maxWidth: "calc(100vw - 16px)",
            maxHeight: "var(--radix-popover-content-available-height)", overflowY: "auto",
            overflowWrap: "anywhere", whiteSpace: "normal",
            background: "var(--popover, var(--background))",
            border: "1px solid var(--border)", borderRadius: 8,
            color: "var(--popover-foreground, var(--foreground))",
            padding: 12, fontSize: 13, lineHeight: 1.5, zIndex: 50,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <strong>Thread details</strong>
            <Popover.Close className="identity-ownership-button" aria-label="Close thread details" style={{
              width: 44, height: 44, flexShrink: 0, borderRadius: 6,
              border: "1px solid var(--border)", background: "transparent",
              color: "inherit", cursor: "pointer", fontSize: 20,
            }}>×</Popover.Close>
          </div>
          <p style={{ margin: "8px 0 0", color: chip.tone === "muted" ? "var(--muted-foreground)" : "inherit" }}>
            {chip.text}
          </p>
          <div style={{ borderTop: "1px solid var(--border)", fontWeight: 600, marginTop: 12, paddingTop: 12 }}>
            Viewing now
          </div>
          {presence.viewers === 0 ? (
            <div style={{ color: "var(--muted-foreground)", fontSize: 12, marginTop: 6 }}>
              No one else is currently viewing this thread.
            </div>
          ) : (
            <>
              <div style={{ marginTop: 6 }}>
                {presence.people.map((entry) => <PersonRow key={entry.person} entry={entry} list={list} />)}
                {presence.people.length === 0 || presence.viewers > presence.people.length ? (
                  <PresenceDetail
                    icon={<UsersRoundIcon />}
                    text={anonymousViewerDetail(presence)}
                  />
                ) : null}
                {anonymousTypingCount(presence) > 0 ? (
                  <PresenceDetail
                    icon={<TypingIcon />}
                    text={`${anonymousTypingCount(presence)} anonymous ${anonymousTypingCount(presence) === 1 ? "viewer is" : "viewers are"} typing`}
                    tone="warning"
                  />
                ) : null}
              </div>
              <div style={{ color: "var(--muted-foreground)", fontSize: 11, lineHeight: 1.4, marginTop: 10 }}>
                {identityFooter(me)}
              </div>
            </>
          )}
          <IdentityPicker />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Who I am, which machines exist, and whether the guardrail is switched on. */
function useMachineList(): MachineList | null {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const [list, setList] = useState<MachineList | null>(null);
  useEffect(() => {
    let live = true;
    const refresh = () => void rpcRef.current.call("identity_machines").then((result) => {
      if (live) setList(result);
    }).catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { live = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  return list;
}

function BannerBody({ title, detail }: { title: string; detail: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", fontSize: 12, gap: 2, lineHeight: 1.4 }}>
      <span style={{ fontWeight: 600 }}>{title}</span>
      <span style={{ color: "var(--muted-foreground)" }}>{detail}</span>
    </div>
  );
}

/**
 * The new-thread composer banner: "Starting as David", plus the machines that are
 * yours. It deliberately makes NO claim about the machine you picked — a `new-thread`
 * composer customization cannot see it (spike S3-lite) — and what it says about what
 * happens AFTER you send follows the `enforcement` setting, so it can never promise an
 * enforcement the server is not performing.
 */
function StartingAsBanner() {
  const list = useMachineList();
  if (list === null) return null;
  const banner = composerBanner({ me: list.me, provenance: list.meProvenance,
    machines: list.machines, enforcement: list.enforcement });
  return (
    <BannerBody
      title={banner.title}
      detail={`${banner.detail}${list.unavailable === null ? "" : ` ${list.unavailable}.`}`}
    />
  );
}

/**
 * The composer banner on a thread somebody else started: "Read-only: Matt's thread".
 *
 * Rule B is what makes it true, so it ships with rule B and reads the same setting: with
 * enforcement off it says the thread is Matt's and that nothing enforces that, and in
 * audit that a message here is logged as a would-refuse and goes through anyway.
 */
function ReadOnlyThreadBanner() {
  const rpc = useRpc<typeof rpcContract>();
  const view = useComposerView();
  const list = useMachineList();
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const [ownership, setOwnership] = useState<ThreadOwnership | null>(null);
  useEffect(() => {
    if (threadId === null) return;
    let live = true;
    void rpc.call("identity_thread_ownership", { threadIds: [threadId] }).then(({ threads }) => {
      if (live) setOwnership(threads[0] ?? null);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [rpc, threadId]);
  if (list === null || ownership === null) return null;
  const banner = readOnlyBanner({
    me: list.me,
    meViaFallback: list.meViaFallback,
    starter: ownership.provenance ? null : ownership.starter,
    enforcement: list.enforcement,
  });
  if (banner === null) return null;
  return <BannerBody title={banner.title} detail={banner.detail} />;
}

/** Invisible composer surface: observes text, never sends draft content. */
function TypingPulse() {
  const rpc = useRpc<typeof rpcContract>();
  const view = useComposerView();
  const ownViewerId = useMemo(viewerId, []);
  const ownTabId = useMemo(tabId, []);
  const lastSent = useRef(0);
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const active = threadId !== null && view.draft.text.trim().length > 0 && !view.run.isSubmitting;
  useEffect(() => {
    if (threadId === null) return;
    const now = Date.now();
    if (now - lastSent.current < 1_000 && active) return;
    lastSent.current = now;
    void rpc.call("presence_typing", {
      tabId: ownTabId,
      viewerId: ownViewerId,
      threadId,
      active,
    }).catch(() => undefined);
  }, [active, ownTabId, ownViewerId, rpc, threadId]);
  useEffect(() => () => {
    if (threadId !== null) {
      void rpc.call("presence_typing", {
        tabId: ownTabId,
        viewerId: ownViewerId,
        threadId,
        active: false,
      }).catch(() => undefined);
    }
  }, [ownTabId, ownViewerId, rpc, threadId]);
  return null;
}

/** A complete accessible summary: who is here, followed by who is typing. */
function combinedPresenceLabel(presence: { viewers: number; typing: number; people: PresentPerson[] }): string | null {
  if (presence.viewers === 0) return null;
  const viewing = presenceLabel({
    viewers: presence.viewers,
    typing: 0,
    people: presence.people.map((entry) => ({ ...entry, typing: false })),
  });
  return presence.typing > 0 ? `${viewing}; ${presenceLabel(presence)}` : viewing;
}

function anonymousTypingCount(presence: { typing: number; people: PresentPerson[] }): number {
  return Math.max(0, presence.typing - presence.people.filter((entry) => entry.typing).length);
}

function anonymousViewerDetail(presence: { viewers: number; people: PresentPerson[] }): string {
  const count = Math.max(0, presence.viewers - presence.people.length);
  return `${count} anonymous ${count === 1 ? "viewer" : "viewers"}`;
}

function identityFooter(me: WhoAmI | null): string {
  if (me?.provenance === "self-selected" && me.person) return `You are shown as ${me.person.displayName}, chosen in this browser for attribution only.`;
  if (me?.provenance === "configured-fallback" && me.person) return `You are shown as ${me.person.displayName} by the configured fallback.`;
  if (me?.person) return `Upstream header identifies ${me.person.displayName} (header not verified by Identity).`;
  if (me?.email) return `Upstream header says ${me.email}; this address is not in the Identity directory.`;
  return "You are anonymous here.";
}


function IdentityPromptOverlay() {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const [me, setMe] = useState<WhoAmI | null>(null);
  const [open, setOpen] = useState(false);
  const refresh = useCallback(() => {
    void rpcRef.current.call("identity_whoami").then(setMe).catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [refresh]);
  const ready = me?.provenance === "unknown"
    && me.picker.enabled
    && me.picker.status === "ready"
    && me.picker.people.length > 0;
  useEffect(() => {
    if (ready && claimIdentityPrompt()) setOpen(true);
    if (me !== null && !ready) setOpen(false);
  }, [me, ready]);
  if (!ready) return null;
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay style={{ position: "fixed", inset: 0, background: "rgb(0 0 0 / 0.45)", zIndex: 79 }} />
        <Dialog.Content
          aria-describedby="identity-prompt-description"
          style={{
            boxSizing: "border-box", position: "fixed", left: "50%", top: "50%",
            transform: "translate(-50%, -50%)", width: 380, maxWidth: "calc(100vw - 24px)",
            maxHeight: "calc(100dvh - 24px)", overflowY: "auto", overflowWrap: "anywhere",
            background: "var(--popover, var(--background))", color: "var(--popover-foreground, var(--foreground))",
            border: "1px solid var(--border)", borderRadius: 10, padding: 16, zIndex: 80,
            boxShadow: "0 18px 48px rgb(0 0 0 / 0.25)",
          }}
        >
          <Dialog.Title style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Choose your identity</Dialog.Title>
          <Dialog.Description id="identity-prompt-description" style={{ color: "var(--muted-foreground)", fontSize: 12, margin: "6px 0 0" }}>
            Identity cannot tell who is using this browser.
          </Dialog.Description>
          <IdentityPicker onIdentityChange={setMe} />
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
            <Dialog.Close className="identity-ownership-button" style={{
              minHeight: 40, padding: "0 14px", borderRadius: 6,
              border: "1px solid var(--border)", background: "transparent", color: "inherit", cursor: "pointer",
            }}>Not now</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PersonRow({ entry, list }: { entry: PresentPerson; list?: MachineList | null }) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const fallbackColor = resolvePersonColor(entry.person, list?.roster ?? [], list?.colors ?? {}).color;
  return (
    <div style={{ alignItems: "center", display: "flex", gap: 8, fontSize: 12, lineHeight: 1.5, marginBottom: 4 }}>
      {avatarFailed ? (
        <span
          aria-hidden="true"
          style={{
            alignItems: "center",
            background: fallbackColor,
            borderRadius: "50%",
            display: "inline-flex",
            flex: "0 0 auto",
            fontSize: 9,
            color: readableInk(fallbackColor),
            fontWeight: 600,
            height: 20,
            justifyContent: "center",
            width: 20,
          }}
        >
          {initials(entry.displayName)}
        </span>
      ) : (
        <img
          src={`https://github.com/${encodeURIComponent(entry.github)}.png?size=40`}
          alt={entry.displayName}
          width={20}
          height={20}
          onError={() => setAvatarFailed(true)}
          style={{ borderRadius: "50%", flex: "0 0 auto" }}
        />
      )}
      <span style={{ flex: "1 1 auto" }}>{entry.displayName}
        {entry.provenance === "self-selected" ? " · chosen in a browser" :
          entry.provenance === "configured-fallback" ? " · configured fallback" :
            entry.provenance === "upstream-header" ? " · upstream header" :
              entry.provenance === "mixed" ? " · mixed sources" : ""}
      </span>
      {entry.typing ? (
        <span style={{ alignItems: "center", color: "var(--warning, var(--foreground))", display: "inline-flex", gap: 4 }}>
          <TypingIcon />
          typing
        </span>
      ) : null}
    </div>
  );
}

function PresenceDetail({
  icon,
  text,
  tone = "default",
}: {
  icon: ReactNode;
  text: string;
  tone?: "default" | "warning";
}) {
  return (
    <div style={{ alignItems: "center", display: "flex", gap: 8, fontSize: 12, lineHeight: 1.5 }}>
      <span
        aria-hidden="true"
        style={{
          color: tone === "warning" ? "var(--warning, var(--foreground))" : "var(--muted-foreground)",
          display: "inline-flex",
          flex: "0 0 auto",
        }}
      >
        {icon}
      </span>
      <span>{text}</span>
    </div>
  );
}

function UsersRoundIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function TypingIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "thread-presence-status",
    mount: ({ experimental_setThreadRowStatus }) => mountThreadStatusFallback({
      document,
      setNativeStatus: experimental_setThreadRowStatus,
    }),
  });
  app.slots.experimental_appOverlay({ id: "presence-coordinator", component: PresenceCoordinator });
  app.slots.experimental_appOverlay({ id: "identity-prompt", component: IdentityPromptOverlay });
  app.composer.customize({ id: "typing-awareness", scopes: ["thread"], actions: [{ id: "typing-pulse", component: TypingPulse }] });
  app.slots.experimental_threadHeaderAction({
    id: "thread-ownership",
    title: "Thread ownership and viewers",
    component: ThreadOwnershipChip,
  });
  app.composer.customize({
    id: "ownership-banner",
    scopes: ["new-thread"],
    banners: [{ id: "starting-as", chrome: "card", component: StartingAsBanner }],
  });
  app.composer.customize({
    id: "read-only-banner",
    scopes: ["thread"],
    banners: [{ id: "read-only", chrome: "card", component: ReadOnlyThreadBanner }],
  });
  app.slots.settingsSection({
    id: "people",
    title: "People & machines",
    description: "Who and what Identity recognises, why, and what it does about it.",
    component: IdentitySettings,
  });
});
