// Run: npx vitest run   (or `npm test`)
//
// The agent-sticky loop's backend half, driven through the real plugin factory:
// spawn a thread for a note, watch bb's thread lifecycle events move the badge,
// and prove the links survive a reload the way a browser refresh needs them to.
import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { threadTitleFor } from "../canvas/agents.js";
import {
  AGENT_CHANNEL,
  agentLinkFrom,
  agentUnlinkFrom,
  type CanvasAgentLink,
} from "../canvas/wire.js";
import plugin from "../server.js";

/** The project every fixture host is configured for. Named because the attach
 * rules compare against it — a thread in any other project is refused. */
const PROJECT = "proj_test";

/** A fake host whose `threads.spawn` mints sequential ids, with the project
 * setting SEEDED: as of Task 2d an unset setting refuses the launch outright
 * rather than guessing, so a host without one cannot run a note at all. */
function hostWithThreads(spawned: unknown[]) {
  let next = 0;
  return createFakePluginHost({
    pluginId: "canvas",
    settings: { project: PROJECT },
    sdk: {
      threads: {
        spawn: async (args) => {
          spawned.push(args);
          next += 1;
          return makeThreadResponse({ id: `th_${next}` });
        },
      },
    },
  });
}

/** Every agent-status message published so far, newest last. */
function statusSignals(host: FakePluginHost): CanvasAgentLink[] {
  return host.harness.inspection.realtimeSignals
    .filter((signal) => signal.channel === AGENT_CHANNEL)
    .map((signal) => agentLinkFrom(signal.payload))
    .filter((link): link is CanvasAgentLink => link !== null);
}

async function links(host: FakePluginHost): Promise<CanvasAgentLink[]> {
  const result = (await host.harness.behavior.callRpc("canvas_agents", null)) as {
    links: CanvasAgentLink[];
  };
  return result.links;
}

/**
 * Every raw payload published on AGENT_CHANNEL, newest last — status messages
 * AND removals. Asserted raw rather than through a decoder so these tests pin
 * the WIRE SHAPE a browser tab actually receives, not this repo's opinion of
 * how to read it.
 */
function agentSignals(host: FakePluginHost): unknown[] {
  return host.harness.inspection.realtimeSignals
    .filter((signal) => signal.channel === AGENT_CHANNEL)
    .map((signal) => signal.payload);
}

