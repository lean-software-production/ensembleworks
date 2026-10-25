import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { JobStore } from "./jobs";
import { Orchestrator, type Delivery, type Runner } from "./orchestrator";
import type { FabroRun } from "./fabro";

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const run = (status: string, id = "run-1"): FabroRun => ({ id, lifecycle: { status: { kind: status as never } } });
function setup() {
  const db = new Database(":memory:"); dbs.push(db); const store = new JobStore(db);
  const job = store.create({ threadId: "thread-1", requestKey: "request-1", workOrder: {} }).job;
  store.setPrepared(job.id, { workspacePath: "/tmp/job", workflowVersionId: "v1" });
  return { store, job };
}
const noChanged = () => undefined;

describe("fabro-workflow orchestrator recovery", () => {
  it("reconciles a lost create response without creating a second run", async () => {
    const { store, job } = setup(); let creates = 0; let reconciles = 0;
    const runner: Runner = {
      prepare: async () => ({ workspacePath: "/tmp/job", workflowVersionId: "v1" }),
      create: async () => { creates++; throw new Error("response lost"); },
      reconcile: async () => { reconciles++; return { runs: [run("submitted")], complete: true }; },
      start: async () => run("running"), inspect: async () => run("succeeded"), evidence: async () => ({ ok: true }),
    };
    const delivery: Delivery = { available: async () => false, send: async () => null, find: async () => null };
    const orchestrator = new Orchestrator(store, runner, delivery, noChanged);
    await orchestrator.tick(job.id); await orchestrator.tick(job.id);
    expect(creates).toBe(1); expect(reconciles).toBe(1); expect(store.get(job.id).runId).toBe("run-1");
  });

  it("reconciles a lost completion send without sending twice", async () => {
    const { store, job } = setup(); let sends = 0; let found = false;
    const runner: Runner = {
      prepare: async () => ({ workspacePath: "/tmp/job", workflowVersionId: "v1" }),
      create: async () => run("submitted"), reconcile: async () => ({ runs: [], complete: false }),
      start: async () => run("running"), inspect: async () => run("succeeded"), evidence: async () => ({ ok: true }),
    };
    const delivery: Delivery = { available: async () => true, send: async () => { sends++; throw new Error("send response lost"); }, find: async () => found ? "queued-1" : null };
    const orchestrator = new Orchestrator(store, runner, delivery, noChanged);
    // First tick associates the run and captures evidence, then send becomes uncertain.
    await orchestrator.tick(job.id); expect(sends).toBe(1); expect(store.get(job.id).completionState).toBe("uncertain");
    found = true; await orchestrator.tick(job.id);
    expect(sends).toBe(1); expect(store.get(job.id).completionState).toBe("delivered");
  });

  it("preserves the prior engine status when inspection becomes unreachable", async () => {
    const { store, job } = setup(); let inspectCount = 0;
    const runner: Runner = {
      prepare: async () => ({ workspacePath: "/tmp/job", workflowVersionId: "v1" }),
      create: async () => run("submitted"), reconcile: async () => ({ runs: [], complete: false }),
      start: async () => run("running"), inspect: async () => { inspectCount++; if (inspectCount > 1) throw new Error("offline"); return run("running"); }, evidence: async () => ({ ok: true }),
    };
    const delivery: Delivery = { available: async () => false, send: async () => null, find: async () => null };
    const orchestrator = new Orchestrator(store, runner, delivery, noChanged);
    await orchestrator.tick(job.id); expect(store.get(job.id).engineStatus).toBe("running");
    await orchestrator.tick(job.id); expect(store.get(job.id)).toMatchObject({ engineStatus: "running", connectionError: "offline" });
  });

  it("does not re-inspect or recapture evidence after a terminal revision is stored", async () => {
    const { store, job } = setup(); let inspections = 0; let evidenceCalls = 0;
    const runner: Runner = {
      prepare: async () => ({ workspacePath: "/tmp/job", workflowVersionId: "v1" }),
      create: async () => run("succeeded"), reconcile: async () => ({ runs: [], complete: false }),
      start: async () => run("running"), inspect: async () => { inspections++; return run("succeeded"); },
      evidence: async () => { evidenceCalls++; return { ok: true }; },
    };
    const delivery: Delivery = { available: async () => false, send: async () => null, find: async () => null };
    const orchestrator = new Orchestrator(store, runner, delivery, noChanged);
    await orchestrator.tick(job.id); await orchestrator.tick(job.id);
    expect(inspections).toBe(1); expect(evidenceCalls).toBe(1); expect(store.get(job.id).resultRevision).toBe(1);
  });
});
