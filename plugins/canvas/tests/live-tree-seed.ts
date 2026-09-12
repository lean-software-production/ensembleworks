// W0's hand-made two-node example, seeded into the RUNNING room (not part of
// `npm test`).
//
//   bb canvas status            # confirm the room is up
//   node --import tsx/esm tests/live-tree-seed.ts
//
// Follows tests/live-smoke.ts exactly: a real SyncClientPeer over real HTTP
// rpc, writes flowing client -> server as canvas_frame payloads. There is no
// WebSocket here, so server -> client frames are never received and this peer
// never sees the room's existing content — it only ADDS. Everything it adds
// goes on its OWN page (`page:discovery`), so nothing already in the room is
// touched even though this peer is writing blind.
//
// It proves one thing W0 has to prove: the encoding in canvas/tree/encoding.ts
// is accepted by a real server's real document. The plugin running that server
// knows nothing about trees — a node is an ordinary note and an edge is an
// ordinary arrow — which is exactly why this works before W2 exists. The edge
// will render as canvas-react's BoxShape fallback until W2 registers `arrow`;
// that is the expected, visible W0 state, not a bug.
import assert from "node:assert/strict";
import { SyncClientPeer } from "@ensembleworks/canvas-sync";
import { createBbTransport, newClientId, newPeerId } from "../transport.js";
import {
  buildTreeEdge,
  buildTreeNode,
  markTreePage,
  readTreeEdge,
  readTreeNode,
  readTreePage,
} from "../canvas/tree/encoding.js";

/** The tree's page — and therefore its treeId. Fixed, so re-running this
 * script updates the same two nodes instead of littering the room. */
const TREE_ID = "page:discovery";
const GOAL = "shape:tree-goal";
const BLOCKER = "shape:tree-blocker";
const EDGE = "shape:tree-edge";

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

// The page, marked as a tree. `index` sorts it after the room's existing
// pages (which carry none, and so sort as '').
peer.doc.putPage(markTreePage({ id: TREE_ID, name: "Discovery", index: "a5" }));

// The goal on top, the thing blocking it below — the reading direction a
// discovery tree wants, with the arrow pointing UP into the goal.
const goal = buildTreeNode({
  id: GOAL,
  treeId: TREE_ID,
  parentId: TREE_ID,
  index: "a1",
  x: 0,
  y: 0,
  context: "# Goal\nAn agent and a human can talk about the same tree node.\n",
});
const blocker = buildTreeNode({
  id: BLOCKER,
  treeId: TREE_ID,
  parentId: TREE_ID,
  index: "a2",
  x: 0,
  y: 400,
  state: "wip",
  context: "# Blocker\nThe encoding has to be written down before anything reads it.\n",
});
const edge = buildTreeEdge({
  id: EDGE,
  treeId: TREE_ID,
  parentId: TREE_ID,
  index: "a3",
  blockerId: BLOCKER,
  blockedId: GOAL,
  from: { x: 100, y: 400 },
  to: { x: 100, y: 200 },
});

// Read every value back through this module's own readers BEFORE sending it.
// A write that the readers cannot parse is a bug worth catching here, where
// the failure names the field, rather than in a live room where it is a note
// that quietly is not part of any tree.
assert.equal(readTreeNode(goal).status, "ok");
assert.equal(readTreeNode(blocker).status, "ok");
assert.equal(readTreeEdge(edge.shape, edge.bindings).status, "ok");
assert.equal(readTreePage(peer.doc.listPages()[0]!).status, "ok");

peer.putShape(goal);
peer.doc.setText(GOAL, "Talk to an agent about a node");
peer.putShape(blocker);
peer.doc.setText(BLOCKER, "Fix the tree encoding");
peer.putShape(edge.shape);
for (const binding of edge.bindings) peer.doc.putBinding(binding);
peer.doc.commit();
await transport.flush();

const state = await rpc("canvas_debug", null);
for (const id of [GOAL, BLOCKER, EDGE]) {
  assert.ok(state.shapeIds.includes(id), `server has ${id}: ${JSON.stringify(state.shapeIds)}`);
}
console.log(`seeded ${TREE_ID}: ${GOAL} <- ${EDGE} <- ${BLOCKER}`);
console.log(`room now holds ${state.shapeIds.length} shapes`);

await rpc("canvas_leave", { clientId });
transport.close();
console.log(`\nOpen the Discovery page in the canvas panel to see the two notes.`);
console.log(`The edge renders as the BoxShape fallback until W2 registers 'arrow'.`);