describe("the agent-sticky loop", () => {
  it("spawns a thread for a note, links it, and publishes its status", async () => {
    const spawned: unknown[] = [];
    const host = hostWithThreads(spawned);
    await plugin(host.bb);

    const link = (await host.harness.behavior.callRpc("canvas_run_note", {
      shapeId: "shape:note",
      text: "Summarise the release notes",
    })) as CanvasAgentLink;

    expect(link).toEqual({
      shapeId: "shape:note",
      threadId: "th_1",
      status: "running",
    });
    // The note's text is the prompt, verbatim, and the title is its head.
    expect(spawned[0]).toMatchObject({
      projectId: PROJECT,
      environment: { type: "project-default" },
      prompt: "Summarise the release notes",
      title: "Canvas: Summarise the release notes",
    });
    // Born running, published immediately: the badge does not wait for the
    // thread to actually reach `active`.
    expect(statusSignals(host)).toEqual([link]);
    expect(await links(host)).toEqual([link]);
  });

  it("moves a linked note's badge on thread.active / idle / failed", async () => {
    const host = hostWithThreads([]);
    await plugin(host.bb);
    await host.harness.behavior.callRpc("canvas_run_note", {
      shapeId: "shape:note",
      text: "go",
    });
    const thread = makeThreadResponse({ id: "th_1" });

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: "done",
    });
    expect(await links(host)).toEqual([
      { shapeId: "shape:note", threadId: "th_1", status: "idle" },
    ]);

    // A follow-up message re-opens the thread; the badge goes back to running.
    await host.harness.behavior.emitThreadEvent("thread.active", { thread });
    expect((await links(host))[0]?.status).toBe("running");

    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread,
      error: "boom",
    });
    expect((await links(host))[0]?.status).toBe("failed");

    expect(statusSignals(host).map((link) => link.status)).toEqual([
      "running",
      "idle",
      "running",
      "failed",
    ]);
  });

  it("ignores threads it did not spawn", async () => {
    const host = hostWithThreads([]);
    await plugin(host.bb);

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "th_someone_elses" }),
      lastAssistantText: null,
    });

    expect(statusSignals(host)).toEqual([]);
    expect(await links(host)).toEqual([]);
  });

  it("keeps links across a reload, so badges survive a plugin restart", async () => {
    const host = hostWithThreads([]);
    await plugin(host.bb);
    await host.harness.behavior.callRpc("canvas_run_note", {
      shapeId: "shape:note",
      text: "go",
    });

    // The whole registration set is replaced; only kv survives — which is the
    // point of persisting the link there rather than in the room host.
    await host.harness.lifecycle.reload(plugin);

    expect(await links(host)).toEqual([
      { shapeId: "shape:note", threadId: "th_1", status: "running" },
    ]);
    // ... and the reloaded plugin still recognises that thread's events.
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "th_1" }),
      lastAssistantText: "done",
    });
    expect((await links(host))[0]?.status).toBe("idle");
  });

  it("re-running a note replaces its link rather than fanning out badges", async () => {
    const host = hostWithThreads([]);
    await plugin(host.bb);
    const run = () =>
      host.harness.behavior.callRpc("canvas_run_note", {
        shapeId: "shape:note",
        text: "go",
      });
    await run();
    await run();

    expect(await links(host)).toEqual([
      { shapeId: "shape:note", threadId: "th_2", status: "running" },
    ]);
    // The superseded thread is unlinked, so its later events no longer drive
    // this note's badge.
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "th_1" }),
      error: "old",
    });
    expect((await links(host))[0]).toEqual({
      shapeId: "shape:note",
      threadId: "th_2",
      status: "running",
    });
  });

  it("refuses to spawn at all when the project setting is unset", async () => {
    // TASK 2d, AND A DEFECT THAT ALREADY BIT THE OWNER. `resolveProjectId`
    // used to fall back to the FIRST project bb listed, so with the setting
    // unset every canvas thread landed in an unrelated project while the owner
    // watched a different project's sidebar and reasonably concluded the
    // threads had never been created. There is a project here — several — and
    // that is the point: the refusal is about not having been TOLD which one,
    // not about there being none.
    const host = createFakePluginHost({
      pluginId: "canvas",
      sdk: {
        projects: { list: async () => [{ id: "proj_a" }, { id: "proj_b" }] },
        threads: { spawn: async () => makeThreadResponse({ id: "th_1" }) },
      },
    });
    await plugin(host.bb);

    await expect(
      host.harness.behavior.callRpc("canvas_run_note", {
        shapeId: "shape:note",
        text: "go",
      }),
    ).rejects.toThrow(/Canvas plugin's project setting/);
    // Nothing was spawned, and — the load-bearing half — bb was never even
    // asked for a project list, because there is no list-shaped answer to
    // "which project did the user choose".
    expect(host.harness.inspection.sdk.calls).toEqual([]);
  });

  it("still refuses when bb happens to have exactly one project", async () => {
    // The tempting middle ground — "one project is unambiguous, so guess it" —
    // is refused: it makes the failure appear only when a SECOND project is
    // created, which is the worst possible moment to discover it.
    const host = createFakePluginHost({
      pluginId: "canvas",
      sdk: {
        projects: { list: async () => [{ id: "proj_only" }] },
        threads: { spawn: async () => makeThreadResponse({ id: "th_1" }) },
      },
    });
    await plugin(host.bb);

    await expect(
      host.harness.behavior.callRpc("canvas_run_note", {
        shapeId: "shape:note",
        text: "go",
      }),
    ).rejects.toThrow(/Canvas plugin's project setting/);
  });

  it("picks the project up from the setting without a reload", async () => {
    // Settings saves do not reload a healthy plugin, so a re-read per call is
    // what makes "paste the project, then click Run" work.
    const spawned: unknown[] = [];
    const host = createFakePluginHost({
      pluginId: "canvas",
      sdk: {
        threads: {
          spawn: async (args) => {
            spawned.push(args);
            return makeThreadResponse({ id: "th_1" });
          },
        },
      },
    });
    await plugin(host.bb);
    await host.harness.behavior.setSettings({ project: "proj_late" });

    await host.harness.behavior.callRpc("canvas_run_note", {
      shapeId: "shape:note",
      text: "go",
    });

    expect(spawned[0]).toMatchObject({ projectId: "proj_late" });
  });
});

