// bb-plugin-canvas — a BB plugin backend entry.
//
// The default export is a factory that receives the plugin API. BB supplies
// the tiny defineRpcContract runtime helper; the API type remains type-only.
//
// This backend is the canvas room host: one authoritative SyncServerPeer for
// room "main" plus the rpc half of its transport. See canvas/room.ts for the
// bb-specific wire mapping and transport.ts for the client half that
// canvas/CanvasPanel.tsx mounts.
import os from "node:os";
import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { AgentLinks } from "./canvas/agents.js";
import { resolveCanvasProjectId } from "./canvas/agent-project.js";
import {
  resolveIdentity,
} from "./canvas/identity.js";
import { LocationBook } from "./canvas/locations.js";
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
import { registerTreeAgentTools } from "./canvas/tree/agent-tools.js";
import { treeServiceForDoc } from "./canvas/tree/doc-source.js";
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
  // The three LiveKit settings are what turns "Join audio" from a toast into a
  // call. The two credentials are `secret: true`, so they live in this plugin's
  // 0600 secrets file, never reach the plugin database, and are never served to
  // the frontend — only the minted, short-lived token crosses to the browser.
  // `livekitUrl` is not secret: it is a hostname the client has to be told
  // anyway.
  const settings = bb.settings.define({
    project: {
      type: "project",
      label: "Project for canvas agents",
      description:
        "Which project the canvas's agent threads live in — spawned into, listed from, and attached within. Required: unset refuses the launch rather than guessing.",
    },
    livekitUrl: {
      type: "string",
      label: "LiveKit URL",
      description: "wss://… of the LiveKit server that carries canvas audio.",
      default: "",
    },
    livekitApiKey: {
      type: "string",
      label: "LiveKit API key",
      description: "Used only to sign access tokens; never sent to a browser.",
      secret: true,
    },
    livekitApiSecret: {
      type: "string",
      label: "LiveKit API secret",
      description: "Used only to sign access tokens; never sent to a browser.",
      secret: true,
    },
  });

  /** This server's own identity, used as the LiveKit participant name for a
   * caller the room does not (yet) know. Resolved with no request header
   * because an rpc handler never sees one — the `local:<user>` branch. */
  const localName = resolveIdentity(undefined, os.userInfo().username).name;

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
  // Who is WHERE, which is a different question from who is in the sync room:
  // every bb tab reports here on its roster poll, including the many that will
  // never open a canvas. Deliberately not folded into CanvasRoomHost — a room
  // member owns a transport and every canvas delta is published once per
  // transport, so making every bb tab a room member would multiply canvas
  // traffic by the number of tabs that cannot render a canvas. See
  // canvas/locations.ts.
  const locations = new LocationBook();

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
    locations,
    agents,
  );

  registerHttp(bb, transcript);

  registerMentions(bb, transcript);

  bb.rpc.register(
    rpcContract,
    createRpcHandlers({
      room,
      locations,
      agents,
      transcript,
      localName,
      settings,
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

  // The discovery tree, as tools an agent can call (W6). Registered against
  // the LIVE room document — `treeServiceForDoc` re-reads it per query, so a
  // thread started now still sees a node a human drew a minute ago — and
  // scoped to threads that are actually about a tree node, since bb tool names
  // are global and every other thread on the server would otherwise carry six
  // canvas tools it can never use.
  registerTreeAgentTools(bb, {
    service: treeServiceForDoc(room.peer.doc),
    linkedShapeId: (threadId) => agents.shapeForThread(threadId),
  });

  // Cleanup on reload/disable/shutdown; hooks run LIFO. The sanctioned place
  // to clear timers and close connections.
  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
