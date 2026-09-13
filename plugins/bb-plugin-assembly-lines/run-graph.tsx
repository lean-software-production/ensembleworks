import { useEffect, useMemo, useState } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './contracts';
import type { RunGraph } from './graph-contract';

import { graphImage, latestStages } from './graph-image';

export function GraphPreview({ jobId, threadId, runId, status, compact = false }: { jobId: string; threadId: string; runId: string | null; status: string | null; compact?: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [graph, setGraph] = useState<RunGraph | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setGraph(null); setError(false);
    if (!runId) return;
    const terminal = ['succeeded', 'failed', 'dead'].includes(status ?? '');
    const refresh = async () => {
      try {
        const result = await rpc.call('getRunGraph', { jobId, threadId });
        if (!disposed) { setGraph(result); setError(false); }
      } catch { if (!disposed) setError(true); }
      if (!disposed && !terminal) timer = setTimeout(refresh, 5000);
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [rpc, jobId, threadId, runId, status]);
  const image = useMemo(() => {
    if (!graph) return null;
    try { return graphImage(graph); } catch { return null; }
  }, [graph]);
  if (!runId) return <p className="mt-3 text-xs text-muted-foreground">Graph appears when Fabro creates the run.</p>;
  if (!image) return <p className="mt-3 text-xs text-muted-foreground">{error || graph ? 'Fabro graph unavailable. Open details to inspect the run.' : 'Loading Fabro graph…'}</p>;
  const stages = [...latestStages(graph!).values()];
  const summary = stages.map(s => `${s.node_id}: ${s.status.replaceAll('_', ' ')}${s.visit > 1 ? ` (visit ${s.visit})` : ''}`).join('; ');
  return <div className="mt-3">
    <div className="overflow-hidden rounded-md border border-border bg-slate-50 p-2">
      <img src={image} alt={`Fabro workflow graph. ${summary}`} className={compact ? "mx-auto max-h-28 w-full object-contain" : "mx-auto h-auto w-full"} />
    </div>
    {!compact ? <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-hidden="true">
      <span>🟢 Completed</span><span>🔵 Running</span><span>🔴 Failed</span><span>○ Pending</span>
    </div> : null}
    {error ? <p className="mt-1 text-xs text-destructive">Graph update unavailable; showing the last snapshot.</p> : null}
    {!graph!.stagesComplete ? <p className="mt-1 text-xs text-muted-foreground">Stage history is partial.</p> : null}
  </div>;
}