describe("a link ending", () => {
  /** Spawn one linked note and return its host, with the spawn's own
   * "running" publish already on the wire. */
  async function linkedNote(): Promise<FakePluginHost> {
    const host = hostWithThreads([]);
    await plugin(host.bb);
    await host.harness.behavior.callRpc("canvas_run_note", {
      shapeId: "shape:note",
      text: "go",
    });
    return host;
  }

  it("drops the link and broadcasts the removal when its thread is archived", async () => {
    const host = await linkedNote();

    await host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "th_1", archivedAt: 1 }),
    });

    // The badge is gone from the room's own answer...
    expect(await links(host)).toEqual([]);
    // ...and every open tab was told, so it disappears live rather than on the
    // next reload.
    expect(agentSignals(host)).toEqual([
      { shapeId: "shape:note", threadId: "th_1", status: "running" },
      { shapeId: "shape:note", unlinked: true },
    ]);

    // Durably gone: the kv row went with it, so a reload does not resurrect it.
    await host.harness.lifecycle.reload(plugin);
    expect(await links(host)).toEqual([]);
  });

  it("drops the link and broadcasts the removal when its thread is deleted", async () => {
    const host = await linkedNote();

    await host.harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "th_1", deletedAt: 1 }),
    });

    expect(await links(host)).toEqual([]);
    expect(agentSignals(host)).toEqual([
      { shapeId: "shape:note", threadId: "th_1", status: "running" },
      { shapeId: "shape:note", unlinked: true },
    ]);

    await host.harness.lifecycle.reload(plugin);
    expect(await links(host)).toEqual([]);
  });

  it("ignores an archive/delete of a thread it did not spawn", async () => {
    const host = await linkedNote();

    await host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "th_someone_elses", archivedAt: 1 }),
    });
    await host.harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "th_someone_elses", deletedAt: 1 }),
    });

    expect((await links(host))[0]?.threadId).toBe("th_1");
    expect(agentSignals(host)).toHaveLength(1);
  });

  it("unlinks a note on request, leaving the thread itself alone", async () => {
    const host = await linkedNote();

    const result = await host.harness.behavior.callRpc("canvas_unlink_agent", {
      shapeId: "shape:note",
    });

    expect(result).toEqual({ unlinked: true });
    expect(await links(host)).toEqual([]);
    expect(agentSignals(host)).toEqual([
      { shapeId: "shape:note", threadId: "th_1", status: "running" },
      { shapeId: "shape:note", unlinked: true },
    ]);
    // Only the LINK dies: nothing was archived, deleted or stopped in bb.
    // `projects.list` is absent because Task 2d removed the guess that used to
    // call it — the project now comes from the setting alone.
    expect(host.harness.inspection.sdk.calls.map((call) => call.path)).toEqual([
      "threads.spawn",
    ]);

    await host.harness.lifecycle.reload(plugin);
    expect(await links(host)).toEqual([]);
  });

  it("treats unlinking a note it has no link for as a no-op, not an error", async () => {
    const host = await linkedNote();

    const result = await host.harness.behavior.callRpc("canvas_unlink_agent", {
      shapeId: "shape:never-linked",
    });

    expect(result).toEqual({ unlinked: false });
    // Nothing removed and — crucially — nothing broadcast: a removal message
    // for a shape no tab has a badge for is noise every tab has to decode.
    expect((await links(host))[0]?.threadId).toBe("th_1");
    expect(agentSignals(host)).toHaveLength(1);
  });

  it("stops tracking an unlinked note's thread events", async () => {
    const host = await linkedNote();
    await host.harness.behavior.callRpc("canvas_unlink_agent", {
      shapeId: "shape:note",
    });

    // The reverse map went too, so the orphaned thread's later transitions no
    // longer re-create a badge on the note the user just cleared.
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "th_1" }),
      lastAssistantText: "done",
    });

    expect(await links(host)).toEqual([]);
    expect(agentSignals(host)).toHaveLength(2);
  });
});

