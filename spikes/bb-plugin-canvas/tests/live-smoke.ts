// Manual end-to-end smoke against a RUNNING bb server (not part of `npm test`).
//
//   bb plugin reload canvas
//   node --import tsx/esm tests/live-smoke.ts
//
// Drives a real SyncClientPeer over real HTTP rpc. There is no WebSocket here,
// so server -> client frames are polled out of `canvas_debug` rather than
// received on the realtime channel: this proves the CLIENT -> SERVER half and
// persistence. The full duplex path is covered by tests/canvas-sync.test.ts.
import assert from "node:assert/strict";
import { SyncClientPeer } from "@ensembleworks/canvas-sync";
import { createBbTransport, newClientId, newPeerId } from "../transport.js";

const base = process.env.BB_SERVER_URL ?? "http://127.0.0.1:38886";
const rpc = async (method: string, input: unknown): Promise<any> => {
  const response = await fetch(`${base}/api/v1/plugins/canvas/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify(input),
  });
  const body = await response.json();
  if (body.ok !== true) throw new Error(`${method}: ${JSON.stringify(body)}`);
  return body.result;
};

const clientId = newClientId();
const transport = createBbTransport({
  clientId,
  sendFrame: (payload) => rpc("canvas_frame", payload),
  onError: (error) => {
    console.error("send failed:", error);
  },
});

await rpc("canvas_join", { clientId });
const peer = new SyncClientPeer({ peerId: newPeerId(), transport });
peer.doc.putPage({ id: "page:p", name: "P" });
const id = `shape:live-${Date.now()}`;
peer.putShape({
  id,
  kind: "note",
  parentId: "page:p",
  props: {},
  index: "a1",
  x: 0,
  y: 0,
  rotation: 0,
  isLocked: false,
  opacity: 1,
  meta: {},
} as never);
await transport.flush();

const state = await rpc("canvas_debug", null);
assert.ok(state.shapeIds.includes(id), `server has ${id}: ${JSON.stringify(state)}`);
console.log("live server accepted the write:", state);

await rpc("canvas_leave", { clientId });
transport.close();
console.log(`\nNow run:  bb plugin reload canvas  &&  bb canvas-debug-check`);
console.log(`Expect ${id} to still be present in canvas_debug after the reload.`);
