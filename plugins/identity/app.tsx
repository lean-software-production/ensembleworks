import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import type { MachineList, PresenceLocation, PresentPerson, rpcContract, ThreadOwnership, WhoAmI } from "./server.js";
import { initials, presenceLabel } from "./presence-labels.js";
import { composerBanner, headerChip, ownershipRowStatus, readOnlyBanner } from "./ownership-labels.js";
import {
  mountThreadStatusFallback,
  replaceThreadStatuses,
  type ThreadStatus,
} from "./sidebar-fallback.js";

const HEARTBEAT_MS = 10_000;
const REFRESH_MS = 5_000;
/** Ownership is durable, so it is polled far less often than presence. */
const OWNERSHIP_REFRESH_MS = 60_000;
const OWNERSHIP_BADGE_COLOR = "var(--muted-foreground, #6b7280)";

function stableId(storage: Storage, key: string): string {
  const current = storage.getItem(key);
  if (current !== null) return current;
  const next = crypto.randomUUID();
  storage.setItem(key, next);
  return next;
}

function viewerId(): string {
  return stableId(localStorage, "bb-presence-viewer-id");
}

function tabId(): string {
  return stableId(sessionStorage, "bb-presence-tab-id");
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
        return [entry.threadId, {
          icon: status.icon,
          label: status.label,
          tone: status.tone,
          badge: status.badge,
          badgeColor: OWNERSHIP_BADGE_COLOR,
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

  useRealtime("presence-changed", refresh);
  return null;
}

/**
 * The thread header chip: "Started by David · runs as ensembleworks-agent on
 * <machine>", the machine shown only when it differs from the starter (option B).
 * Display only — it never blocks or alters anything.
 */
function ThreadOwnershipChip({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [ownership, setOwnership] = useState<ThreadOwnership | null>(null);
  const [sharedUser, setSharedUser] = useState("ensembleworks-agent");
  useEffect(() => {
    let live = true;
    void rpc.call("identity_thread_ownership", { threadIds: [threadId] }).then(({ threads }) => {
      if (live) setOwnership(threads[0] ?? null);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [rpc, threadId]);
  useEffect(() => {
    let live = true;
    void rpc.call("identity_machines").then((result: MachineList) => {
      // The chip needs only the shared account's name; it rides along with the
      // machine list rather than costing a second call.
      if (live) setSharedUser(result.sharedMachineUser);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [rpc]);
  if (ownership === null) return null;
  const chip = headerChip(ownership, { sharedUser });
  return (
    <span
      title={chip.text}
      style={{
        alignItems: "center",
        color: chip.tone === "muted" ? "var(--muted-foreground)" : "var(--foreground)",
        display: "inline-flex",
        fontSize: 12,
        gap: 6,
        maxWidth: 420,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {chip.text}
    </span>
  );
}

/** Who I am, which machines exist, and whether the guardrail is switched on. */
function useMachineList(): MachineList | null {
  const rpc = useRpc<typeof rpcContract>();
  const [list, setList] = useState<MachineList | null>(null);
  useEffect(() => {
    let live = true;
    void rpc.call("identity_machines").then((result) => {
      if (live) setList(result);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [rpc]);
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
 * happens AFTER you send follows `restrictStarts`, so it can never promise an
 * enforcement the server is not performing.
 */
function StartingAsBanner() {
  const list = useMachineList();
  if (list === null) return null;
  const banner = composerBanner({ me: list.me, machines: list.machines, restrictStarts: list.restrictStarts });
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
 * `restrictStarts` off it says the thread is Matt's and that nothing enforces that.
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
    starter: ownership.starter,
    restrictStarts: list.restrictStarts,
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

function ThreadPresence({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const ownViewerId = useMemo(viewerId, []);
  const [presence, setPresence] = useState<{ viewers: number; typing: number; people: PresentPerson[] }>({
    viewers: 0,
    typing: 0,
    people: [],
  });
  const [me, setMe] = useState<WhoAmI | null>(null);
  const refresh = useCallback(() => {
    void rpc.call("presence_thread", { threadId, excludeViewerId: ownViewerId })
      .then(({ viewers, typing, people }) => setPresence({ viewers, typing, people: people ?? [] }))
      .catch(() => undefined);
  }, [ownViewerId, rpc, threadId]);
  useEffect(() => {
    let live = true;
    void rpc.call("identity_whoami").then((result) => {
      if (live) setMe(result);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [rpc]);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useRealtime("presence-changed", (payload: unknown) => {
    if (typeof payload !== "object" || payload === null) return;
    const threadIds = (payload as { threadIds?: unknown }).threadIds;
    if (Array.isArray(threadIds) && threadIds.includes(threadId)) refresh();
  });
  if (presence.viewers === 0) return null;
  const label = presenceLabel(presence);
  const anonymousViewers = Math.max(0, presence.viewers - presence.people.length);
  const namedTypers = presence.people.filter((entry) => entry.typing).length;
  const anonymousTypers = Math.max(0, presence.typing - namedTypers);
  const viewerDetail = presence.people.length > 0
    ? `+${anonymousViewers} ${anonymousViewers === 1 ? "other" : "others"}`
    : presence.viewers === 1
      ? "1 other viewer is here"
      : `${presence.viewers} other viewers are here`;
  const typingDetail = presence.people.length > 0
    ? `${anonymousTypers} of them ${anonymousTypers === 1 ? "is" : "are"} typing`
    : presence.typing === 1
      ? "1 viewer is typing"
      : `${presence.typing} viewers are typing`;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`${label}. Show presence details`}
          title={label}
          style={{
            alignItems: "center",
            background: "transparent",
            border: 0,
            borderRadius: 6,
            color: presence.typing > 0
              ? "var(--warning, #f59e0b)"
              : "var(--success, #22c55e)",
            cursor: "pointer",
            display: "inline-flex",
            height: 28,
            justifyContent: "center",
            padding: 0,
            width: 28,
          }}
        >
          <UsersRoundIcon />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          aria-label="Thread presence"
          style={{
            background: "var(--popover, var(--background))",
            border: "1px solid var(--border)",
            borderRadius: 8,
            color: "var(--popover-foreground, var(--foreground))",
            padding: 12,
            width: 220,
            zIndex: 50,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>People here</div>
          {presence.people.map((entry) => <PersonRow key={entry.person} entry={entry} />)}
          {presence.people.length === 0 || anonymousViewers > 0 ? (
            <PresenceDetail icon={<UsersRoundIcon />} text={viewerDetail} />
          ) : null}
          {(presence.people.length === 0 ? presence.typing : anonymousTypers) > 0 ? (
            <PresenceDetail icon={<TypingIcon />} text={typingDetail} tone="warning" />
          ) : null}
          <div style={{ color: "var(--muted-foreground)", fontSize: 11, lineHeight: 1.4, marginTop: 10 }}>
            {identityFooter(me)}
          </div>
          <Popover.Arrow style={{ fill: "var(--popover, var(--background))" }} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function identityFooter(me: WhoAmI | null): string {
  if (me?.person) return `You are ${me.person.displayName}.`;
  if (me?.email) return `Signed in as ${me.email}, not in the Identity directory.`;
  return "You are anonymous here. Names appear once Identity's directory is configured and this BB server sits behind Cloudflare Access.";
}

function PersonRow({ entry }: { entry: PresentPerson }) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  return (
    <div style={{ alignItems: "center", display: "flex", gap: 8, fontSize: 12, lineHeight: 1.5, marginBottom: 4 }}>
      {avatarFailed ? (
        <span
          aria-hidden="true"
          style={{
            alignItems: "center",
            background: "var(--muted, rgba(127, 127, 127, 0.2))",
            borderRadius: "50%",
            display: "inline-flex",
            flex: "0 0 auto",
            fontSize: 9,
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
      <span style={{ flex: "1 1 auto" }}>{entry.displayName}</span>
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
  app.composer.customize({ id: "typing-awareness", scopes: ["thread"], actions: [{ id: "typing-pulse", component: TypingPulse }] });
  app.slots.experimental_threadHeaderAction({ id: "thread-presence", title: "People here", component: ThreadPresence });
  app.slots.experimental_threadHeaderAction({
    id: "thread-ownership",
    title: "Who started this thread",
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
});
