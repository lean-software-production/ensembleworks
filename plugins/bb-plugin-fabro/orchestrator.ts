import type { FabroRun } from "./fabro";
import { JobStore, type Job, type JsonValue, type ObservationState } from "./jobs";

export interface Runner {
  prepare(job: Job): Promise<{ workspacePath: string; workflowVersionId: string }>;
  create(job: Job): Promise<FabroRun>;
  reconcile(job: Job): Promise<{ runs: FabroRun[]; complete: boolean }>;
  start(job: Job): Promise<FabroRun>;
  inspect(job: Job): Promise<FabroRun>;
  evidence(job: Job): Promise<unknown>;
}
export interface Delivery {
  send(job: Job): Promise<string | null>;
  find(job: Job): Promise<string | null>;
  available(job: Job): Promise<boolean>;
}
const terminal = new Set(["succeeded", "failed", "dead"]);
export function engineStatus(run: FabroRun): string {
  const kind = run.lifecycle?.status?.kind;
  if (typeof kind !== "string") throw new Error("Fabro returned no lifecycle status; refusing to infer completion");
  return kind;
}
function observation(status: string): ObservationState {
  if (status === "succeeded") return "succeeded";
  if (status === "failed" || status === "dead") return "failed";
  if (["starting", "running", "runnable", "blocked", "paused"].includes(status)) return "running";
  return "pending";
}
function asJson(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || encoded.length > 200_000) throw new Error("Delivery exceeds the 200 KB snapshot limit; inspect Fabro for full evidence");
  return JSON.parse(encoded) as JsonValue;
}
function message(error: unknown): string { return error instanceof Error ? error.message.slice(0, 2000) : "Operation failed"; }

/** One serialized reconciler per job. Persist uncertainty before external mutations. */
export class Orchestrator {
  private readonly active = new Map<string, Promise<void>>();
  constructor(readonly store: JobStore, private runner: Runner, private delivery: Delivery, private changed: (job: Job) => void) {}

  tick(jobId: string): Promise<void> {
    const running = this.active.get(jobId);
    if (running) return running;
    const next = this.reconcile(jobId).finally(() => { this.active.delete(jobId); });
    this.active.set(jobId, next);
    return next;
  }

  private async reconcile(jobId: string): Promise<void> {
    try {
      let job = this.store.get(jobId);
      if (job.createState === "failed") return;
      if (!job.runId) {
        if (job.createState === "uncertain") {
          const existing = await this.runner.reconcile(job);
          if (existing.runs.length !== 1) {
            this.store.recordCreateReconciliation(job.id, "uncertain", existing.runs.length > 1
              ? "Multiple Fabro runs match this job; inspect before selecting one."
              : "Submission outcome remains uncertain. No automatic resubmission; inspect Fabro before retrying.");
            return;
          }
          job = this.store.associateRun(job.id, existing.runs[0]!.id);
        } else {
          if (!job.workspacePath) job = this.store.setPrepared(job.id, await this.runner.prepare(job));
          // This marker survives a process exit even when Fabro received the request.
          this.store.recordCreateReconciliation(job.id, "uncertain", "Creating Fabro run; reconciliation required if interrupted.");
          const run = await this.runner.create(this.store.get(job.id));
          if (!run.id) throw new Error("Fabro create returned no run ID");
          job = this.store.associateRun(job.id, run.id);
        }
      }

      // Preserve the exact delivery once captured. Later engine edits require a new job.
      if (job.resultRevision === null) {
        let run = await this.runner.inspect(job);
        let status = engineStatus(run);
        if (status === "submitted") {
          await this.runner.start(job);
          run = await this.runner.inspect(job);
          status = engineStatus(run);
        }
        const state = observation(status);
        job = this.store.recordObservation(job.id, state, undefined, null, undefined, Date.now(), status, null);
        if (!terminal.has(status)) return;
        const evidence = await this.runner.evidence(job);
        job = this.store.recordObservation(job.id, state, asJson(evidence), null, 1, Date.now(), status, null);
      }

      if (job.completionState === "delivered" || job.completionState === "failed") return;
      if (job.completionState === "sending" || job.completionState === "uncertain") {
        const found = await this.delivery.find(job);
        this.store.recordCompletionDispatch(job.id, found ? "delivered" : "uncertain", found,
          found ? null : "Acceptance dispatch may already have reached the thread. Inspect before explicitly redelivering.");
        return;
      }
      if (!(await this.delivery.available(job))) return;
      this.store.recordCompletionDispatch(job.id, "sending");
      try {
        const sentId = await this.delivery.send(job);
        this.store.recordCompletionDispatch(job.id, "delivered", sentId);
      } catch (error) {
        this.store.recordCompletionDispatch(job.id, "uncertain", null, message(error));
      }
    } catch (error) {
      const job = this.store.get(jobId);
      this.store.recordObservation(job.id, job.observationState, undefined, job.observationDetail, undefined,
        Date.now(), job.engineStatus, message(error));
    } finally {
      this.changed(this.store.get(jobId));
    }
  }
}
