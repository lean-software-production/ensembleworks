// bb-plugin-canvas — a BB plugin backend entry.
//
// The default export is a factory that receives the plugin API. BB supplies
// the tiny defineRpcContract runtime helper; the API type remains type-only.
//
// This backend is the canvas room host: one authoritative SyncServerPeer for
// room "main" plus the rpc half of its transport. See canvas/room.ts for the
// bb-specific wire mapping and transport.ts for the client half that
// canvas/CanvasPanel.tsx mounts.
import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { AgentLinks } from "./canvas/agents.js";
import { resolveCanvasProjectId } from "./canvas/agent-project.js";
import { CanvasRoomHost } from "./canvas/room.js";
import { CANVAS_MIGRATIONS, CanvasStore } from "./canvas/store.js";
import {
  registerAgentEvents,
  registerBackground,
  registerHttp,
  registerMentions,
} from "./canvas/registrations.js";
import {
  TranscriptStore,
} from "./canvas/transcript.js";
import { createRpcHandlers } from "./canvas/rpc-handlers.js";
import { registerCanvasCli } from "./canvas/cli.js";
import { rpcContract } from "./canvas/rpc-contract.js";
export { rpcContract } from "./canvas/rpc-contract.js";
import { CANVAS_CHANNEL } from "./canvas/wire.js";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  // Where the canvas's agent threads live. Declared with no `default`, so the
  // value is `string | undefined` — and unset is now a REFUSAL, not a shrug:
  // see canvas/agent-project.ts for why guessing a project was worse than an
  // error that names this setting.
  //
  const settings = bb.settings.define({
    project: {
      type: "project",
      label: "Project for canvas agents",
      description:
        "Which project the canvas's agent threads live in — spawned into, listed from, and attached within. Required: unset refuses the launch rather than guessing.",
    },
  });

  // Persisted shape -> thread links, mirrored in memory. Loaded HERE, in the
  // factory, so the very first `canvas_agents` call after a reload already has
  // every badge — a panel that mounted before this plugin reloaded would
  // otherwise show a blank canvas of unlinked notes until each thread happened
  // to change status.
  const agents = new AgentLinks(bb.storage.kv);
  await agents.load();
  bb.log.info(`restored ${agents.links.length} agent link(s)`);

  /**
   * The project every canvas thread lives in — spawned, listed for the attach
   * picker, or checked at attach time. The `project` setting, and NOTHING ELSE:
   * the "else the first project bb lists" fallback that used to be here was a
   * silent guess that landed the owner's threads in an unrelated project, and
   * canvas/agent-project.ts is the whole argument for removing it.
   *
   * Re-read per call rather than captured at load, so changing the setting
   * takes effect without a reload (settings saves do not reload a healthy
   * plugin). The refusal itself is `resolveCanvasProjectId`'s, so it is
   * unit-tested rather than only reachable by driving the plugin.
   */
  async function resolveProjectId(): Promise<string> {
    const { project } = await settings.get();
    return resolveCanvasProjectId(project);
  }

  // One authoritative SyncServerPeer for room "main", restored from this
  // plugin's own SQLite and re-persisted durable-first on every inbound
  // update. Constructed at load so the room is live before the first client.
  const db = bb.storage.database();
  bb.storage.migrate(db, CANVAS_MIGRATIONS);
  const room = new CanvasRoomHost({
    store: new CanvasStore(db),
    publish: (envelope) => bb.realtime.publish(CANVAS_CHANNEL, envelope),
    log: (message) => bb.log.info(message),
  });
  // The room's OTHER half: what was said in it. Same database, entirely
  // separate table — the canvas document is a CRDT nobody queries and the
  // transcript is a query surface nobody edits.
  const transcript = new TranscriptStore(db);
  // LIFO: this runs before the host closes the database handle, so the final
  // compaction still has somewhere to write.
  bb.onDispose(() => room.close());

  registerBackground(
    bb,
    room,
    agents,
  );

  registerHttp(bb, transcript);

  registerMentions(bb, transcript);

  bb.rpc.register(
    rpcContract,
    createRpcHandlers({
      room,
      agents,
      transcript,
      resolveProjectId,
      realtime: bb.realtime,
      log: bb.log,
      sdk: bb.sdk,
    }),
  );

  registerAgentEvents(
    bb,
    agents,
  );

  registerCanvasCli(bb, room, agents, transcript);

  // Cleanup on reload/disable/shutdown; hooks run LIFO. The sanctioned place
  // to clear timers and close connections.
  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