describe("the startup sweep", () => {
  /** Load the plugin with one link already on a thread bb answers `get` with,
   * then run `canvas-gc`'s first tick to completion. */
  async function sweptHost(
    get: (args: { threadId: string }) => unknown,
  ): Promise<FakePluginHost> {
    const host = hostWithThreads([]);
    host.harness.inspection.sdk.stub("threads.get", get as never);
    await plugin(host.bb);
    await host.harness.behavior.callRpc("canvas_run_note", {
      shapeId: "shape:note",
      text: "go",
    });

    const service = host.harness.behavior.runService("canvas-gc");
    // The sweep is the awaited head of `start`; the loop after it is parked on
    // a 30s timer, so aborting once the microtasks have drained ends the
    // service without ending the sweep.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    service.controller.abort();
    await service.done;
    return host;
  }

  it("drops a link whose thread bb has already archived", async () => {
    // The case the events cannot cover: archived while this plugin was not
    // loaded, so no thread.archived was ever delivered to it.
    const host = await sweptHost(async ({ threadId }) =>
      makeThreadResponse({ id: threadId, archivedAt: 123 }),
    );

    expect(await links(host)).toEqual([]);
    expect(agentSignals(host)).toContainEqual({
      shapeId: "shape:note",
      unlinked: true,
    });
  });

  it("keeps a link whose thread is alive", async () => {
    const host = await sweptHost(async ({ threadId }) =>
      makeThreadResponse({ id: threadId }),
    );

    // The probe really ran — without this the two "keeps" cases would pass
    // just as well against a sweep that never happened.
    expect(host.harness.inspection.sdk.callsTo("threads.get")).toEqual([
      [{ threadId: "th_1" }],
    ]);
    expect((await links(host))[0]?.threadId).toBe("th_1");
    expect(agentSignals(host)).toHaveLength(1);
  });

  it("keeps a link bb refuses to answer for", async () => {
    // A throw is not evidence: `threads.get` fails the same way for "no such
    // thread" and for "the call did not work", and a badge wrongly dropped
    // destroys the only pointer from a note to its conversation.
    const host = await sweptHost(() => {
      throw new Error("boom");
    });

    expect((await links(host))[0]?.threadId).toBe("th_1");
    expect(agentSignals(host)).toHaveLength(1);
  });
});

describe("agentUnlinkFrom", () => {
  it("accepts a removal and nothing else", () => {
    expect(agentUnlinkFrom({ shapeId: "shape:note", unlinked: true })).toEqual({
      shapeId: "shape:note",
      unlinked: true,
    });
    // A status message must never read as a removal, or one badge update would
    // clear the badge it was meant to recolour.
    expect(
      agentUnlinkFrom({ shapeId: "shape:note", threadId: "th_1", status: "idle" }),
    ).toBeNull();
    expect(agentUnlinkFrom({ shapeId: "shape:note", unlinked: "yes" })).toBeNull();
    expect(agentUnlinkFrom({ shapeId: "", unlinked: true })).toBeNull();
    expect(agentUnlinkFrom({ unlinked: true })).toBeNull();
    expect(agentUnlinkFrom(null)).toBeNull();
  });

  it("and a removal never reads as a status message", () => {
    expect(agentLinkFrom({ shapeId: "shape:note", unlinked: true })).toBeNull();
  });
});

