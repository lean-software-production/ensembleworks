import { createHash } from "node:crypto";
import { graphSchema, type RunGraph } from './graph-contract';

/** Small, typed HTTP client for the Fabro REST API.
 *
 * Authentication is deliberately supplied by the host/plugin boundary and is
 * never part of a work order, labels, logs, or returned values.
 */
export type FabroRunStatus =
  | "submitted" | "pending" | "runnable" | "starting" | "running"
  | "blocked" | "paused" | "removing" | "succeeded" | "failed" | "dead";

export interface FabroRun {
  id: string;
  title?: string;
  goal?: string;
  labels?: Record<string, string>;
  lifecycle?: { status?: { kind?: FabroRunStatus; reason?: string }; error?: unknown; completed_at?: string | null };
  repository?: unknown;
  source_directory?: string;
  sandbox?: unknown;
  timestamps?: { created_at?: string; started_at?: string | null; completed_at?: string | null };
  diff?: unknown;
  links?: { web?: string | null };
  [key: string]: unknown;
}

export interface FabroEvent { seq?: number; event?: string; ts?: string; properties?: Record<string, unknown>; [key: string]: unknown }
export interface FabroArtifact { stage_id: string; node_slug: string; retry: number; relative_path: string; size: number; [key: string]: unknown }

export interface CreateRunIntent {
  workflow_version_id: string;
  target: { kind: "folder"; path: string } | { kind: "git"; repo: string; branch: string; sha?: string };
  args: { inputs?: Record<string, string | number | boolean>; labels?: Record<string, string>; auto_approve?: boolean; preserve_sandbox?: boolean; model?: string; provider?: string };
  title?: string;
  goal?: string;
  environment_id?: string;
  parent_id?: string;
}

export interface WorkflowPackage { entrypoint: string; files: Record<string, string>; workflow_dependencies: Record<string, string> }

export interface FabroClientOptions { baseUrl?: string; token?: string; fetch?: typeof globalThis.fetch; timeoutMs?: number; signal?: AbortSignal; maxResponseBytes?: number }

