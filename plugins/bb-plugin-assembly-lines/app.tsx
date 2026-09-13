import { useCallback, useEffect, useMemo, useState } from "react";
import { definePluginApp, useBbContext, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginMessageDirectiveProps, PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract, JobView } from "./contracts";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";
import { GraphPreview } from "./run-graph";
import { cn } from "./lib/utils";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Job = JobView & { fabroUrl?: string | null };
const ACTION = "job";
const DONE = new Set(["succeeded", "delivered", "accepted"]);

function label(value: string) { return value.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase()); }
function tone(value: string) { return DONE.has(value) ? "text-emerald-600" : value === "failed" || value === "rejected" ? "text-destructive" : "text-amber-600"; }
function title(job: Job) { return job.workOrder.title ?? job.workOrder.objective ?? "Assembly line"; }

function useJob(rpc: Rpc, jobId: string | null, threadId: string | null) {
  const [job, setJob] = useState<Job | null>(null); const [loaded, setLoaded] = useState(false); const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    if (!jobId) return;
    if (!threadId) return;
    rpc.call("getJob", { jobId, threadId }).then((r) => { setJob(r.job ? { ...r.job, fabroUrl: r.fabroUrl } as Job : null); setLoaded(true); setError(null); }, e => { setLoaded(true); setError(e instanceof Error ? e.message : String(e)); });
  }, [jobId, rpc, threadId]);
  useEffect(refresh, [refresh]);
  useRealtime("jobs-changed", (payload) => {
    if (!payload || typeof payload !== "object" || (payload as { jobId?: string }).jobId === jobId) refresh();
  });
  return { job, loaded, error };
}

function Progress({ job }: { job: Job }) {
  const phase = job.engineStatus ?? job.observationState;
  return <div className="mt-2"><div className="flex justify-between text-xs text-muted-foreground"><span className={cn("font-medium", tone(phase))}>{label(phase)}</span>{job.runId ? <span className="font-mono">{job.runId.slice(0, 8)}</span> : null}</div><p className="mt-1 text-xs text-muted-foreground">Completion: {label(job.completionState)} · Acceptance: {label(job.acceptanceVerdict)}</p>{job.connectionError ? <p className="mt-1 truncate text-xs text-destructive">{job.connectionError}</p> : null}</div>;
}

function Card({ job, open }: { job: Job; open: () => void }) {
  return <button type="button" onClick={open} aria-label={`Open assembly line ${title(job)}`} className="w-full rounded-lg border border-border bg-card p-3 text-left shadow-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><div className="flex items-start gap-2"><Icon name="Workflow" className="mt-0.5 size-4 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{title(job)}</p><Progress job={job} /></div><Icon name="ChevronRight" className="size-4 text-muted-foreground" /></div><GraphPreview jobId={job.id} threadId={job.threadId} runId={job.runId} status={job.engineStatus} /></button>;
}

function Directive({ attributes, message }: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof rpcContract>(); const navigate = useBbNavigate(); const id = attributes.jobId?.trim() || null;
  const { job, loaded, error } = useJob(rpc, id, attributes.originThreadId?.trim() || message.threadId);
  if (!id) return <p className="rounded border border-destructive/40 p-2 text-xs text-destructive">Assembly line directive has no job id.</p>;
  if (error) return <p className="rounded border border-destructive/40 p-2 text-xs text-destructive">Could not load assembly line: {error}</p>;
  if (!loaded) return <p className="rounded border border-border p-3 text-sm text-muted-foreground" role="status">Loading assembly line…</p>;
  if (!job) return <p className="rounded border border-border p-3 text-sm text-muted-foreground">Assembly line not found.</p>;
  return <div className="my-2 max-w-md"><Card job={job} open={() => navigate.openThreadPanel({ actionId: ACTION, params: { jobId: id, ...(job.threadId !== message.threadId ? { originThreadId: job.threadId } : {}) }, title: "Assembly line" })} />{DONE.has(job.observationState) ? <button type="button" className="mt-1 px-1 text-xs text-primary hover:underline" onClick={() => navigate.toThread(job.threadId)}>Return for acceptance</button> : null}</div>;
}

