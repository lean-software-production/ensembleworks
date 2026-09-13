import { useCallback, useEffect, useMemo, useState } from "react";
import { Markdown, definePluginApp, experimental_Diff, useBbContext, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginMessageDirectiveProps, PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract, JobView } from "./contracts";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";
import { GraphPreview } from "./run-graph";
import { cn } from "./lib/utils";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Job = JobView & { fabroUrl?: string | null };
const ExperimentalDiff = experimental_Diff;
const ACTION = "job";
const DONE = new Set(["succeeded", "delivered", "accepted"]);
const FAIL = new Set(["failed", "rejected", "error", "cancelled"]);

function label(value: string) { return value.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase()); }
function tone(value: string) { return DONE.has(value) ? "text-emerald-600" : value === "failed" || value === "rejected" ? "text-destructive" : "text-amber-600"; }
function title(job: Job) { return job.workOrder.title ?? job.workOrder.objective ?? "Assembly line"; }

type JsonObject = Record<string, unknown>;
type DetailsState = { text: string; artifacts: string; fresh: boolean } | null;
type CheckStatus = "pass" | "fail" | "unknown";
type Check = { label: string; command?: string; status: CheckStatus; exitCode?: unknown; signal?: unknown; error?: unknown; stdout?: string; stderr?: string };
type CheckGroup = { title: string; checks: Check[]; status: CheckStatus };
type DiffFile = { name: string; patch: string; binary: boolean; malformed: boolean };
type SidebarData = {
  parseError?: string;
  raw: string;
  evidence: JsonObject | null;
  delivery: JsonObject | null;
  files: Record<string, { text?: string; truncated?: boolean; unavailable?: boolean }>;
  summary: { changedFiles: string[]; attempts?: unknown; resultSha?: string | null; retainedCheckout?: string | null };
  diff: { status: "ok" | "empty" | "unavailable" | "truncated" | "malformed"; message?: string; files: DiffFile[] };
  checks: CheckGroup[];
  reviewMarkdown?: string;
};

