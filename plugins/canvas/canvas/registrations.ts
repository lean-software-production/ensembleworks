import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { AgentLinks } from "./agents.js";
import {
  CF_ACCESS_EMAIL_HEADER,
  IDENTITY_ROUTE_PATH,
  resolveIdentity,
} from "./identity.js";
import type { CanvasRoomHost } from "./room.js";
import { AGENT_CHANNEL, CANVAS_CHANNEL, TRANSCRIPT_CHANNEL } from "./wire.js";
import {
  filterFor,
  mentionItems,
  mentionWindowFor,
  parseIngest,
  transcriptBlock,
  type TranscriptStore,
} from "./transcript.js";
import os from "node:os";

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export function registerBackground(
  bb: BbPluginApi,
  room: CanvasRoomHost,
  agents: AgentLinks,
): void {
  bb.background.service("canvas-gc", {
    async start(signal) {
      bb.realtime.publish(CANVAS_CHANNEL, { hello: Date.now() });
      const dropped = await agents.sweep(async (threadId) => {
        const thread = await bb.sdk.threads.get({ threadId });
        return { archivedAt: thread.archivedAt, deletedAt: thread.deletedAt };
      });
      for (const link of dropped) {
        bb.realtime.publish(AGENT_CHANNEL, {
          shapeId: link.shapeId,
          unlinked: true,
        });
        bb.log.info(
          `note ${link.shapeId} unlinked: thread ${link.threadId} is gone`,
        );
      }
      while (!signal.aborted) {
        await sleep(30_000, signal);
        if (signal.aborted) break;
        const nowMs = Date.now();
        room.sweep(nowMs);
      }
    },
  });
}

export function registerHttp(
  bb: BbPluginApi,
  transcript: TranscriptStore,
): void {
  bb.http.route(
    "GET",
    IDENTITY_ROUTE_PATH,
    (context) =>
      context.json(
        resolveIdentity(
          context.req.header(CF_ACCESS_EMAIL_HEADER),
          os.userInfo().username,
        ),
      ),
  );
  bb.http.route("POST", "/scribe", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ ok: false, error: "body must be JSON" }, 400);
    }
    const parsed = parseIngest(body, Date.now());
    if (!parsed.ok) {
      bb.log.warn(`scribe rejected a payload: ${parsed.error}`);
      return context.json({ ok: false, error: parsed.error }, 400);
    }
    transcript.insert(parsed.entries);
    for (const entry of parsed.entries) {
      bb.realtime.publish(TRANSCRIPT_CHANNEL, entry);
    }
    return context.json({ ok: true, inserted: parsed.entries.length });
  }, { auth: "token" });
}

export function registerMentions(
  bb: BbPluginApi,
  transcript: TranscriptStore,
): void {
  bb.ui.registerMentionProvider({
    id: "transcript",
    label: "Room transcript",
    search: ({ query }) =>
      mentionItems(query, Date.now(), (filter) => transcript.count(filter)),
    resolve: (itemId) => {
      const window = mentionWindowFor(itemId);
      if (window === null) {
        return { context: `Room transcript: unknown window "${itemId}".` };
      }
      return {
        context: transcriptBlock(
          window.label,
          transcript.query(filterFor(window, Date.now())),
        ),
      };
    },
  });
}

export function registerAgentEvents(bb: BbPluginApi, agents: AgentLinks): void {
  for (
    const [event, status] of [["thread.active", "running"], [
      "thread.idle",
      "idle",
    ], ["thread.failed", "failed"]] as const
  ) {
    bb.events.on(event, async ({ thread }) => {
      const link = await agents.apply(thread.id, status);
      if (link !== null) bb.realtime.publish(AGENT_CHANNEL, link);
    });
  }
  for (const event of ["thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, async ({ thread }) => {
      const link = await agents.removeByThread(thread.id);
      if (link === null) return;
      bb.realtime.publish(AGENT_CHANNEL, {
        shapeId: link.shapeId,
        unlinked: true,
      });
      bb.log.info(
        `note ${link.shapeId} unlinked: thread ${thread.id} ${event}`,
      );
    });
  }
}
