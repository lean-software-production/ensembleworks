/**
 * `ui/active-runs-banner.tsx` — the composer's "active runs" banner: every
 * Attractor run still in flight for the thread the composer is mounted in,
 * right above the message box, so a human doesn't have to go hunting for the
 * workflow's directive card to see it's still going — or that it needs them.
 *
 * Registered from `app.tsx` via `app.composer.customize({ id:
 * "attractor-status", scopes: ["thread"], banners: [{ id: "active-runs",
 * chrome: "bare", component: ActiveRunsBanner }] })`. `chrome: "bare"` means
 * this component supplies its own card chrome.
 *
 * Run-panel redesign: each row *is* the attention card
 * (`ui/attention-card.tsx`, `surface="banner"`) — the same component and the
 * same derived state as the chat card and the top of the side panel, so the
 * three can never disagree. A gate's options are answer buttons on the row,
 * a provider pause shows its reset time and countdown, a worker's own prompt
 * offers "Open worker to answer". The row's › opens the run in the side
 * panel, where the graph, history and event log live; the banner itself no
 * longer expands into a graph.
 *
 * The thread id is read via `useComposerView()`'s scope rather than
 * `useBbContext()`: the customization's `scopes: ["thread"]` guarantees the
 * mounted composer is always a `{ kind: "thread" }` scope.
 */

import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useComposerView, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server/contracts";
import type { ActiveRun } from "../server/contracts";
import { AttentionCard } from "./attention-card";
import { ACTION_ID, REALTIME_CHANNEL, REFRESH_COALESCE_MS, attentionActions, useCoalescedRealtimeRefresh, useNow } from "./run-panel";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

const FALLBACK_POLL_MS = 5_000;

function useActiveRuns(rpc: Rpc, threadId: string | null) {
  const [runs, setRuns] = useState<ActiveRun[]>([]);

  const refresh = useCallback(() => {
    if (threadId === null) {
      setRuns([]);
      return;
    }
    rpc.call("activeRuns", { threadId }).then(
      (result) => setRuns(result.runs),
      // A transient RPC failure is not "no active runs": keep the last known
      // rows so the banner stays up and the fallback poll below keeps
      // retrying (a run parked on a human gate publishes no realtime events
      // while it waits, so the poll is its only recovery path).
      () => setRuns((previous) => previous),
    );
  }, [rpc, threadId]);

  useEffect(refresh, [refresh]);
  useCoalescedRealtimeRefresh(REALTIME_CHANNEL, refresh, REFRESH_COALESCE_MS);

  // The realtime channel only ever fires for a run this plugin already
  // knows about; a fallback poll picks up anything it otherwise missed
  // while at least one run is active — once every run reaches a terminal
  // status this stops polling on its own.
  useEffect(() => {
    if (runs.length === 0) return;
    const timer = setInterval(refresh, FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [runs.length, refresh]);

  return { runs, refresh };
}

/** The composer's "active runs" banner — see the module doc. Renders nothing outside a thread composer and when the thread has no active runs. */
export function ActiveRunsBanner() {
  const view = useComposerView();
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { runs, refresh } = useActiveRuns(rpc, threadId);
  const now = useNow(runs.length > 0);

  if (threadId === null || runs.length === 0) return null;
  const currentThreadId = threadId;

  return (
    <div className="rounded-lg border border-border bg-surface-raised-solid p-2 text-left divide-y divide-border" data-testid="attractor-active-runs">
      {runs.map(({ run, stages, graph }) => (
        <div key={run.id} data-active-run={run.id}>
          <AttentionCard
            surface="banner"
            run={run}
            stages={stages}
            graph={graph}
            now={now}
            actions={attentionActions(rpc, run.id, currentThreadId, refresh, navigate, () =>
              navigate.openThreadPanel({ actionId: ACTION_ID, params: { runId: run.id, threadId: currentThreadId }, title: run.title ?? "Attractor run" }),
            )}
          />
        </div>
      ))}
    </div>
  );
}