function isObject(value: unknown): value is JsonObject { return !!value && typeof value === "object" && !Array.isArray(value); }
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function arrayStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function stringifyRaw(value: unknown) { try { return JSON.stringify(value, null, 2); } catch { return String(value); } }
function parseJson(text?: string): JsonObject | null { if (!text) return null; try { const value = JSON.parse(text); return isObject(value) ? value : null; } catch { return null; } }
function fileEntries(evidence: JsonObject | null): SidebarData["files"] {
  const workspace = isObject(evidence?.workspace) ? evidence.workspace : null;
  const files = isObject(workspace?.files) ? workspace.files : {};
  const result: SidebarData["files"] = {};
  for (const [name, entry] of Object.entries(files)) {
    if (isObject(entry)) result[name] = { text: stringValue(entry.text), truncated: entry.truncated === true, unavailable: entry.unavailable === true };
  }
  return result;
}
function parseMaybeFileJson(files: SidebarData["files"], name: string): JsonObject | null {
  const file = files[name];
  if (!file?.text || file.truncated) return null;
  return parseJson(file.text);
}
function checkStatus(check: JsonObject): CheckStatus {
  if (check.error || check.signal || check.exitCode === null || check.exitCode === undefined) return check.exitCode === 0 && !check.error && !check.signal ? "pass" : "fail";
  return check.exitCode === 0 ? "pass" : "fail";
}
function toCheck(value: unknown, fallback: string): Check {
  if (!isObject(value)) return { label: fallback, status: "unknown" };
  const command = stringValue(value.command);
  return {
    label: command ?? fallback,
    command,
    status: checkStatus(value),
    exitCode: value.exitCode,
    signal: value.signal,
    error: value.error,
    stdout: stringValue(value.stdout),
    stderr: stringValue(value.stderr),
  };
}
function groupStatus(checks: Check[]): CheckStatus {
  if (checks.some(check => check.status === "fail")) return "fail";
  if (checks.length && checks.every(check => check.status === "pass")) return "pass";
  return "unknown";
}
function checksFrom(value: JsonObject | null, title: string): CheckGroup | null {
  if (!value) return null;
  const checks = Array.isArray(value.checks) ? value.checks.map((check, index) => toCheck(check, `${title} check ${index + 1}`)) : [];
  if (isObject(value.quality)) checks.push(toCheck(value.quality, `${title} quality`));
  if (!checks.length) return null;
  return { title, checks, status: groupStatus(checks) };
}
function splitDiff(patch: string): DiffFile[] {
  if (!patch.trim()) return [];
  const starts = [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  if (!starts.length) return [{ name: "Patch", patch, binary: /GIT binary patch|Binary files /.test(patch), malformed: !/^--- |\+\+\+ |@@ /m.test(patch) }];
  return starts.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < starts.length ? starts[index + 1]!.index! : patch.length;
    const filePatch = patch.slice(start, end).trimEnd();
    return { name: match[2] ?? match[1] ?? `File ${index + 1}`, patch: filePatch, binary: /GIT binary patch|Binary files /.test(filePatch), malformed: !/^diff --git /m.test(filePatch) };
  });
}
function parseSidebarData(job: Job, details: DetailsState): SidebarData {
  const raw = details?.text || (job.result ? stringifyRaw(job.result) : "");
  let evidence: JsonObject | null = null;
  let parseError: string | undefined;
  if (raw) {
    try { const parsed = JSON.parse(raw); evidence = isObject(parsed) ? parsed : null; if (!evidence) parseError = "Run details are not a JSON object."; }
    catch (error) { parseError = error instanceof Error ? error.message : "Malformed run details."; }
  } else if (isObject(job.result)) {
    evidence = job.result;
  }
  const files = fileEntries(evidence);
  const delivery = parseMaybeFileJson(files, "delivery.json") ?? (isObject(evidence?.delivery) ? evidence.delivery : null);
  const baseline = parseMaybeFileJson(files, "baseline.json") ?? (isObject(delivery?.baseline) ? delivery.baseline : isObject(delivery?.before) ? delivery.before : null);
  const validation = parseMaybeFileJson(files, "validation.json") ?? (isObject(delivery?.validation) ? delivery.validation : isObject(delivery?.final) ? delivery.final : isObject(delivery?.after) ? delivery.after : null);
  const groups = [checksFrom(baseline, "Baseline"), checksFrom(validation, "Final validation")].filter((g): g is CheckGroup => !!g);
  if (isObject(delivery?.quality)) groups.push({ title: "Quality", checks: [toCheck(delivery.quality, "Quality check")], status: toCheck(delivery.quality, "Quality check").status });
  const changedFiles = arrayStrings(delivery?.changedFiles).concat(arrayStrings(isObject(evidence?.scope) ? evidence.scope.changedFiles : undefined));
  const diffText = files["diff.patch"]?.text ?? stringValue(evidence?.diff) ?? (isObject(evidence?.diff) ? stringValue(evidence.diff.preview) : undefined);
  const diffTruncated = files["diff.patch"]?.truncated || (isObject(evidence?.diff) && evidence.diff.truncated === true);
  const unavailable = files["diff.patch"]?.unavailable || (isObject(evidence?.diff) && evidence.diff.unavailable === true);
  const diffFiles = diffText ? splitDiff(diffText) : [];
  return {
    parseError,
    raw: raw || (details?.fresh ? "Not started" : "Run details are unavailable."),
    evidence,
    delivery,
    files,
    summary: {
      changedFiles: [...new Set(changedFiles)],
      attempts: delivery?.attempts ?? delivery?.attemptCount,
      resultSha: stringValue(delivery?.resultSha) ?? stringValue(delivery?.deliveryCommit) ?? null,
      retainedCheckout: stringValue(isObject(evidence?.workspace) ? evidence.workspace.path : undefined) ?? job.workspacePath ?? null,
    },
    diff: unavailable ? { status: "unavailable", message: "Diff evidence is unavailable.", files: [] }
      : diffTruncated ? { status: "truncated", message: "Diff evidence was truncated.", files: diffFiles }
      : diffFiles.length ? { status: diffFiles.some(file => file.malformed) ? "malformed" : "ok", files: diffFiles }
      : { status: raw ? "empty" : "unavailable", message: raw ? "No changes were reported." : "Diff evidence is not available yet.", files: [] },
    checks: groups,
    reviewMarkdown: files["review.md"]?.text ?? stringValue(delivery?.review) ?? stringValue(delivery?.reviewMarkdown),
  };
}

