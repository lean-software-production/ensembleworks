// The pure half of `bb canvas thread-frames`: which `bbthread` shapes exist
// in the room, and what their direct children say. DOM-free and SDK-free —
// it reads a plain canvas-model `CanvasDocument` plus a `getText` lookup, so
// it is unit-testable with `makeDocument` fixtures alone, the same split
// canvas/thread-picker.ts and canvas/agent-project.ts already use for their
// own CLI/rpc-adjacent decisions.
//
// bb-thread-frame ground-prep (2026-09-15, docs/plans/2026-09-15-bb-thread-
// frame.md): the shape body itself is a later agent's work; this module only
// prepares the read side an agent (or a human) can already use from a shell.
//
// COMPARED AS A STRING, NOT THE `ShapeKind` LITERAL. A sibling change is
// adding `'bbthread'` to canvas-model's `SHAPE_KINDS` union concurrently with
// this one, so this file must typecheck whichever of the two lands first (and
// whichever order they are rebased in). `BBTHREAD_KIND` is typed `string`,
// not the literal, so `shape.kind === BBTHREAD_KIND` compiles whether or not
// `'bbthread'` is a member of `ShapeKind` yet.
import { childrenOf, type CanvasDocument, type Shape } from "@ensembleworks/canvas-model";
import { promptTextFor } from "./shape-text.js";

const BBTHREAD_KIND: string = "bbthread";

/** One direct child of a `bbthread` frame. */
export interface ThreadFrameChild {
  readonly id: string;
  readonly kind: string;
  /** The child's text (live text or its `richText` fallback — see
   * `promptTextFor`), or null when it carries none. Null rather than "" so a
   * caller can tell "no text" from "empty string", which is meaningless. */
  readonly text: string | null;
}

/** One `bbthread` shape and its direct children. */
export interface ThreadFrameRow {
  readonly id: string;
  /** The frame's header label, or null when unset — mirrors `FrameShape`'s
   * own optional `name`. */
  readonly name: string | null;
  /** The bound project thread, or null when the frame is still unbound. */
  readonly threadId: string | null;
  readonly children: ThreadFrameChild[];
}

function stringProp(props: unknown, key: string): string | null {
  const value = (props as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Whether the document currently contains a `bbthread` frame bound to this
 * thread. Kept beside `threadFrameRows` so the CLI and header visibility use
 * the same definition of a real binding, including the empty-string unbind
 * convention. */
export function hasThreadFrameFor(shapes: Iterable<Shape>, threadId: string): boolean {
  if (threadId.trim().length === 0) return false;
  for (const shape of shapes) {
    if (shape.kind === BBTHREAD_KIND && stringProp(shape.props, "threadId") === threadId) return true;
  }
  return false;
}

/**
 * Every `bbthread` shape in the document, each with its direct children
 * (canvas-model's `childrenOf` — direct only, not the whole subtree: a
 * frame's grandchildren are not what seeds its prompt or shows up in its
 * pane).
 *
 * SORTED BY ID, not by document/CRDT insertion order, which is not stable
 * across peers — the same tie-break `threadPickerOptions` uses and for the
 * same reason: two callers reading the same converged document must see the
 * same order.
 */
export function threadFrameRows(
  doc: CanvasDocument,
  getText: (shapeId: string) => string,
): ThreadFrameRow[] {
  return doc.shapes
    .filter((shape) => shape.kind === BBTHREAD_KIND)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((shape) => ({
      id: shape.id,
      name: stringProp(shape.props, "name"),
      threadId: stringProp(shape.props, "threadId"),
      children: childrenOf(doc, shape.id).map((child) => {
        const text = promptTextFor(child, getText(child.id));
        return { id: child.id, kind: child.kind, text: text.length > 0 ? text : null };
      }),
    }));
}

/** Human-readable rendering: one line per frame, its children indented under
 * it — the same "summary line, indented detail" shape `bb canvas status`
 * already uses for its client list. */
export function formatThreadFrames(rows: readonly ThreadFrameRow[]): string {
  if (rows.length === 0) return "No thread frames.";
  return rows
    .map((row) => {
      const boundLabel = row.threadId === null ? "unbound" : row.threadId;
      const header = `${row.name ?? row.id}  [${row.id}]  ->  ${boundLabel}`;
      const children = row.children.length === 0
        ? "    (no children)"
        : row.children
          .map((child) => `    ${child.kind}  ${child.id}${child.text === null ? "" : `  ${JSON.stringify(child.text)}`}`)
          .join("\n");
      return `${header}\n${children}`;
    })
    .join("\n");
}