describe("threadTitleFor", () => {
  it("collapses whitespace and caps the head of the prompt", () => {
    expect(threadTitleFor("  hello\n  world  ")).toBe("Canvas: hello world");
    expect(threadTitleFor("x".repeat(200))).toBe(`Canvas: ${"x".repeat(40)}`);
  });
});

// ---------------------------------------------------------------------------
// TASK 2 — ATTACH: binding a shape to a thread that already exists in bb.
//
// The point of these is that attach REUSES the launch path's plumbing rather
// than building a second one: the same `agents.record`, the same AGENT_CHANNEL
// publish, so the same badge, the same `thread.idle` subscription, the same
// `canvas_unlink_agent` and the same startup sweep all work on an attached link
// with no code of their own.

/** A host with the project setting seeded and a `threads.list` answering
 * `rows`. `threads.get` answers a live, in-project thread by id unless the
 * caller overrides it. */
function hostWithThreadList(
  rows: readonly Record<string, unknown>[],
  get?: (args: { threadId: string }) => unknown,
) {
  return createFakePluginHost({
    pluginId: "canvas",
    settings: { project: PROJECT },
    sdk: {
      threads: {
        list: async () => rows,
        get:
          (get as never) ??
          (async ({ threadId }: { threadId: string }) =>
            makeThreadResponse({ id: threadId, projectId: PROJECT, status: "idle" })),
        spawn: async () => makeThreadResponse({ id: "th_spawned", projectId: PROJECT }),
      },
    },
  });
}

/** One `threads.list` row, with the eight fields the picker reads. */
function listRow(overrides: Record<string, unknown> & { id: string }) {
  return {
    title: null,
    titleFallback: null,
    projectId: PROJECT,
    archivedAt: null,
    deletedAt: null,
    updatedAt: 1_000,
    visibility: "visible",
    ...overrides,
  };
}

