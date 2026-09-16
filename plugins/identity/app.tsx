import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  definePluginApp,
  useBbContext,
  useComposerView,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PresenceLocation, rpcContract } from "./server.js";
import {
  mountThreadStatusFallback,
  replaceThreadStatuses,
  type ThreadStatus,
} from "./sidebar-fallback.js";

const HEARTBEAT_MS = 10_000;
const REFRESH_MS = 5_000;

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

function presenceLabel(viewers: number, typing: number): string {
  const viewing = `${viewers} other ${viewers === 1 ? "viewer" : "viewers"}`;
  return typing > 0 ? `${viewing} · ${typing} typing` : viewing;
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

  const refresh = useCallback(() => {
    void rpc.call("presence_snapshot", { excludeViewerId: ownViewerId }).then(({ threads }) => {
      replaceThreadStatuses(new Map(threads.map((entry) => [entry.threadId, {
        icon: entry.typing > 0 ? "Edit" : "UsersRound",
        label: presenceLabel(entry.viewers, entry.typing),
        tone: entry.typing > 0 ? "running" as const : "default" as const,
        viewers: entry.viewers,
        typing: entry.typing,
      }])));
    }).catch(() => undefined);
  }, [ownViewerId, rpc]);

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

  useRealtime("presence-changed", refresh);
  return null;
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
  const [presence, setPresence] = useState({ viewers: 0, typing: 0 });
  const refresh = useCallback(() => {
    void rpc.call("presence_thread", { threadId, excludeViewerId: ownViewerId })
      .then(({ viewers, typing }) => setPresence({ viewers, typing }))
      .catch(() => undefined);
  }, [ownViewerId, rpc, threadId]);
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
  const label = presenceLabel(presence.viewers, presence.typing);
  const viewerDetail = presence.viewers === 1
    ? "1 other viewer is here"
    : `${presence.viewers} other viewers are here`;
  const typingDetail = presence.typing === 1
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
          <PresenceDetail icon={<UsersRoundIcon />} text={viewerDetail} />
          {presence.typing > 0 ? (
            <PresenceDetail icon={<TypingIcon />} text={typingDetail} tone="warning" />
          ) : null}
          <div style={{ color: "var(--muted-foreground)", fontSize: 11, lineHeight: 1.4, marginTop: 10 }}>
            Presence is anonymous for now. Names and individual activity can appear here when BB exposes viewer identity.
          </div>
          <Popover.Arrow style={{ fill: "var(--popover, var(--background))" }} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
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
});