function StatusPill({ status }: { status: CheckStatus | string }) {
  const text = label(status);
  const cls = status === "pass" || DONE.has(status) ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : status === "fail" || FAIL.has(status) ? "bg-red-50 text-red-700 border-red-200"
    : "bg-amber-50 text-amber-700 border-amber-200";
  return <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-xs font-medium", cls)}>{text}</span>;
}

function DiffView({ data }: { data: SidebarData["diff"] }) {
  return <section className="space-y-2"><h3 className="text-sm font-semibold">Changes</h3>{data.message ? <p className="text-sm text-muted-foreground">{data.message}</p> : null}{data.files.map(file => <div key={file.name} className="overflow-hidden rounded-md border border-border"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted px-3 py-2"><span className="break-all font-mono text-xs">{file.name}</span>{file.binary || file.malformed ? <StatusPill status="unknown" /> : null}</div>{file.binary ? <p className="p-3 text-sm text-muted-foreground">Binary patch; readable text diff is not available.</p> : file.malformed ? <pre className="overflow-x-auto p-3 text-xs whitespace-pre-wrap">{file.patch}</pre> : <div className="overflow-x-auto"><ExperimentalDiff patch={file.patch} path={file.name} view="unified" overflow="scroll" className="min-w-max" /></div>}</div>)}</section>;
}

function ChecksView({ groups }: { groups: CheckGroup[] }) {
  return <section className="space-y-2"><h3 className="text-sm font-semibold">Checks</h3>{groups.length ? groups.map(group => <div key={group.title} className="rounded-md border border-border p-3"><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">{group.title}</h4><StatusPill status={group.status} /></div><div className="space-y-2">{group.checks.map((check, index) => <details key={`${check.label}-${index}`} className="rounded border border-border bg-background p-2"><summary className="cursor-pointer text-sm"><StatusPill status={check.status} /> <span className="ml-2 break-all font-mono text-xs">{check.command ?? check.label}</span></summary><div className="mt-2 space-y-2 text-xs"><p>Exit: {String(check.exitCode ?? "unknown")} · Signal: {String(check.signal ?? "none")}</p>{check.error ? <pre className="overflow-x-auto rounded bg-muted p-2 text-destructive">{String(check.error)}</pre> : null}{check.stdout ? <pre className="max-h-48 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap">{check.stdout}</pre> : null}{check.stderr ? <pre className="max-h-48 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap">{check.stderr}</pre> : null}</div></details>)}</div></div>) : <p className="text-sm text-muted-foreground">Check evidence is not available yet.</p>}</section>;
}

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
  const [details, setDetails] = useState<DetailsState>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [showFabro, setShowFabro] = useState(false);
  useEffect(() => {
    setDetails(null);
    setDetailsError(null);
    if (!id || !job) return;
    let stale = false;
    rpc.call("getRunDetails", { jobId: id, threadId: ownerThreadId }).then(r => {
      if (stale) return;
      setDetails({ text: r.details, artifacts: r.artifacts, fresh: true });
      setDetailsError(null);
    }, e => {
      if (stale) return;
      setDetails(job.result ? { text: stringifyRaw(job.result), artifacts: "", fresh: false } : null);
      setDetailsError(e instanceof Error ? e.message : String(e));
    });
    return () => { stale = true; };
  }, [id, job, rpc, ownerThreadId]);
  if (!id) return <p className="p-4 text-sm text-destructive">This panel has no job id.</p>;
  if (error) return <p className="p-4 text-sm text-destructive" role="alert">{error}</p>;
  if (!loaded) return <p className="p-4 text-sm text-muted-foreground" role="status">Loading assembly line…</p>;
  if (!job) return <p className="p-4 text-sm text-muted-foreground">Assembly line not found.</p>;
  const data = parseSidebarData(job, details);
  return <div className="h-full overflow-y-auto p-4"><div className="mx-auto max-w-xl space-y-4 overflow-hidden"><div><p className="text-xs uppercase tracking-wide text-muted-foreground">Assembly line</p><h2 className="mt-1 text-lg font-semibold">{title(job)}</h2><p className="mt-1 break-all font-mono text-xs text-muted-foreground">{job.id}</p></div><div className="rounded-lg border border-border bg-card p-4"><Progress job={job} /><GraphPreview jobId={job.id} threadId={job.threadId} runId={job.runId} status={job.engineStatus} /><p className="mt-3 text-sm text-muted-foreground">{job.workOrder.objective}</p>{job.connectionError ? <p className="mt-2 break-words text-sm text-destructive">{job.connectionError}</p> : null}</div>{detailsError ? <p className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">Run details refresh failed; showing persisted evidence if available: {detailsError}</p> : null}<section className="space-y-2 rounded-lg border border-border bg-card p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Summary</h3><StatusPill status={job.engineStatus ?? job.observationState} /></div><dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm"><dt className="text-muted-foreground">Execution</dt><dd>{label(job.engineStatus ?? job.observationState)}</dd><dt className="text-muted-foreground">Acceptance</dt><dd>{label(job.acceptanceVerdict)}{job.acceptanceReason ? ` — ${job.acceptanceReason}` : ""}</dd><dt className="text-muted-foreground">Attempts</dt><dd>{String(data.summary.attempts ?? "unknown")}</dd><dt className="text-muted-foreground">Commit</dt><dd className="break-all font-mono text-xs">{data.summary.resultSha ?? "unknown"}</dd><dt className="text-muted-foreground">Checkout</dt><dd className="break-all font-mono text-xs">{data.summary.retainedCheckout ?? "not retained yet"}</dd><dt className="text-muted-foreground">Files</dt><dd className="break-words">{data.summary.changedFiles.length ? data.summary.changedFiles.join(", ") : "unknown"}</dd></dl>{data.parseError ? <p className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800">Run details could not be parsed: {data.parseError}</p> : null}</section><DiffView data={data.diff} /><ChecksView groups={data.checks} /><section className="space-y-2"><h3 className="text-sm font-semibold">Review</h3>{data.reviewMarkdown ? <Markdown content={data.reviewMarkdown} className="text-sm" /> : <p className="text-sm text-muted-foreground">Workflow review is not available yet.</p>}<div className="rounded-md border border-border p-3 text-sm"><p className="font-medium">Thread acceptance</p><p className="mt-1 text-muted-foreground">{label(job.acceptanceVerdict)}{job.acceptanceReason ? ` — ${job.acceptanceReason}` : ""}</p></div></section><details className="rounded-lg border border-border bg-card p-3"><summary className="cursor-pointer text-sm font-medium">Raw JSON</summary><pre className="mt-2 max-h-72 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">{data.raw}</pre>{details?.artifacts ? <pre className="mt-2 max-h-48 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">{details.artifacts}</pre> : null}</details>{showFabro && job.fabroUrl ? <div className="overflow-hidden rounded-lg border border-border"><iframe title="Fabro run" src={job.fabroUrl} sandbox="allow-scripts allow-forms" className="h-96 w-full" /><p className="border-t border-border p-2 text-xs text-muted-foreground">Fabro is isolated in a sandbox. Use the external link if this run requires host features.</p></div> : null}<div className="flex flex-wrap gap-2">{job.fabroUrl ? <><Button variant="outline" onClick={() => setShowFabro(value => !value)}><Icon name="PanelRight" className="size-4" />{showFabro ? "Hide Fabro" : "View Fabro"}</Button><Button variant="outline" onClick={() => navigate.openUrl(job.fabroUrl!)}><Icon name="ExternalLink" className="size-4" />Open externally</Button></> : <p className="text-xs text-muted-foreground">Fabro run link is not available yet.</p>}{DONE.has(job.acceptanceVerdict) ? <Button onClick={() => navigate.toThread(job.threadId)}><Icon name="Check" className="size-4" />Return for acceptance</Button> : null}</div></div></div>;
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
