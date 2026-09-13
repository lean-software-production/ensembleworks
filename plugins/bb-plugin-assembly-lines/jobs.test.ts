import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { JobStore } from "./jobs";

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const input = (requestKey = "req-1") => ({
  threadId: "thread-1", projectId: "project-1", environmentId: "env-1", hostId: "host-1",
  workspacePath: "/tmp/workspace", workflowVersionId: "wf-7", engineUrl: "http://fabro", sourcePath: "pipeline.json",
  requestKey, workOrder: { title: "Refactor", objective: "Do the work", scope: ["src"], count: 2 },
});
function setup() { const db = new Database(":memory:"); dbs.push(db); return { db, store: new JobStore(db) }; }

describe("durable assembly-line jobs", () => {
  it("deduplicates the same request key and rejects changed retries", () => {
    const { store } = setup();
    const first = store.create(input());
    const retry = store.create(input());
    expect(retry.created).toBe(false);
    expect(retry.job.id).toBe(first.job.id);
    expect(() => store.create({ ...input(), workOrder: { title: "different" } })).toThrow(/different input/);
  });

  it("survives reconstruction with immutable work order and origin metadata", () => {
    const { db, store } = setup();
    const made = store.create(input()).job;
    const reopened = new JobStore(db);
    expect(reopened.get(made.id)).toMatchObject({
      workOrder: input().workOrder, workspacePath: "/tmp/workspace", workflowVersionId: "wf-7",
      engineUrl: "http://fabro", sourcePath: "pipeline.json", createState: "pending",
      observationState: "unreachable", completionState: "pending", acceptanceVerdict: "pending",
    });
  });

  it("keeps engine reachability separate from observed execution and delivery", () => {
    const { store } = setup(); const job = store.create(input()).job;
    expect(store.associateRun(job.id, "run-1")).toMatchObject({ runId: "run-1", createState: "confirmed", observationState: "pending" });
    expect(store.recordObservation(job.id, "succeeded", { revision: 1, output: "ok" }, "finished", 1)).toMatchObject({ observationState: "succeeded", resultRevision: 1 });
    expect(store.recordCompletionDispatch(job.id, "uncertain", null, "crashed after send")).toMatchObject({ completionState: "uncertain" });
    expect(store.recordAcceptance(job.id, "accepted", "criteria met", 1)).toMatchObject({ acceptanceVerdict: "accepted", acceptanceResultRevision: 1 });
    expect(store.recordObservation(job.id, "succeeded", undefined, "duplicate terminal poll", 1)).toMatchObject({ acceptanceVerdict: "accepted", resultRevision: 1 });
    expect(() => store.recordObservation(job.id, "succeeded", { changed: true }, undefined, 2)).toThrow(/after acceptance/);
  });

  it("allows crash reconciliation without blindly retrying an uncertain create or send", () => {
    const { store } = setup(); const job = store.create(input()).job;
    expect(store.recordCreateReconciliation(job.id, "uncertain", "request may have reached Fabro").createState).toBe("uncertain");
    expect(store.recordCompletionDispatch(job.id, "uncertain", null, "marker search required").completionState).toBe("uncertain");
    expect(() => store.recordAcceptance(job.id, "accepted", "missing revision")).toThrow(/result revision/);
  });

  it("allows rework or input requests for failed terminal executions", () => {
    const { store } = setup(); const job = store.create(input()).job;
    store.recordObservation(job.id, "failed", { error: "tests failed" }, "failed", 1);
    expect(store.recordAcceptance(job.id, "rework", "Fix the failing tests", 1).acceptanceVerdict).toBe("rework");
    expect(() => store.recordAcceptance(job.id, "accepted", "looks good", 1)).toThrow(/succeeded observation/);
  });

  it("returns bounded cursor pages", () => {
    const { store } = setup();
    store.create(input("a"), 10); store.create({ ...input("b"), threadId: "thread-2" }, 20); store.create(input("c"), 30);
    const first = store.list({ threadId: "thread-1", limit: 1 });
    expect(first.jobs).toHaveLength(1); expect(first.nextCursor).toBeTruthy();
    expect(store.list({ threadId: "thread-1", limit: 1, after: first.nextCursor! }).jobs.map(j => j.requestKey)).toEqual(["c"]);
    expect(() => store.list({ limit: 101 })).toThrow(/between/);
  });

  it("polls only unsettled jobs and keeps cursor ordering stable", () => {
    const { store } = setup();
    const pending = store.create(input("pending"), 10).job;
    const settled = store.create(input("settled"), 20).job;
    store.associateRun(settled.id, "run-settled");
    store.recordObservation(settled.id, "succeeded", { ok: true }, undefined, 1);
    store.recordCompletionDispatch(settled.id, "delivered", "msg-1");
    store.recordAcceptance(settled.id, "accepted", "done", 1);
    expect(store.listPending().jobs.map(job => job.id)).toEqual([pending.id]);
  });
});
