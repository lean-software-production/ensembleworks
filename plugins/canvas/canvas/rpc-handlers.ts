import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { AccessToken } from "livekit-server-sdk";
import { attachVerdictFor } from "./agent-attach.js";
import { AgentLinks, threadTitleFor } from "./agents.js";
import {
  avIdentityFor,
  LIVEKIT_ROOM,
  livekitConfigFrom,
  NOT_CONFIGURED_DETAIL,
  TOKEN_TTL,
} from "./av.js";
import { base64ToBytes } from "./base64.js";
import { threadListArgsFor, threadPickerOptions } from "./thread-picker.js";
import { DEFAULT_QUERY_LIMIT, TranscriptStore } from "./transcript.js";
import { AGENT_CHANNEL } from "./wire.js";
import type { rpcContract } from "../server.js";
import type { CanvasRoomHost } from "./room.js";
import type { LocationBook } from "./locations.js";
import type { TreeWrite, TreeWriteOutcome, TreeWriter } from "./tree/writes.js";

export interface RpcHandlerDependencies {
  readonly room: CanvasRoomHost;
  readonly locations: LocationBook;
  readonly agents: AgentLinks;
  /**
   * W10's write engine, over the room's own document — the SAME instance the
   * agent tools hold. A human gesture and an agent tool are two callers of one
   * write path, which is the whole point of routing the gesture through rpc
   * (canvas/rpc-contract.ts argues it next to the two methods).
   */
  readonly treeWriter: TreeWriter;
  readonly transcript: TranscriptStore;
  readonly localName: string;
  readonly settings: { get(): Promise<Record<string, string | undefined>> };
  readonly sdk: BbPluginApi["sdk"];
  readonly resolveProjectId: () => Promise<string>;
  readonly realtime: { publish(channel: string, payload: unknown): void };
  readonly log: {
    info(message: string): void;
  };
}

/**
 * A write engine answer, as an rpc answer.
 *
 * A REFUSAL BECOMES A THROWN ERROR carrying the engine's own sentence, so the
 * panel's existing `toast.error(cause.message)` path shows a human exactly
 * what the engine said — reason code and subjects included. The alternative,
 * a `{ ok: false }` shape, would have every caller re-render a message the
 * engine already wrote.
 *
 * `newProblems` rides the SUCCESS answer, because the write did land. It means
 * a concurrent editor damaged the tree while this write was in flight, which
 * is W11's to reconcile and this handler's to pass on rather than swallow.
 *
 * EXPORTED FOR ITS OWN TEST, deliberately. The concurrent-damage case cannot
 * be staged through the rpc lane — the write is synchronous inside the
 * handler, so there is no moment for another peer to land an edge in — and a
 * mutation that dropped `problems` on the floor survived the whole suite until
 * this had a unit test of its own.
 */
export function treeWriteResult(
  write: TreeWrite<TreeWriteOutcome>,
  log: { info(message: string): void },
): { nodeId: string; changed: string[]; problems: string[] } {
  if (!write.ok) throw new Error(`${write.reason}: ${write.detail}`);
  const outcome = write.value;
  log.info(`tree gesture: ${outcome.changed.join(" ")}`);
  return {
    // The node the gesture made — never the focus, which for `addChild` is the
    // PARENT. A panel that selected the focus would select the node the human
    // already had selected and look like it did nothing.
    nodeId: outcome.createdId ?? outcome.focusId,
    changed: [...outcome.changed],
    problems: outcome.newProblems.map(
      (problem) => `${problem.kind}: ${problem.detail}`,
    ),
  };
}

export function createRpcHandlers(
  deps: RpcHandlerDependencies,
): PluginRpcHandlers<typeof rpcContract> {
  const {
    room,
    locations,
    agents,
    transcript,
    localName,
    settings,
    resolveProjectId,
    realtime,
    log,
  } = deps;

  return {
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
    canvas_tree_add_goal: ({ treeId, title }) =>
      treeWriteResult(deps.treeWriter.addGoal({ treeId, title }), log),
    canvas_tree_add_blocker: ({ parentId, title }) =>
      treeWriteResult(deps.treeWriter.addChild({ parentId, title }), log),
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
    canvas_roster: (report) => {
      const now = Date.now();
      if (report !== null && report.path !== undefined) {
        locations.seen(
          {
            clientId: report.clientId,
            name: report.name ?? null,
            path: report.path,
            title: report.title ?? null,
            focused: report.focused === true,
          },
          now,
        );
      }
      locations.sweep(now);
      return { members: locations.members(room.identities, now) };
    },
    canvas_av_token: async ({ clientId }) => {
      const config = livekitConfigFrom(await settings.get());
      if (config === null) {
        log.info("canvas_av_token: LiveKit is not configured");
        return {
          ok: false as const,
          error: "not_configured" as const,
          detail: NOT_CONFIGURED_DETAIL,
        };
      }
      const identity = avIdentityFor(clientId, room.identities, localName);
      const accessToken = new AccessToken(config.apiKey, config.apiSecret, {
        identity,
        name: identity,
        ttl: TOKEN_TTL,
      });
      accessToken.addGrant({
        room: LIVEKIT_ROOM,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
      });
      return {
        ok: true as const,
        url: config.url,
        token: await accessToken.toJwt(),
        room: LIVEKIT_ROOM,
        identity,
      };
    },
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
