// Test-only document builder for the discovery-tree suites (W5's service, W6's
// agent tools). Not shipped, not imported by any canvas/ module.
//
// Extracted from tests/tree-service.test.ts at W6 so the tools suite builds
// documents through exactly the same encoding calls the service suite does. A
// second, hand-rolled builder would be a second reading of W0's encoding
// contract, and the two would drift the first time `buildTreeEdge` changed.
import {
  makeDocument,
  type Binding,
  type CanvasDocument,
  type Page,
  type Shape,
} from "@ensembleworks/canvas-model";
import {
  buildTreeEdge,
  buildTreeNode,
  markTreePage,
  type NodeState,
} from "../../canvas/tree/encoding.js";
import { createTreeService, type TreeService } from "../../canvas/tree/service.js";

export const TREE = "page:tree";

/** A note's title lives in its rich text, exactly as canvas-model reads it. */
export const withTitle = (shape: Shape, title: string): Shape =>
  ({
    ...shape,
    props: {
      ...(shape.props as Record<string, unknown>),
      richText: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: title }] }],
      },
    },
  }) as Shape;

export interface Spec {
  /** node id -> state, or [state, title]. */
  readonly nodes: Readonly<Record<string, NodeState | readonly [NodeState, string]>>;
  /** `[blockerId, blockedId]` — W0's fixed "blocker BLOCKS blocked". */
  readonly edges: readonly (readonly [string, string])[];
  readonly treeId?: Page["id"];
  readonly markPage?: boolean;
  readonly extraPages?: readonly Page[];
  readonly context?: Readonly<Record<string, string>>;
}

export function docOf(spec: Spec): CanvasDocument {
  const treeId = spec.treeId ?? TREE;
  const shapes: Shape[] = Object.keys(spec.nodes).map((id, i) => {
    const entry = spec.nodes[id];
    const [state, title] = Array.isArray(entry)
      ? (entry as readonly [NodeState, string])
      : [entry as NodeState, ""];
    const node = buildTreeNode({
      id,
      treeId,
      parentId: treeId,
      index: `a${i}`,
      x: i * 200,
      y: 0,
      state,
      context: spec.context?.[id],
    });
    return title ? withTitle(node, title) : node;
  });
  const bindings: Binding[] = [];
  spec.edges.forEach(([blockerId, blockedId], i) => {
    const built = buildTreeEdge({
      id: `shape:edge-${i}`,
      treeId,
      parentId: treeId,
      index: `b${i}`,
      blockerId,
      blockedId,
      from: { x: 0, y: 0 },
      to: { x: 100, y: 0 },
    });
    shapes.push(built.shape);
    bindings.push(...built.bindings);
  });
  const page: Page = { id: treeId, name: "Tree" };
  return makeDocument({
    pages: [spec.markPage === false ? page : markTreePage(page), ...(spec.extraPages ?? [])],
    shapes,
    bindings,
  });
}

/** A service over a document that never changes. */
export const serviceOf = (spec: Spec): TreeService => {
  const doc = docOf(spec);
  return createTreeService({ document: () => doc });
};

/**
 * The worked example every structural test below uses.
 *
 *      goal            root, blocks nothing
 *      ^   ^
 *    api   ui          the blockers of goal
 *      ^
 *   schema             a ready leaf
 */
export const EXAMPLE: Spec = {
  nodes: {
    "shape:goal": ["todo", "Ship discovery trees"],
    "shape:api": ["wip", "Tree service"],
    "shape:ui": ["todo", "Arrow renderer"],
    "shape:schema": ["todo", "Encoding contract"],
  },
  edges: [
    ["shape:api", "shape:goal"],
    ["shape:ui", "shape:goal"],
    ["shape:schema", "shape:api"],
  ],
};