describe("the attach picker's offer", () => {
  it("lists the canvas project's threads, most recent first", async () => {
    const host = hostWithThreadList([
      listRow({ id: "th_old", title: "Older", updatedAt: 100 }),
      listRow({ id: "th_new", title: "Newer", updatedAt: 900 }),
    ]);
    await plugin(host.bb);

    const result = (await host.harness.behavior.callRpc("canvas_thread_options", null)) as {
      options: { threadId: string; label: string; attachedShapeId: string | null }[];
    };

    expect(result.options.map((option) => option.threadId)).toEqual(["th_new", "th_old"]);
    expect(result.options[0]?.label).toBe("Newer");
    // Scoped to the configured project and asking bb to leave archived out.
    expect(host.harness.inspection.sdk.callsTo("threads.list")).toEqual([
      [{ projectId: PROJECT, archived: false }],
    ]);
  });

  it("marks a thread that is already on a shape, rather than hiding it", async () => {
    const host = hostWithThreadList([
      listRow({ id: "th_spawned", title: "Mine" }),
      listRow({ id: "th_free", title: "Free" }),
    ]);
    await plugin(host.bb);
    await host.harness.behavior.callRpc("canvas_run_note", { shapeId: "shape:note", text: "go" });

    const result = (await host.harness.behavior.callRpc("canvas_thread_options", null)) as {
      options: { threadId: string; attachedShapeId: string | null }[];
    };

    const byId = Object.fromEntries(
      result.options.map((option) => [option.threadId, option.attachedShapeId]),
    );
    expect(byId).toEqual({ th_spawned: "shape:note", th_free: null });
  });

  it("refuses to list when no project is configured", async () => {
    const host = createFakePluginHost({
      pluginId: "canvas",
      sdk: { threads: { list: async () => [] } },
    });
    await plugin(host.bb);

    await expect(
      host.harness.behavior.callRpc("canvas_thread_options", null),
    ).rejects.toThrow(/Canvas plugin's project setting/);
    // And bb was never asked: there is no project to ask about.
    expect(host.harness.inspection.sdk.calls).toEqual([]);
  });
});

describe("attaching a shape to an existing thread", () => {
  it("binds the shape, derives the badge status, and publishes it", async () => {
    const host = hostWithThreadList(
      [],
      async ({ threadId }) =>
        makeThreadResponse({ id: threadId, projectId: PROJECT, status: "active" }),
    );
    await plugin(host.bb);

    const link = (await host.harness.behavior.callRpc("canvas_attach_thread", {
      shapeId: "shape:box",
      threadId: "th_existing",
    })) as CanvasAgentLink;

    // "running", not because attach assumes it the way spawn does, but because
    // bb said the thread is `active`.
    expect(link).toEqual({
      shapeId: "shape:box",
      threadId: "th_existing",
      status: "running",
    });
    expect(await links(host)).toEqual([link]);
    expect(agentSignals(host)).toEqual([link]);
  });

  it("starts an idle thread's badge idle, not running", async () => {
    const host = hostWithThreadList([]);
    await plugin(host.bb);

    const link = (await host.harness.behavior.callRpc("canvas_attach_thread", {
      shapeId: "shape:box",
      threadId: "th_existing",
    })) as CanvasAgentLink;

    expect(link.status).toBe("idle");
  });

  it("attaches to a NON-note shape, which the launch arm cannot", async () => {
    const host = hostWithThreadList([]);
    await plugin(host.bb);

    const link = (await host.harness.behavior.callRpc("canvas_attach_thread", {
      shapeId: "shape:frame",
      threadId: "th_existing",
    })) as CanvasAgentLink;

    expect(link.shapeId).toBe("shape:frame");
  });

  it("VERIFIES the thread before recording anything", async () => {
    // A link to a thread that does not resolve mounts a ThreadChat on nothing.
    const host = hostWithThreadList([], () => {
      throw new Error("no such thread");
    });
    await plugin(host.bb);

    await expect(
      host.harness.behavior.callRpc("canvas_attach_thread", {
        shapeId: "shape:box",
        threadId: "th_ghost",
      }),
    ).rejects.toThrow(/no such thread/);
    // Nothing recorded and nothing broadcast: the probe runs FIRST.
    expect(await links(host)).toEqual([]);
    expect(agentSignals(host)).toEqual([]);
  });

  it("refuses to attach when no project is configured, before asking bb", async () => {
    // Task 2d applies to every arm, not just the launch: without a project
    // there is nothing to rule a thread in or out AGAINST.
    const host = createFakePluginHost({
      pluginId: "canvas",
      sdk: { threads: { get: async () => makeThreadResponse({ id: "th_1" }) } },
    });
    await plugin(host.bb);

    await expect(
      host.harness.behavior.callRpc("canvas_attach_thread", {
        shapeId: "shape:box",
        threadId: "th_1",
      }),
    ).rejects.toThrow(/Canvas plugin's project setting/);
    expect(host.harness.inspection.sdk.calls).toEqual([]);
  });

  it("refuses an archived thread even though bb answers for it", async () => {
    // `threads.get` resolves for an archived thread — the sweep reads
    // `archivedAt` off exactly such a fetch — so "it did not throw" is only
    // half the check.
    const host = hostWithThreadList([], async ({ threadId }) =>
      makeThreadResponse({ id: threadId, projectId: PROJECT, archivedAt: 7 }),
    );
    await plugin(host.bb);

    await expect(
      host.harness.behavior.callRpc("canvas_attach_thread", {
        shapeId: "shape:box",
        threadId: "th_archived",
      }),
    ).rejects.toThrow(/archived/);
    expect(await links(host)).toEqual([]);
  });

  it("refuses a thread in another project", async () => {
    const host = hostWithThreadList([], async ({ threadId }) =>
      makeThreadResponse({ id: threadId, projectId: "proj_elsewhere" }),
    );
    await plugin(host.bb);

    await expect(
      host.harness.behavior.callRpc("canvas_attach_thread", {
        shapeId: "shape:box",
        threadId: "th_elsewhere",
      }),
    ).rejects.toThrow(/proj_elsewhere/);
    expect(await links(host)).toEqual([]);
  });

  it("refuses a thread already attached to a different shape", async () => {
    const host = hostWithThreadList([]);
    await plugin(host.bb);
    await host.harness.behavior.callRpc("canvas_attach_thread", {
      shapeId: "shape:first",
      threadId: "th_one",
    });

    await expect(
      host.harness.behavior.callRpc("canvas_attach_thread", {
        shapeId: "shape:second",
        threadId: "th_one",
      }),
    ).rejects.toThrow(/shape:first/);
    // The mirror is keyed BOTH directions, so a second holder would freeze the
    // first shape's badge. The first link is untouched and no second appeared.
    expect(await links(host)).toEqual([
      { shapeId: "shape:first", threadId: "th_one", status: "idle" },
    ]);
  });

  it("allows re-attaching the same thread to the same shape", async () => {
    const host = hostWithThreadList([]);
    await plugin(host.bb);
    await host.harness.behavior.callRpc("canvas_attach_thread", {
      shapeId: "shape:box",
      threadId: "th_one",
    });

    const again = (await host.harness.behavior.callRpc("canvas_attach_thread", {
      shapeId: "shape:box",
      threadId: "th_one",
    })) as CanvasAgentLink;

    expect(again).toEqual({ shapeId: "shape:box", threadId: "th_one", status: "idle" });
    expect(await links(host)).toHaveLength(1);
  });

  it("re-points a shape that was already linked to a different thread", async () => {
    const host = hostWithThreadList([]);
    await plugin(host.bb);
    await host.harness.behavior.callRpc("canvas_run_note", { shapeId: "shape:note", text: "go" });

    await host.harness.behavior.callRpc("canvas_attach_thread", {
      shapeId: "shape:note",
      threadId: "th_other",
    });

    expect(await links(host)).toEqual([
      { shapeId: "shape:note", threadId: "th_other", status: "idle" },
    ]);
    // The superseded thread no longer drives this shape's badge — the same
    // reverse-entry cleanup a re-run gets, for free, because attach records
    // through `AgentLinks.record` rather than around it.
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "th_spawned" }),
      error: "old",
    });
    expect((await links(host))[0]?.status).toBe("idle");
  });

  it("hands an attached link the whole existing badge lifecycle", async () => {
    const host = hostWithThreadList([]);
    await plugin(host.bb);
    await host.harness.behavior.callRpc("canvas_attach_thread", {
      shapeId: "shape:box",
      threadId: "th_one",
    });

    // Thread events move it — the subscription has no idea this link was
    // attached rather than spawned, which is the point.
    await host.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "th_one" }),
    });
    expect((await links(host))[0]?.status).toBe("running");

    // The existing unlink retires it, and nothing in bb was touched: no
    // archive, no delete, no stop.
    expect(
      await host.harness.behavior.callRpc("canvas_unlink_agent", { shapeId: "shape:box" }),
    ).toEqual({ unlinked: true });
    expect(await links(host)).toEqual([]);
    expect(host.harness.inspection.sdk.calls.map((call) => call.path)).toEqual([
      "threads.get",
    ]);
  });

  it("keeps an attached link across a reload, badge and all", async () => {
    const host = hostWithThreadList([]);
    await plugin(host.bb);
    await host.harness.behavior.callRpc("canvas_attach_thread", {
      shapeId: "shape:box",
      threadId: "th_one",
    });

    await host.harness.lifecycle.reload(plugin);

    expect(await links(host)).toEqual([
      { shapeId: "shape:box", threadId: "th_one", status: "idle" },
    ]);
    // And the reloaded plugin still recognises that thread's events, which is
    // the reverse index being rebuilt from kv rather than from the spawn.
    await host.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "th_one" }),
    });
    expect((await links(host))[0]?.status).toBe("running");
  });
});
