import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { base64ToBytes } from "./base64.js";
import { threadListArgsFor, threadPickerOptions } from "./thread-picker.js";
import { hasThreadFrameFor } from "./thread-frames.js";
import { readGithubRepo, readGithubStatus, searchGithubIssues } from "./github-cache-server.js";
import type { rpcContract } from "../server.js";
import type { CanvasRoomHost } from "./room.js";
import { CANVAS_SCHEMA_VERSION } from "./wire.js";

function requireCompatibleCanvas(schemaVersion: number | undefined): void {
  if (schemaVersion !== CANVAS_SCHEMA_VERSION) {
    throw new Error("Canvas has been updated. Reopen this panel to continue editing.");
  }
}

export interface RpcHandlerDependencies {
  readonly room: CanvasRoomHost;
  readonly sdk: BbPluginApi["sdk"];
  readonly resolveProjectId: () => Promise<string>;
  readonly realtime: { publish(channel: string, payload: unknown): void };
  readonly log: {
    info(message: string): void;
  };
}

/** Longest title a spawned thread's title is trimmed to. Moved here from the
 * retired canvas/agents.ts with `canvas_run_note`'s replacement,
 * `canvas_spawn_thread` — the only remaining caller. */
const SPAWN_TITLE_LENGTH = 40;

/**
 * The thread title for a spawned prompt: `Canvas: ` plus the first
 * SPAWN_TITLE_LENGTH characters. Whitespace is collapsed first — a prompt
 * seeded from a frame's children is multi-shape by nature and a raw newline
 * in a sidebar row is not a title.
 */
function spawnTitleFor(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return `Canvas: ${flat.length <= SPAWN_TITLE_LENGTH ? flat : flat.slice(0, SPAWN_TITLE_LENGTH)}`;
}

export function createRpcHandlers(
  deps: RpcHandlerDependencies,
): PluginRpcHandlers<typeof rpcContract> {
  const {
    room,
    resolveProjectId,
    log,
  } = deps;

  return {
    canvas_github_status: () => readGithubStatus(deps.sdk.plugins),
    canvas_github_repo: async ({ repo }) => readGithubRepo(deps.sdk.plugins, await resolveProjectId(), repo),
    canvas_github_picker: async ({ query }) => searchGithubIssues(deps.sdk.plugins, await resolveProjectId(), query),
    canvas_join: ({ clientId, name, schemaVersion }) => {
      requireCompatibleCanvas(schemaVersion);
      room.join(clientId, Date.now(), name);
      return { room: room.room };
    },
    canvas_frame: ({ clientId, data, schemaVersion }) => {
      requireCompatibleCanvas(schemaVersion);
      room.frame(clientId, base64ToBytes(data), Date.now());
      return { ok: true } as const;
    },
    canvas_ping: ({ clientId }) => ({
      connected: room.touch(clientId, Date.now()),
    }),
    canvas_leave: ({ clientId }) => {
      room.leave(clientId);
      return { ok: true } as const;
    },
    canvas_spawn_thread: async ({ prompt }) => {
      const projectId = await resolveProjectId();
      const thread = await deps.sdk.threads.spawn({
        projectId,
        environment: { type: "project-default" },
        prompt,
        title: spawnTitleFor(prompt),
      });
      log.info(`spawned thread ${thread.id} in project ${projectId}`);
      return { threadId: thread.id };
    },
    canvas_thread_options: async () => {
      const projectId = await resolveProjectId();
      const rows = await deps.sdk.threads.list(threadListArgsFor(projectId));
      // No shape ever "holds" a thread through this plugin's own bookkeeping
      // any more (the kv-backed launch-or-attach links are retired — see
      // docs/plans/2026-09-15-bb-thread-frame.md); a `bbthread` shape's own
      // `threadId` prop is the only binding, and this handler has no reason
      // to walk the document just to populate a mark the picker does not
      // currently render differently. See the rpc contract's own note on
      // `attachedShapeId` for why the field stays on the wire regardless.
      return { options: threadPickerOptions(rows, {}) };
    },
    canvas_thread_connection: ({ threadId }) => ({
      connected: hasThreadFrameFor(room.peer.doc.listShapes(), threadId),
    }),
    // Kept as an explicit compatibility result for existing Canvas bundles.
    // Presence and Huddle now own these capabilities and their configuration.
    canvas_roster: () => ({ members: [] }),
    canvas_av_token: async () => ({
      ok: false as const,
      error: "not_configured" as const,
      detail: "Canvas no longer owns AV. Install and configure the Huddle plugin.",
    }),
    canvas_debug: () => ({
      room: room.room,
      shapeIds: room.peer.doc.listShapes().map((shape) => shape.id),
      clientIds: room.clientIds,
      identities: room.identities,
      pendingUpdates: room.pendingUpdates,
      snapshotBytes: room.peer.snapshot().length,
    }),
  };
}
