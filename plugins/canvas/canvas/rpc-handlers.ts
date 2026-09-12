import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { attachVerdictFor } from "./agent-attach.js";
import { AgentLinks, threadTitleFor } from "./agents.js";
import { base64ToBytes } from "./base64.js";
import { threadListArgsFor, threadPickerOptions } from "./thread-picker.js";
import { DEFAULT_QUERY_LIMIT, TranscriptStore } from "./transcript.js";
import { AGENT_CHANNEL } from "./wire.js";
import type { rpcContract } from "../server.js";
import type { CanvasRoomHost } from "./room.js";
import { createThreadExcerptReader } from "./thread-excerpts.js";

export interface RpcHandlerDependencies {
  readonly room: CanvasRoomHost;
  readonly agents: AgentLinks;
  readonly transcript: TranscriptStore;
  readonly sdk: BbPluginApi["sdk"];
  readonly resolveProjectId: () => Promise<string>;
  readonly realtime: { publish(channel: string, payload: unknown): void };
  readonly log: {
    info(message: string): void;
  };
}

export function createRpcHandlers(
  deps: RpcHandlerDependencies,
): PluginRpcHandlers<typeof rpcContract> {
  const {
    room,
    agents,
    transcript,
    resolveProjectId,
    realtime,
    log,
  } = deps;

  const readExcerpts = createThreadExcerptReader(
    deps.sdk.threads,
    (threadId) => agents.shapeForThread(threadId) !== null,
  );

  return {
    canvas_thread_excerpts: ({ threadIds }) => readExcerpts(threadIds),
    canvas_join: ({ clientId, name }) => {
      room.join(clientId, Date.now(), name);
      return { room: room.room };
    },
    canvas_frame: ({ clientId, data }) => {
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
    canvas_run_note: async ({ shapeId, text }) => {
      const projectId = await resolveProjectId();
      const thread = await deps.sdk.threads.spawn({
        projectId,
        environment: { type: "project-default" },
        prompt: text,
        title: threadTitleFor(text),
      });
      const link = await agents.record(shapeId, thread.id, "running");
      realtime.publish(AGENT_CHANNEL, link);
      log.info(
        `note ${shapeId} -> thread ${thread.id} in project ${projectId}`,
      );
      return link;
    },
    canvas_attach_thread: async ({ shapeId, threadId }) => {
      const canvasProjectId = await resolveProjectId();
      const thread = await deps.sdk.threads.get({ threadId });
      const verdict = attachVerdictFor({
        thread,
        shapeId,
        holderShapeId: agents.shapeForThread(threadId),
        canvasProjectId,
      });
      if (!verdict.ok) throw new Error(verdict.message);
      const link = await agents.record(shapeId, threadId, verdict.status);
      realtime.publish(AGENT_CHANNEL, link);
      log.info(
        `shape ${shapeId} attached to thread ${threadId} (${verdict.status})`,
      );
      return link;
    },
    canvas_thread_options: async () => {
      const projectId = await resolveProjectId();
      const rows = await deps.sdk.threads.list(threadListArgsFor(projectId));
      const attachedBy = Object.fromEntries(
        agents.links.map((link) => [link.threadId, link.shapeId]),
      );
      return { options: threadPickerOptions(rows, attachedBy) };
    },
    canvas_unlink_agent: async ({ shapeId }) => {
      const link = await agents.remove(shapeId);
      if (link === null) return { unlinked: false };
      realtime.publish(AGENT_CHANNEL, { shapeId, unlinked: true });
      log.info(`note ${shapeId} unlinked from thread ${link.threadId}`);
      return { unlinked: true };
    },
    canvas_agents: () => ({ links: agents.links }),
    // Kept as an explicit compatibility result for existing Canvas bundles.
    // Presence and Huddle now own these capabilities and their configuration.
    canvas_roster: () => ({ members: [] }),
    canvas_av_token: async () => ({
      ok: false as const,
      error: "not_configured" as const,
      detail: "Canvas no longer owns AV. Install and configure the Huddle plugin.",
    }),
    canvas_transcript_feed: ({ after, limit }) => transcript.feed(after, limit),
    canvas_transcript_query: ({ sinceMs, search, speaker, limit }) => ({
      entries: transcript.query({
        sinceMs,
        search,
        speaker,
        limit: limit ?? DEFAULT_QUERY_LIMIT,
      }),
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
