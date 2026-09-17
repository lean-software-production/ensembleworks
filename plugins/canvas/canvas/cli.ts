import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { dumpModel } from "@ensembleworks/canvas-doc";
import type { CanvasRoomHost } from "./room.js";
import { formatThreadFrames, threadFrameRows } from "./thread-frames.js";

export function registerCanvasCli(
  bb: BbPluginApi,
  room: CanvasRoomHost,
): void {
  const usage = [
    "Usage:",
    "  bb canvas status [--json]   Room, connected clients, shape count",
    "  bb canvas shapes [--json]   Every shape id in the room",
    "  bb canvas thread-frames [--json]",
    "                              Every bbthread frame and its children",
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
    ],
    run(argv) {
      const json = argv.includes("--json");
      const [command] = argv.filter((arg) => arg !== "--json");
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
