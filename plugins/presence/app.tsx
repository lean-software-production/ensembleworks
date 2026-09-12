import { useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, useComposerView, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.js";

function tabId(): string {
  const key = "bb-presence-tab-id";
  const current = sessionStorage.getItem(key);
  if (current !== null) return current;
  const next = crypto.randomUUID();
  sessionStorage.setItem(key, next);
  return next;
}

/** Invisible composer surface: observes text, never sends draft content. */
function TypingPulse() {
  const rpc = useRpc<typeof rpcContract>();
  const view = useComposerView();
  const id = useMemo(tabId, []);
  const lastSent = useRef(0);
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const active = threadId !== null && view.draft.text.trim().length > 0 && !view.run.isSubmitting;
  useEffect(() => {
    if (threadId === null) return;
    const now = Date.now();
    if (now - lastSent.current < 1_000 && active) return;
    lastSent.current = now;
    void rpc.call("presence_typing", { tabId: id, threadId, active });
  }, [active, id, rpc, threadId]);
  useEffect(() => () => {
    if (threadId !== null) void rpc.call("presence_typing", { tabId: id, threadId, active: false });
  }, [id, rpc, threadId]);
  return null;
}

function TypingIndicator({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [count, setCount] = useState(0);
  useEffect(() => {
    const refresh = () => void rpc.call("presence_typing_list", { threadId }).then((result) => setCount(result.count));
    refresh();
    const timer = window.setInterval(refresh, 1_000);
    return () => window.clearInterval(timer);
  }, [rpc, threadId]);
  useRealtime("presence-typing", (payload: unknown) => {
    if (typeof payload === "object" && payload !== null && (payload as { threadId?: unknown }).threadId === threadId) {
      void rpc.call("presence_typing_list", { threadId }).then((result) => setCount(result.count));
    }
  });
  return count === 0 ? null : <span aria-label={`${count} person${count === 1 ? "" : "s"} typing`} style={{ fontSize: 12, color: "var(--muted-foreground)" }}>Typing…</span>;
}

export default definePluginApp((app) => {
  app.composer.customize({ id: "typing-awareness", scopes: ["thread"], actions: [{ id: "typing-pulse", component: TypingPulse }] });
  app.slots.experimental_threadHeaderAction({ id: "typing-indicator", title: "Typing activity", component: TypingIndicator });
});
