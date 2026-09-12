import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CanvasRoomHost } from "./room.js";
import type { AgentLinks } from "./agents.js";
import { parseTranscriptArgs, type TranscriptStore } from "./transcript.js";
import { runTreeCli, type TreeCliDeps } from "./tree/cli-view.js";
import { formatTranscriptLine } from "./transcript-view.js";

export function registerCanvasCli(
  bb: BbPluginApi,
  room: CanvasRoomHost,
  agents: AgentLinks,
  transcript: TranscriptStore,
  tree: TreeCliDeps,
): void {
  const usage = [
    "Usage:",
    "  bb canvas status [--json]   Room, connected clients, shape count",
    "  bb canvas shapes [--json]   Every shape id in the room",
    "  bb canvas agents [--json]   Every shape -> agent-thread link",
    "  bb canvas transcript [--since 10m|2h|1d] [--search TEXT] [--speaker NAME] [--limit N] [--json]",
    "                              What was said in the room",
    "  bb canvas tree [show|node|ready|quarantined|restore] …",
    "                              The discovery tree on the canvas (bb canvas tree help)",
  ].join("\n");
  bb.cli.register({
    name: "canvas",
    summary: "Inspect the Canvas plugin's live room",
    commands: [
      {
        name: "status",
        summary: "Show the room, its connected clients, and its shape count",
        usage: "bb canvas status [--json]",
      },
      {
        name: "shapes",
        summary: "List every shape id in the room",
        usage: "bb canvas shapes [--json]",
      },
      {
        name: "agents",
        summary: "List every note -> agent-thread link and its status",
        usage: "bb canvas agents [--json]",
      },
      {
        // ONE entry for the whole verb set: `commands` is flat metadata keyed
        // by first token, and this is what `bb --help` and the
        // plugin-commands skill read WITHOUT executing plugin code — so the
        // sub-verbs have to live in the usage line or they are invisible to
        // the agent this command exists for.
        name: "tree",
        summary:
          "Read the discovery tree on the canvas: its trees, one node, the outline, what is ready, and what repair took out",
        usage:
          "bb canvas tree [--json] | show [ID] [--depth N] | node <NODE> | ready [TREE] | quarantined [TREE] | restore <EDGE>",
      },
      {
        name: "transcript",
        summary:
          "Read what was said in the room, filtered by time, speaker or text",
        usage:
          "bb canvas transcript [--since 10m|2h|1d] [--search TEXT] [--speaker NAME] [--limit N] [--json]",
      },
    ],
    run(argv) {
      const json = argv.includes("--json");
      const [command] = argv.filter((arg) => arg !== "--json");
      if (command === "transcript") {
        const parsed = parseTranscriptArgs(
          argv.slice(argv.indexOf("transcript") + 1),
          Date.now(),
        );
        if (!parsed.ok) {
          return {
            exitCode: 1,
            stderr: `bb canvas transcript: ${parsed.error}\n\n${usage}`,
          };
        }
        const entries = transcript.query(parsed.filter);
        return {
          exitCode: 0,
          stdout: (parsed.json || json)
            ? JSON.stringify(entries)
            : entries.length === 0
            ? "No transcript entries."
            : entries.map(formatTranscriptLine).join("\n"),
        };
      }
      if (command === "tree") {
        // The CLI runs INSIDE the plugin server process, so it holds the live
        // room document directly — the same one the agent tools read, with no
        // rpc, no snapshot and no staleness between them.
        return runTreeCli(argv.slice(argv.indexOf("tree") + 1), tree);
      }
      const shapeIds = room.peer.doc.listShapes().map((shape) => shape.id);
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "status": {
          const identities = room.identities;
          const status = {
            room: room.room,
            clients: room.clientIds.map((clientId) =>
              identities[clientId] === undefined
                ? clientId
                : `${identities[clientId]} (${clientId})`
            ),
            shapes: shapeIds.length,
            pendingUpdates: room.pendingUpdates,
          };
          return {
            exitCode: 0,
            stdout: json ? JSON.stringify(status) : [
              `room:     ${status.room}`,
              `clients:  ${
                status.clients.length === 0 ? "none" : status.clients.join(", ")
              }`,
              `shapes:   ${status.shapes}`,
              `pending:  ${status.pendingUpdates} update(s) since last snapshot`,
            ].join("\n"),
          };
        }
        case "shapes":
          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify(shapeIds)
              : shapeIds.length === 0
              ? "No shapes."
              : shapeIds.join("\n"),
          };
        case "agents": {
          const links = agents.links;
          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify(links)
              : links.length === 0
              ? "No shapes are linked to agent threads."
              : links.map((link) =>
                `${link.status.padEnd(7)} ${link.shapeId}  ->  ${link.threadId}`
              ).join("\n"),
          };
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });
}