function bounded(value: string, max = 512_000): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n[truncated]`;
}

async function readBounded(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > maxBytes) { await response.body?.cancel(); return { text: `[response omitted: ${length} bytes exceeds limit]`, truncated: true }; }
  if (!response.body) return { text: bounded(await response.text(), maxBytes), truncated: length > maxBytes };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      const remaining = maxBytes - total;
      if (chunk.byteLength > remaining) { chunks.push(chunk.slice(0, Math.max(0, remaining))); total = maxBytes; truncated = true; await reader.cancel(); break; }
      chunks.push(chunk); total += chunk.byteLength;
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return { text: new TextDecoder().decode(bytes), truncated };
}

function safeErrorBody(body: unknown, status: number): unknown {
  if (status === 401 || status === 403) return undefined;
  if (typeof body === "string") return body.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/fabro_dev_[A-Za-z0-9_-]+/g, "[redacted]");
  return body;
}

export class FabroHttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: unknown) { super(message); this.name = "FabroHttpError"; }
}

export class FabroClient {
  private readonly root: string;
  private readonly requestFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly signal?: AbortSignal;
  private readonly legacyWorkflows = new Map<string, WorkflowPackage>();
  constructor(options: FabroClientOptions = {}) {
    this.root = (options.baseUrl ?? "http://127.0.0.1:3000/api/v1").replace(/\/$/, "");
    this.requestFetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 512_000;
    this.signal = options.signal;
    this.token = options.token;
  }
  private readonly token?: string;

  private async request<T>(path: string, init: RequestInit = {}, format: 'json' | 'svg' = 'json'): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", format === 'svg' ? 'image/svg+xml' : 'application/json');
    if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = this.signal && typeof AbortSignal.any === "function" ? AbortSignal.any([this.signal, timeout]) : timeout;
    const response = await this.requestFetch(`${this.root}${path}`, { ...init, headers, signal });
    const result = await readBounded(response, this.maxResponseBytes);
    const text = result.text;
    if (result.truncated) throw new FabroHttpError(502, `Fabro response exceeded ${this.maxResponseBytes} bytes for ${path}`);
    let body: unknown = undefined;
    try { body = text ? JSON.parse(text) : undefined; } catch { body = bounded(text, 8_000); }
    if (!response.ok) throw new FabroHttpError(response.status, `Fabro ${response.status} for ${path}`, safeErrorBody(body, response.status));
    if (format === 'svg') {
      if (!response.headers.get('content-type')?.includes('image/svg+xml')) throw new FabroHttpError(502, 'Fabro graph response was not SVG');
      return text as T;
    }
    if (text && typeof body === "string") throw new FabroHttpError(502, `Fabro response was not valid JSON for ${path}`);
    return body as T;
  }

  async graph(runId: string): Promise<RunGraph> {
    const path = `/runs/${encodeURIComponent(runId)}`;
    const [svg, stages] = await Promise.all([
      this.request<string>(`${path}/graph`, {}, 'svg'),
      this.request<{ data: unknown[]; meta: { has_more: boolean } }>(`${path}/stages?page%5Blimit%5D=1000`),
    ]);
    return graphSchema.parse({ svg, stages: stages.data, stagesComplete: stages.meta.has_more === false });
  }

  async registerWorkflow(version: WorkflowPackage): Promise<string> {
    try {
      const result = await this.request<{ workflow_version_id: string }>("/workflow-versions", { method: "POST", body: JSON.stringify(version) });
      if (!/^[a-f0-9]{64}$/i.test(result.workflow_version_id ?? "")) throw new FabroHttpError(502, "Fabro response schema invalid: workflow_version_id");
      return result.workflow_version_id;
    } catch (error) {
      if (!(error instanceof FabroHttpError) || error.status !== 404) throw error;
      // Fabro 0.254.0 has no immutable workflow-version endpoint. Keep the
      // package locally and submit the backwards-compatible RunManifest.
      const id = createHash("sha256").update(JSON.stringify(version)).digest("hex");
      this.legacyWorkflows.set(id, version);
      return id;
    }
  }
  async listRunsPage(label?: Record<string, string>, offset = 0): Promise<{ runs: FabroRun[]; complete: boolean; offset: number }> {
    const result = await this.request<{ data?: FabroRun[]; meta?: { has_more?: boolean } }>(`/runs?page[limit]=100&page[offset]=${offset}&include_archived=true&sort=created_at&direction=asc`);
    if (!Array.isArray(result.data)) throw new FabroHttpError(502, "Fabro response schema invalid: runs.data");
    const runs = (result.data ?? []).filter((run) => !label || Object.entries(label).every(([k, v]) => run.labels?.[k] === v));
    return { runs, offset, complete: result.meta?.has_more !== true };
  }
  async listRuns(label?: Record<string, string>): Promise<FabroRun[]> {
    return (await this.listRunsPage(label)).runs;
  }
  async createRun(intent: CreateRunIntent): Promise<FabroRun> {
    const legacy = this.legacyWorkflows.get(intent.workflow_version_id);
    const body = legacy ? {
      version: 1,
      identifier: legacy.entrypoint,
      cwd: intent.target.kind === "folder" ? intent.target.path : process.cwd(),
      title: intent.title ?? null,
      goal: { type: "value", text: intent.goal ?? "" },
      args: { model: intent.args.model, provider: intent.args.provider, environment: intent.environment_id, auto_approve: intent.args.auto_approve, preserve_sandbox: intent.args.preserve_sandbox, label: Object.entries(intent.args.labels ?? {}).map(([key, value]) => `${key}=${value}`), input: Object.entries(intent.args.inputs ?? {}).map(([key, value]) => `${key}=${value}`) },
      target: { identifier: legacy.entrypoint, path: legacy.entrypoint },
      workflows: { [legacy.entrypoint]: { identifier: legacy.entrypoint, source: legacy.files[legacy.entrypoint] ?? "", files: Object.fromEntries(Object.entries(legacy.files).map(([path, content]) => [path, { content, ref: { type: "file_inline", original: path, from: null } }])) } },
    } : intent;
    const result = await this.request<FabroRun>("/runs", { method: "POST", body: JSON.stringify(body) });
    if (typeof result.id !== "string" || result.id.length === 0) throw new FabroHttpError(502, "Fabro response schema invalid: run.id");
    return result;
  }
  async startRun(id: string): Promise<FabroRun> { const result = await this.request<FabroRun>(`/runs/${encodeURIComponent(id)}/start`, { method: "POST" }); if (typeof result.id !== "string") throw new FabroHttpError(502, "Fabro response schema invalid: run.id"); return result; }
  async inspectRun(id: string): Promise<FabroRun> { const result = await this.request<FabroRun>(`/runs/${encodeURIComponent(id)}`); if (typeof result.id !== "string") throw new FabroHttpError(502, "Fabro response schema invalid: run.id"); return result; }
  async listArtifacts(id: string): Promise<FabroArtifact[]> { const result = await this.request<{ data?: FabroArtifact[] }>(`/runs/${encodeURIComponent(id)}/artifacts`); if (!Array.isArray(result.data)) throw new FabroHttpError(502, "Fabro response schema invalid: artifacts.data"); return result.data; }
  async listEvents(id: string, sinceSeq = 1): Promise<{ data: FabroEvent[]; meta?: unknown }> {
    const result = await this.request<{ data: FabroEvent[]; meta?: unknown }>(`/runs/${encodeURIComponent(id)}/events?since_seq=${sinceSeq}&order=asc&limit=1000`);
    if (!Array.isArray(result.data)) throw new FabroHttpError(502, "Fabro response schema invalid: events.data");
    return result;
  }
  async getDiff(id: string): Promise<unknown> { return this.request<unknown>(`/runs/${encodeURIComponent(id)}/files?scope=all`); }
  async cancelRun(id: string): Promise<FabroRun> { return this.request<FabroRun>(`/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" }); }
}
