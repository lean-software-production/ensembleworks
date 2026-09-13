/**
 * SQLite-backed run/stage/event store, per
 * docs/plans/2026-09-13-attractor-runner-plan.md "Plugin layout"
 * (`server/store.ts`) and T4's "persists a run" / "Runs survive plugin
 * restart via the checkpoint" acceptance criteria.
 *
 * Takes a `better-sqlite3` handle directly (like the sibling
 * `bb-plugin-assembly-lines`'s `JobStore`), so it is testable against a real
 * in-memory database without a fake plugin host; `server.ts` hands it
 * `bb.storage.database()`.
 */

import type Database from "better-sqlite3";
import type { Checkpoint, JsonValue, Outcome, OutcomeStatus, RunEvent } from "../engine/types";

export const RUN_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS attractor_runs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    project_id TEXT,
    environment_id TEXT,
    title TEXT,
    source TEXT NOT NULL,
    graph_json TEXT NOT NULL,
    status TEXT NOT NULL,
    current_node_id TEXT,
    context_json TEXT NOT NULL,
    checkpoint_json TEXT,
    goal_gate_failures_json TEXT NOT NULL,
    final_outcome_json TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS attractor_runs_thread_cursor ON attractor_runs(thread_id, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS attractor_runs_status ON attractor_runs(status)`,
  `CREATE TABLE IF NOT EXISTS attractor_stages (
    run_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    visit INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL,
    outcome_status TEXT,
    thread_id TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    PRIMARY KEY (run_id, node_id, visit)
  )`,
  `CREATE TABLE IF NOT EXISTS attractor_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS attractor_events_run_seq ON attractor_events(run_id, seq)`,
] as const;

// "blocked" (T6): a run/stage waiting on a human gate's answer — set by
// server/service.ts's applyEventToStore on a `human.requested` event and
// cleared back to "running" on `human.answered`, never persisted as a
// terminal status (recordFinish only ever writes succeeded/failed/cancelled).
export type RunStatus = "running" | "blocked" | "succeeded" | "failed" | "cancelled";
export type StageStatus = "running" | "blocked" | "succeeded" | "failed" | "skipped";

export interface CreateRunInput {
  id: string;
  threadId: string;
  projectId: string | null;
  environmentId: string | null;
  title: string | null;
  source: string;
  graph: unknown;
  initialContext: Record<string, JsonValue>;
}

export interface Run {
  id: string;
  threadId: string;
  projectId: string | null;
  environmentId: string | null;
  title: string | null;
  source: string;
  graph: unknown;
  status: RunStatus;
  currentNodeId: string | null;
  context: Record<string, JsonValue>;
  goalGateFailures: string[];
  finalOutcome: Outcome | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface Stage {
  runId: string;
  stageId: string;
  nodeId: string;
  visit: number;
  attempt: number;
  status: StageStatus;
  outcomeStatus: OutcomeStatus | null;
  threadId: string | null;
  startedAt: number;
  completedAt: number | null;
}

export interface UpsertStageInput {
  stageId: string;
  nodeId: string;
  visit: number;
  attempt: number;
  status: StageStatus;
  outcomeStatus: OutcomeStatus | null;
  threadId: string | null;
  startedAt: number;
  completedAt?: number | null;
}

export interface RunPage {
  runs: Run[];
  nextCursor: string | null;
}

type RunRow = {
  id: string;
  thread_id: string;
  project_id: string | null;
  environment_id: string | null;
  title: string | null;
  source: string;
  graph_json: string;
  status: string;
  current_node_id: string | null;
  context_json: string;
  checkpoint_json: string | null;
  goal_gate_failures_json: string;
  final_outcome_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
};

type StageRow = {
  run_id: string;
  stage_id: string;
  node_id: string;
  visit: number;
  attempt: number;
  status: string;
  outcome_status: string | null;
  thread_id: string | null;
  started_at: number;
  completed_at: number | null;
};

type EventRow = { seq: number; run_id: string; ts: number; type: string; payload_json: string };

const MAX_LIMIT = 200;

function encodeCursor(createdAt: number, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): { createdAt: number; id: string } | null {
  if (!value) return null;
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { createdAt: number; id: string };
  if (!Number.isFinite(parsed.createdAt) || typeof parsed.id !== "string") throw new Error("invalid run cursor");
  return parsed;
}

export class RunStore {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
    db.transaction(() => RUN_MIGRATIONS.forEach((statement) => db.exec(statement)))();
  }

  createRun(input: CreateRunInput, now = Date.now()): Run {
    const existing = this.#db.prepare("SELECT id FROM attractor_runs WHERE id=?").get(input.id);
    if (existing) throw new Error(`Run already exists: ${input.id}`);
    this.#db
      .prepare(
        `INSERT INTO attractor_runs
          (id, thread_id, project_id, environment_id, title, source, graph_json, status, current_node_id,
           context_json, checkpoint_json, goal_gate_failures_json, final_outcome_json, error, created_at, updated_at, finished_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.id,
        input.threadId,
        input.projectId,
        input.environmentId,
        input.title,
        input.source,
        JSON.stringify(input.graph),
        "running",
        null,
        JSON.stringify(input.initialContext ?? {}),
        null,
        JSON.stringify([]),
        null,
        null,
        now,
        now,
        null,
      );
    return this.getRun(input.id);
  }

  getRun(id: string): Run {
    const row = this.#db.prepare("SELECT * FROM attractor_runs WHERE id=?").get(id) as RunRow | undefined;
    if (!row) throw new Error(`Run not found: ${id}`);
    return this.#toRun(row);
  }

  tryGetRun(id: string): Run | null {
    const row = this.#db.prepare("SELECT * FROM attractor_runs WHERE id=?").get(id) as RunRow | undefined;
    return row ? this.#toRun(row) : null;
  }

  listRuns(options: { threadId: string; limit?: number; after?: string }): RunPage {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`limit must be between 1 and ${MAX_LIMIT}`);
    const cursor = decodeCursor(options.after);
    const where = ["thread_id = ?"];
    const params: unknown[] = [options.threadId];
    if (cursor) {
      where.push("(created_at > ? OR (created_at = ? AND id > ?))");
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const rows = this.#db
      .prepare(`SELECT * FROM attractor_runs WHERE ${where.join(" AND ")} ORDER BY created_at, id LIMIT ?`)
      .all(...params, limit + 1) as RunRow[];
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const runs = rows.map((row) => this.#toRun(row));
    const last = runs.at(-1);
    return { runs, nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null };
  }

  /** Every run still in flight for the background service to resume on plugin (re)start — "running" and "blocked" (T6: a plugin restart while a human gate is waiting must not strand the run). */
  listRunningRunIds(): string[] {
    const rows = this.#db.prepare("SELECT id FROM attractor_runs WHERE status IN ('running', 'blocked') ORDER BY created_at, id").all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  saveCheckpoint(id: string, checkpoint: Checkpoint, now = Date.now()): Run {
    this.getRun(id);
    this.#db
      .prepare("UPDATE attractor_runs SET current_node_id=?, context_json=?, checkpoint_json=?, updated_at=? WHERE id=?")
      .run(checkpoint.nextNodeId, JSON.stringify(checkpoint.context), JSON.stringify(checkpoint), now, id);
    return this.getRun(id);
  }

  loadCheckpoint(id: string): Checkpoint | null {
    const row = this.#db.prepare("SELECT checkpoint_json FROM attractor_runs WHERE id=?").get(id) as { checkpoint_json: string | null } | undefined;
    if (!row) throw new Error(`Run not found: ${id}`);
    return row.checkpoint_json ? (JSON.parse(row.checkpoint_json) as Checkpoint) : null;
  }

  recordFinish(
    id: string,
    result: { status: RunStatus; finalOutcome: Outcome | null; goalGateFailures: string[]; context: Record<string, JsonValue>; error?: string | null },
    now = Date.now(),
  ): Run {
    this.getRun(id);
    this.#db
      .prepare(
        `UPDATE attractor_runs
         SET status=?, final_outcome_json=?, goal_gate_failures_json=?, context_json=?, error=?, updated_at=?, finished_at=?
         WHERE id=?`,
      )
      .run(
        result.status,
        result.finalOutcome ? JSON.stringify(result.finalOutcome) : null,
        JSON.stringify(result.goalGateFailures),
        JSON.stringify(result.context),
        result.error ?? null,
        now,
        now,
        id,
      );
    return this.getRun(id);
  }

  /** Sets a run's status directly, without touching finishedAt/error/etc. — used for the transient "blocked" state (T6). */
  setStatus(id: string, status: RunStatus, now = Date.now()): Run {
    this.getRun(id);
    this.#db.prepare("UPDATE attractor_runs SET status=?, updated_at=? WHERE id=?").run(status, now, id);
    return this.getRun(id);
  }

  /** Sets one stage row's status directly, without touching its other fields — used for the transient "blocked" state (T6). */
  setStageStatus(runId: string, nodeId: string, visit: number, status: StageStatus): void {
    this.#db.prepare("UPDATE attractor_stages SET status=? WHERE run_id=? AND node_id=? AND visit=?").run(status, runId, nodeId, visit);
  }

  upsertStage(runId: string, input: UpsertStageInput): void {
    this.#db
      .prepare(
        `INSERT INTO attractor_stages (run_id, stage_id, node_id, visit, attempt, status, outcome_status, thread_id, started_at, completed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(run_id, node_id, visit) DO UPDATE SET
           stage_id=excluded.stage_id, attempt=excluded.attempt, status=excluded.status, outcome_status=excluded.outcome_status,
           thread_id=coalesce(excluded.thread_id, attractor_stages.thread_id), completed_at=excluded.completed_at`,
      )
      .run(runId, input.stageId, input.nodeId, input.visit, input.attempt, input.status, input.outcomeStatus, input.threadId, input.startedAt, input.completedAt ?? null);
  }

  /** Attaches a worker threadId to an already-started stage row (the `agent.thread` event). */
  setStageThreadId(runId: string, nodeId: string, visit: number, threadId: string): void {
    this.#db.prepare("UPDATE attractor_stages SET thread_id=? WHERE run_id=? AND node_id=? AND visit=?").run(threadId, runId, nodeId, visit);
  }

  listStages(runId: string): Stage[] {
    // rowid (not started_at) preserves first-insertion order even when two
    // stages start within the same clock millisecond (a real risk with the
    // real Date.now()-backed clock) — an UPDATE via the upsert's ON CONFLICT
    // clause keeps the original row's rowid, so this stays stable across
    // subsequent attempts of the same (run_id, node_id, visit).
    const rows = this.#db.prepare("SELECT * FROM attractor_stages WHERE run_id=? ORDER BY rowid").all(runId) as StageRow[];
    return rows.map((row) => ({
      runId: row.run_id,
      stageId: row.stage_id,
      nodeId: row.node_id,
      visit: row.visit,
      attempt: row.attempt,
      status: row.status as StageStatus,
      outcomeStatus: (row.outcome_status as OutcomeStatus | null) ?? null,
      threadId: row.thread_id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    }));
  }

  appendEvent(runId: string, event: RunEvent): number {
    const result = this.#db
      .prepare("INSERT INTO attractor_events (run_id, ts, type, payload_json) VALUES (?,?,?,?)")
      .run(runId, event.ts, event.type, JSON.stringify(event));
    return Number(result.lastInsertRowid);
  }

  listEvents(runId: string, sinceSeq?: number): (RunEvent & { seq: number })[] {
    const rows = sinceSeq
      ? (this.#db.prepare("SELECT * FROM attractor_events WHERE run_id=? AND seq > ? ORDER BY seq").all(runId, sinceSeq) as EventRow[])
      : (this.#db.prepare("SELECT * FROM attractor_events WHERE run_id=? ORDER BY seq").all(runId) as EventRow[]);
    return rows.map((row) => ({ ...(JSON.parse(row.payload_json) as RunEvent), seq: row.seq }));
  }

  #toRun(row: RunRow): Run {
    return {
      id: row.id,
      threadId: row.thread_id,
      projectId: row.project_id,
      environmentId: row.environment_id,
      title: row.title,
      source: row.source,
      graph: JSON.parse(row.graph_json),
      status: row.status as RunStatus,
      currentNodeId: row.current_node_id,
      context: JSON.parse(row.context_json) as Record<string, JsonValue>,
      goalGateFailures: JSON.parse(row.goal_gate_failures_json) as string[],
      finalOutcome: row.final_outcome_json ? (JSON.parse(row.final_outcome_json) as Outcome) : null,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at,
    };
  }
}