function Panel({ threadId, params }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>(); const navigate = useBbNavigate();
  const id = params && typeof params === "object" && "jobId" in params && typeof params.jobId === "string" ? params.jobId : null;
  const ownerThreadId = params && typeof params === "object" && "originThreadId" in params && typeof params.originThreadId === "string" ? params.originThreadId : threadId;
  const { job, loaded, error } = useJob(rpc, id, ownerThreadId);
  const [details, setDetails] = useState<{ text: string; artifacts: string } | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [showFabro, setShowFabro] = useState(false);
  useEffect(() => { if (id && job) rpc.call("getRunDetails", { jobId: id, threadId: ownerThreadId }).then(r => { setDetails({ text: r.details, artifacts: r.artifacts }); setDetailsError(null); }, e => setDetailsError(e instanceof Error ? e.message : String(e))); }, [id, job, rpc, ownerThreadId]);
  if (!id) return <p className="p-4 text-sm text-destructive">This panel has no job id.</p>;
  if (error) return <p className="p-4 text-sm text-destructive" role="alert">{error}</p>;
  if (!loaded) return <p className="p-4 text-sm text-muted-foreground" role="status">Loading assembly line…</p>;
  if (!job) return <p className="p-4 text-sm text-muted-foreground">Assembly line not found.</p>;
  const result = job.result && typeof job.result === "object" ? JSON.stringify(job.result, null, 2) : null;
  return <div className="h-full overflow-y-auto p-4"><div className="mx-auto max-w-xl space-y-4"><div><p className="text-xs uppercase tracking-wide text-muted-foreground">Assembly line</p><h2 className="mt-1 text-lg font-semibold">{title(job)}</h2><p className="mt-1 font-mono text-xs text-muted-foreground">{job.id}</p></div><div className="rounded-lg border border-border bg-card p-4"><Progress job={job} /><GraphPreview jobId={job.id} threadId={job.threadId} runId={job.runId} status={job.engineStatus} /><p className="mt-3 text-sm text-muted-foreground">{job.workOrder.objective}</p>{job.connectionError ? <p className="mt-2 text-sm text-destructive">{job.connectionError}</p> : null}</div>{detailsError ? <p className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">Run details are unavailable: {detailsError}</p> : null}{details ? <><pre className="max-h-72 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">{details.text}</pre>{details.artifacts ? <pre className="max-h-48 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">{details.artifacts}</pre> : null}</> : result ? <pre className="max-h-72 overflow-auto rounded-lg bg-muted p-3 text-xs">{result}</pre> : null}{showFabro && job.fabroUrl ? <div className="overflow-hidden rounded-lg border border-border"><iframe title="Fabro run" src={job.fabroUrl} sandbox="allow-scripts allow-forms" className="h-96 w-full" /><p className="border-t border-border p-2 text-xs text-muted-foreground">Fabro is isolated in a sandbox. Use the external link if this run requires host features.</p></div> : null}<div className="flex flex-wrap gap-2">{job.fabroUrl ? <><Button variant="outline" onClick={() => setShowFabro(value => !value)}><Icon name="PanelRight" className="size-4" />{showFabro ? "Hide Fabro" : "View Fabro"}</Button><Button variant="outline" onClick={() => navigate.openUrl(job.fabroUrl!)}><Icon name="ExternalLink" className="size-4" />Open externally</Button></> : <p className="text-xs text-muted-foreground">Fabro run link is not available yet.</p>}{DONE.has(job.acceptanceVerdict) ? <Button onClick={() => navigate.toThread(job.threadId)}><Icon name="Check" className="size-4" />Return for acceptance</Button> : null}</div></div></div>;
}

function JobsPage() {
  const rpc = useRpc<typeof rpcContract>(); const navigate = useBbNavigate(); const { threadId } = useBbContext(); const [jobs, setJobs] = useState<Job[] | null>(null);
  useEffect(() => { if (!threadId) { setJobs([]); return; } rpc.call("listJobs", { threadId }).then(r => setJobs(r.jobs as Job[]), () => setJobs([])); }, [rpc, threadId]);
  return <div className="h-full overflow-y-auto p-4"><div className="mx-auto max-w-3xl space-y-3"><h2 className="text-lg font-semibold">Fabro</h2><p className="text-sm text-muted-foreground">Live Fabro runs started from BB threads.</p>{!threadId ? <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Open a work thread to inspect its assembly lines.</p> : jobs === null ? <p className="text-sm text-muted-foreground">Loading runs…</p> : jobs.length === 0 ? <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No assembly lines yet. Submit work from an agent thread.</p> : jobs.map(job => <Card key={job.id} job={job} open={() => navigate.toThread(job.threadId)} />)}</div></div>;
}

export default definePluginApp(app => {
  app.slots.navPanel({ id: "assembly-lines", title: "Fabro", icon: "Workflow", path: "assembly-lines", component: JobsPage });
  app.slots.threadPanelAction({ id: ACTION, title: "Assembly line", icon: "Workflow", layout: "flush", component: Panel });
  app.slots.messageDirective({ id: "assembly-line", component: Directive });
});
