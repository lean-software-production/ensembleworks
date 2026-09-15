import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { dumpModel } from "@ensembleworks/canvas-doc";
import type { CanvasRoomHost } from "./room.js";
import { parseTranscriptArgs, type TranscriptStore } from "./transcript.js";
import { formatTranscriptLine } from "./transcript-view.js";
import { formatThreadFrames, threadFrameRows } from "./thread-frames.js";

export function registerCanvasCli(
  bb: BbPluginApi,
  room: CanvasRoomHost,
  transcript: TranscriptStore,
): void {
  const usage = [
    "Usage:",
    "  bb canvas status [--json]   Room, connected clients, shape count",
    "  bb canvas shapes [--json]   Every shape id in the room",
    "  bb canvas thread-frames [--json]",
    "                              Every bbthread frame and its children",
    "  bb canvas transcript [--since 10m|2h|1d] [--search TEXT] [--speaker NAME] [--limit N] [--json]",
    "                              What was said in the room",
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
        name: "thread-frames",
        summary: "List every bbthread frame — its name, bound thread, and children",
        usage: "bb canvas thread-frames [--json]",
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
        case "thread-frames": {
          const rows = threadFrameRows(
            dumpModel(room.peer.doc),
            (shapeId) => room.peer.doc.getText(shapeId),
          );
          return {
            exitCode: 0,
            stdout: json ? JSON.stringify(rows) : formatThreadFrames(rows),
          };
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });
}
