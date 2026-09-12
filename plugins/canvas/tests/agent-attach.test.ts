// Run: npx vitest run tests/agent-attach.test.ts
//
// WHETHER AN ATTACH IS ALLOWED, AND WHAT COLOUR THE BADGE STARTS AT. Task 2c.
// Launch can hardcode "running" because `threads.spawn` starts a turn; attach
// has no such guarantee, so the status is DERIVED from the thread bb reports —
// and the derivation, plus the three refusals, are the decisions this module
// owns.
import { describe, expect, it } from "vitest";
import {
  attachStatusFor,
  attachVerdictFor,
  type AttachProbe,
  type BbThreadStatus,
} from "../canvas/agent-attach.js";
import { AGENT_STATUSES } from "../canvas/wire.js";

function probe(overrides: Partial<AttachProbe> = {}): AttachProbe {
  return {
    id: "th_1",
    projectId: "proj_canvas",
    archivedAt: null,
    deletedAt: null,
    status: "idle",
    ...overrides,
  };
}

describe("attachStatusFor", () => {
  it("maps every bb runtime status to one of the three badge statuses", () => {
    for (const status of ["active", "error", "idle", "pending", "starting", "stopping"] as const) {
      expect(AGENT_STATUSES).toContain(attachStatusFor(status));
    }
  });

  // SDK DRIFT, not hypothetical: `BbThreadStatus` (canvas/agent-attach.ts:20)
  // is this plugin's OWN hand-written transcription of bb's statuses, and the
  // build warns the plugin pins @get-bb/plugin-sdk 0.4.21 while this bb ships
  // 0.4.47. Before this test the switch had no `default`, so a status outside
  // the five returned `undefined`; `AgentLinks.record` stores it unvalidated
  // and `agentLinkFrom` (canvas/agents.ts:103) then DROPS the broadcast — the
  // shape ends up linked server-side with NO BADGE AT ALL, which reads as
  // "attach silently did nothing".
  //
  // A badge that is merely stale self-corrects on the next thread.active /
  // thread.idle event. A missing badge never does.
  it("still answers with a real badge status for a status it does not know", () => {
    const unknown = "queued" as BbThreadStatus;
    expect(AGENT_STATUSES).toContain(attachStatusFor(unknown));
  });

  it("calls a thread mid-turn running", () => {
    expect(attachStatusFor("active")).toBe("running");
  });

  it("calls a starting thread running, as spawn's own hardcode does", () => {
    expect(attachStatusFor("starting")).toBe("running");
  });

  it("calls a stopping thread running, not finished", () => {
    // A turn being cancelled has not finished. Both readings self-correct on
    // the next thread.idle event, so the tie-break is which is wrong in the
    // meantime: "finished" claims an answer that is not there.
    expect(attachStatusFor("stopping")).toBe("running");
  });

  it("calls an idle thread idle", () => {
    expect(attachStatusFor("idle")).toBe("idle");
  });

  it("calls an errored thread failed", () => {
    expect(attachStatusFor("error")).toBe("failed");
  });
});

describe("attachVerdictFor", () => {
  const base = { shapeId: "shape:a", holderShapeId: null, canvasProjectId: "proj_canvas" };

  it("allows a live, in-project, unheld thread and derives its status", () => {
    expect(attachVerdictFor({ ...base, thread: probe({ status: "active" }) })).toEqual({
      ok: true,
      status: "running",
    });
    expect(attachVerdictFor({ ...base, thread: probe({ status: "idle" }) })).toEqual({
      ok: true,
      status: "idle",
    });
  });

  it("refuses a deleted thread", () => {
    const verdict = attachVerdictFor({ ...base, thread: probe({ deletedAt: 12 }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("gone");
  });

  it("refuses an archived thread", () => {
    // The sweep would drop this link on the next gc tick, so allowing it mints
    // a badge with a scheduled death.
    const verdict = attachVerdictFor({ ...base, thread: probe({ archivedAt: 12 }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("archived");
  });

  it("refuses a thread in another project", () => {
    const verdict = attachVerdictFor({ ...base, thread: probe({ projectId: "proj_other" }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("other-project");
  });

  it("refuses a thread already held by a DIFFERENT shape", () => {
    const verdict = attachVerdictFor({
      ...base,
      holderShapeId: "shape:b",
      thread: probe(),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("other-shape");
    // The message names the shape, because the picker marked that row and the
    // user can go look at it.
    expect(verdict.ok === false && verdict.message).toContain("shape:b");
  });

  it("ALLOWS re-attaching the same thread to the same shape", () => {
    // Idempotent: two tabs can both press it, and a shape re-picking the
    // thread it already has is not an error — it is the state asked for.
    expect(
      attachVerdictFor({ ...base, holderShapeId: "shape:a", thread: probe() }),
    ).toEqual({ ok: true, status: "idle" });
  });

  it("refuses a deleted thread ahead of every other complaint", () => {
    // Ordering matters for the message: "that thread is gone" is the useful
    // sentence even when it is also archived, cross-project and held.
    const verdict = attachVerdictFor({
      shapeId: "shape:a",
      holderShapeId: "shape:b",
      canvasProjectId: "proj_canvas",
      thread: probe({ deletedAt: 1, archivedAt: 1, projectId: "proj_other" }),
    });
    expect(verdict.ok === false && verdict.reason).toBe("gone");
  });

  it("gives every refusal a non-empty, human message", () => {
    const refusals = [
      probe({ deletedAt: 1 }),
      probe({ archivedAt: 1 }),
      probe({ projectId: "proj_other" }),
    ];
    for (const thread of refusals) {
      const verdict = attachVerdictFor({ ...base, thread });
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.message.length).toBeGreaterThan(10);
    }
  });
});
