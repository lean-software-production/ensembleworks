import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/** Append-only migration statements for the assembly-line job store. */
export const JOB_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS assembly_jobs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    project_id TEXT,
    environment_id TEXT,
    host_id TEXT,
    workspace_path TEXT,
    workflow_version_id TEXT,
    engine_url TEXT,
    source_path TEXT,
    request_key TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    work_order_json TEXT NOT NULL,
    run_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    create_state TEXT NOT NULL,
    create_detail TEXT,
    observation_state TEXT NOT NULL,
    engine_status TEXT,
    connection_error TEXT,
    observation_detail TEXT,
    result_revision INTEGER,
    result_json TEXT,
    completion_state TEXT NOT NULL,
    completion_detail TEXT,
    completion_message_id TEXT,
    acceptance_verdict TEXT NOT NULL,
    acceptance_reason TEXT,
    acceptance_result_revision INTEGER,
    UNIQUE(thread_id, request_key)
  )`,
  `CREATE INDEX IF NOT EXISTS assembly_jobs_thread_cursor
    ON assembly_jobs(thread_id, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS assembly_jobs_pending
    ON assembly_jobs(create_state, observation_state, completion_state, created_at, id)`,
] as const;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type CreateState = "pending" | "confirmed" | "uncertain" | "failed";
export type ObservationState = "unreachable" | "pending" | "running" | "succeeded" | "failed" | "unknown";
export type CompletionState = "pending" | "sending" | "delivered" | "uncertain" | "failed";
export type AcceptanceVerdict = "pending" | "accepted" | "rework" | "needs_input";

export interface JobInput {
  threadId: string;
  projectId?: string | null;
  environmentId?: string | null;
  hostId?: string | null;
  workspacePath?: string | null;
  workflowVersionId?: string | null;
  engineUrl?: string | null;
  sourcePath?: string | null;
  requestKey: string;
  workOrder: JsonValue;
}

export interface Job {
  id: string;
  threadId: string;
  projectId: string | null;
  environmentId: string | null;
  hostId: string | null;
  workspacePath: string | null;
  workflowVersionId: string | null;
  engineUrl: string | null;
  sourcePath: string | null;
  requestKey: string;
  inputHash: string;
  workOrder: JsonValue;
  runId: string | null;
  createdAt: number;
  updatedAt: number;
  createState: CreateState;
  createDetail: string | null;
  observationState: ObservationState;
  engineStatus: string | null;
  connectionError: string | null;
  observationDetail: string | null;
  resultRevision: number | null;
  result: JsonValue | null;
  completionState: CompletionState;
  completionDetail: string | null;
  completionMessageId: string | null;
  acceptanceVerdict: AcceptanceVerdict;
  acceptanceReason: string | null;
  acceptanceResultRevision: number | null;
}

export interface Cursor { createdAt: number; id: string }
export interface JobPage { jobs: Job[]; nextCursor: string | null }

type Row = Omit<Job, "workOrder" | "result"> & { work_order_json: string; result_json: string | null; [key: string]: unknown };

const MAX_LIMIT = 100;
const id = (name: string, value: string) => {
  if (typeof value !== "string" || value.trim() === "" || value.length > 512) throw new Error(`${name} must be a non-empty string`);
  return value;
};
const detail = (value: string | null | undefined) => value == null ? null : value.slice(0, 8_000);
function stable(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k]!)}`).join(",")}}`;
}
function hashInput(input: JobInput): string {
  return createHash("sha256").update(stable({
    threadId: input.threadId, projectId: input.projectId ?? null, environmentId: input.environmentId ?? null,
    hostId: input.hostId ?? null, workspacePath: input.workspacePath ?? null,
    workflowVersionId: input.workflowVersionId ?? null, engineUrl: input.engineUrl ?? null,
    sourcePath: input.sourcePath ?? null, requestKey: input.requestKey, workOrder: input.workOrder,
  })).digest("hex");
}
function encodeCursor(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url"); }
function decodeCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    if (!Number.isSafeInteger(parsed.createdAt) || typeof parsed.id !== "string") throw new Error();
    return parsed;
  } catch { throw new Error("Invalid job cursor"); }
}

export class JobStore {
  readonly #db: Database.Database;
  constructor(db: Database.Database) {
    this.#db = db;
    db.transaction(() => JOB_MIGRATIONS.forEach(statement => db.exec(statement)))();
  }

  create(input: JobInput, now = Date.now()): { job: Job; created: boolean } {
    id("threadId", input.threadId); id("requestKey", input.requestKey);
    const hash = hashInput(input);
    const existing = this.#db.prepare("SELECT * FROM assembly_jobs WHERE thread_id=? AND request_key=?").get(input.threadId, input.requestKey) as Row | undefined;
    if (existing) {
      if (existing.input_hash !== hash) throw new Error("requestKey already exists with different input");
      return { job: this.#read(existing), created: false };
    }
    const jobId = randomUUID();
    this.#db.prepare(`INSERT INTO assembly_jobs
      (id,thread_id,project_id,environment_id,host_id,workspace_path,workflow_version_id,engine_url,source_path,request_key,input_hash,work_order_json,created_at,updated_at,
       create_state,observation_state,completion_state,acceptance_verdict)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      jobId, input.threadId, input.projectId ?? null, input.environmentId ?? null, input.hostId ?? null,
      input.workspacePath ?? null, input.workflowVersionId ?? null, input.engineUrl ?? null, input.sourcePath ?? null,
      input.requestKey, hash, stable(input.workOrder), now, now, "pending", "unreachable", "pending", "pending",
    );
    return { job: this.get(jobId), created: true };
  }

  createJob(input: JobInput, now = Date.now()): { job: Job; created: boolean } { return this.create(input, now); }

  get(jobId: string): Job {
    id("jobId", jobId);
    const row = this.#db.prepare("SELECT * FROM assembly_jobs WHERE id=?").get(jobId) as Row | undefined;
    if (!row) throw new Error(`Job not found: ${jobId}`);
    return this.#read(row);
  }

  getJob(jobId: string): Job { return this.get(jobId); }

  list(options: { threadId?: string; limit?: number; after?: string } = {}): JobPage {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`limit must be between 1 and ${MAX_LIMIT}`);
    const cursor = decodeCursor(options.after);
    const where: string[] = []; const params: unknown[] = [];
    if (options.threadId !== undefined) { id("threadId", options.threadId); where.push("thread_id=?"); params.push(options.threadId); }
    if (cursor) { where.push("(created_at > ? OR (created_at = ? AND id > ?))"); params.push(cursor.createdAt, cursor.createdAt, cursor.id); }
    const rows = this.#db.prepare(`SELECT * FROM assembly_jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at,id LIMIT ?`).all(...params, limit + 1) as Row[];
    const hasMore = rows.length > limit; if (hasMore) rows.pop();
    const jobs = rows.map(row => this.#read(row));
    return { jobs, nextCursor: hasMore && jobs.length ? encodeCursor({ createdAt: jobs.at(-1)!.createdAt, id: jobs.at(-1)!.id }) : null };
  }

  listJobs(options: { threadId?: string; limit?: number; after?: string } = {}): JobPage { return this.list(options); }

  /** Rows needing reconciliation, completion retry, or acceptance polling. */
  listPending(limit = 50, after?: string): JobPage {
    const checked = limit;
    if (!Number.isInteger(checked) || checked < 1 || checked > MAX_LIMIT) throw new Error(`limit must be between 1 and ${MAX_LIMIT}`);
    const cursor = decodeCursor(after);
    const where = ["(create_state IN ('pending','uncertain') OR observation_state IN ('pending','running','unknown') OR completion_state IN ('pending','sending','uncertain') OR acceptance_verdict='pending')"];
    const params: unknown[] = [];
    if (cursor) { where.push("(created_at > ? OR (created_at = ? AND id > ?))"); params.push(cursor.createdAt, cursor.createdAt, cursor.id); }
    const rows = this.#db.prepare(`SELECT * FROM assembly_jobs WHERE ${where.join(" AND ")} ORDER BY created_at,id LIMIT ?`).all(...params, checked + 1) as Row[];
    const hasMore = rows.length > checked; if (hasMore) rows.pop();
    const jobs = rows.map(row => this.#read(row));
    return { jobs, nextCursor: hasMore && jobs.length ? encodeCursor({ createdAt: jobs.at(-1)!.createdAt, id: jobs.at(-1)!.id }) : null };
  }

  /** Persist host preparation exactly once; later retries cannot retarget a job. */
  setPrepared(jobId: string, prepared: { workspacePath: string; workflowVersionId: string; engineUrl?: string | null; sourcePath?: string | null }, now = Date.now()): Job {
    const job = this.get(jobId);
    if (job.workspacePath !== null && (job.workspacePath !== prepared.workspacePath || job.workflowVersionId !== prepared.workflowVersionId)) {
      throw new Error("job preparation is immutable");
    }
    this.#db.prepare("UPDATE assembly_jobs SET workspace_path=?,workflow_version_id=?,engine_url=coalesce(engine_url,?),source_path=coalesce(source_path,?),updated_at=? WHERE id=?")
      .run(prepared.workspacePath, prepared.workflowVersionId, prepared.engineUrl ?? null, prepared.sourcePath ?? null, now, jobId);
    return this.get(jobId);
  }

  associateRun(jobId: string, runId: string, now = Date.now()): Job {
    id("runId", runId); const job = this.get(jobId);
    if (job.runId !== null && job.runId !== runId) throw new Error("job already has a different runId");
    this.#db.prepare(`UPDATE assembly_jobs SET run_id=?,create_state='confirmed',observation_state=CASE WHEN observation_state='unreachable' THEN 'pending' ELSE observation_state END,updated_at=? WHERE id=?`).run(runId, now, jobId);
    return this.get(jobId);
  }

  recordCreateReconciliation(jobId: string, state: CreateState, createDetail?: string | null, now = Date.now()): Job {
    this.get(jobId); this.#db.prepare("UPDATE assembly_jobs SET create_state=?,create_detail=?,updated_at=? WHERE id=?").run(state, detail(createDetail), now, jobId); return this.get(jobId);
  }

  recordObservation(jobId: string, state: ObservationState, result?: JsonValue | null, observationDetail?: string | null, resultRevision?: number | null, now = Date.now(), engineStatus?: string | null, connectionError?: string | null): Job {
    this.get(jobId);
    if (resultRevision !== undefined && resultRevision !== null && (!Number.isSafeInteger(resultRevision) || resultRevision < 0)) throw new Error("resultRevision must be a non-negative integer");
    const previous = this.get(jobId);
    if (previous.acceptanceVerdict !== "pending" && (state !== previous.observationState || result !== undefined || (resultRevision !== undefined && resultRevision !== previous.resultRevision))) {
      throw new Error("cannot change an observed result after acceptance");
    }
    if (previous.observationState === "succeeded" && state === "succeeded" && resultRevision !== undefined && resultRevision !== previous.resultRevision) {
      // A new revision is a new delivery and must first clear the old verdict explicitly.
      if (previous.acceptanceVerdict !== "pending") throw new Error("cannot revise an accepted result");
    }
    this.#db.prepare(`UPDATE assembly_jobs SET observation_state=?,engine_status=?,connection_error=?,observation_detail=?,result_json=?,result_revision=?,updated_at=? WHERE id=?`).run(
      state, engineStatus ?? previous.engineStatus, connectionError === undefined ? previous.connectionError : detail(connectionError),
      detail(observationDetail), result === undefined ? previous.result === null ? null : stable(previous.result) : result === null ? null : stable(result),
      resultRevision === undefined ? previous.resultRevision : resultRevision ?? null, now, jobId);
    return this.get(jobId);
  }

  recordCompletionDispatch(jobId: string, state: CompletionState, messageId?: string | null, completionDetail?: string | null, now = Date.now()): Job {
    this.get(jobId); this.#db.prepare("UPDATE assembly_jobs SET completion_state=?,completion_message_id=?,completion_detail=?,updated_at=? WHERE id=?").run(state, messageId ?? null, detail(completionDetail), now, jobId); return this.get(jobId);
  }

  recordAcceptance(jobId: string, verdict: AcceptanceVerdict, reason?: string | null, resultRevision?: number | null, now = Date.now()): Job {
    const job = this.get(jobId);
    if (verdict !== "pending" && (resultRevision === undefined || resultRevision === null)) throw new Error("acceptance must reference a result revision");
    if (verdict === "accepted" && job.observationState !== "succeeded") throw new Error("acceptance requires a succeeded observation");
    if (verdict !== "pending" && !["succeeded", "failed"].includes(job.observationState)) throw new Error("acceptance requires a terminal observation");
    if (verdict !== "pending" && resultRevision !== job.resultRevision) throw new Error("acceptance revision does not match the stored result");
    if (job.acceptanceVerdict === verdict && job.acceptanceResultRevision === (resultRevision ?? null)) return job;
    this.#db.prepare("UPDATE assembly_jobs SET acceptance_verdict=?,acceptance_reason=?,acceptance_result_revision=?,updated_at=? WHERE id=?").run(verdict, detail(reason), resultRevision ?? null, now, jobId); return this.get(jobId);
  }

  #read(row: Row): Job {
    return {
      id: String(row.id), threadId: String(row.thread_id), projectId: row.project_id as string | null,
      environmentId: row.environment_id as string | null, hostId: row.host_id as string | null,
      workspacePath: row.workspace_path as string | null, workflowVersionId: row.workflow_version_id as string | null,
      engineUrl: row.engine_url as string | null, sourcePath: row.source_path as string | null,
      requestKey: String(row.request_key), inputHash: String(row.input_hash), workOrder: JSON.parse(row.work_order_json),
      runId: row.run_id as string | null, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      createState: row.create_state as CreateState, createDetail: row.create_detail as string | null,
      observationState: row.observation_state as ObservationState, observationDetail: row.observation_detail as string | null,
      engineStatus: row.engine_status as string | null, connectionError: row.connection_error as string | null,
      resultRevision: row.result_revision as number | null, result: row.result_json === null ? null : JSON.parse(String(row.result_json)),
      completionState: row.completion_state as CompletionState, completionDetail: row.completion_detail as string | null,
      completionMessageId: row.completion_message_id as string | null, acceptanceVerdict: row.acceptance_verdict as AcceptanceVerdict,
      acceptanceReason: row.acceptance_reason as string | null, acceptanceResultRevision: row.acceptance_result_revision as number | null,
    };
  }
}
