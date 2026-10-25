// What a shape "says" — the one text-extraction rule shared by every reader
// of a shape's body. DOM-free and React-free on purpose, the same split
// transport.ts and canvas-editor's session module already use.
//
// MOVED HERE FROM canvas/agents-view.ts (bb-thread-frame cleanup, 2026-09-15).
// That module was the launch-or-attach agent overlay's pure half and is gone
// with it, but `promptTextFor` outlived every one of that overlay's other
// exports: it is the general "what text does this shape carry" rule, not an
// agent-specific one, and the coming `bbthread` shape body needs exactly this
// to seed a spawned thread's prompt from a child shape's text (see
// docs/plans/2026-09-15-bb-thread-frame.md) — as does `bb canvas
// thread-frames` (canvas/thread-frames.ts), reading the same rule from the
// CLI side.
import type { Shape } from "@ensembleworks/canvas-model";

/**
 * The text a shape carries. Live document text first — that is what the
 * plain text editor writes, and therefore what the user actually typed — or
 * whatever a caller reads out of the shape's own text container (see the
 * callers: `session.tsx` reads `editor.doc.getText(shapeId)`, `bb canvas
 * thread-frames` reads `room.peer.doc.getText(shapeId)`) — falling back to
 * flattening a `richText` body, which is how imported and fixture shapes
 * carry their text.
 *
 * The fallback is reimplemented here in five lines rather than imported:
 * canvas-react's own `flattenRichText` is not on its public barrel, and this
 * plugin may not add an export to that package.
 */
export function promptTextFor(shape: Shape | undefined, live: string): string {
  const trimmed = live.trim();
  if (trimmed.length > 0) return trimmed;
  const rich = (shape?.props as Record<string, unknown> | undefined)?.richText;
  return flattenRichText(rich).trim();
}

function flattenRichText(node: unknown): string {
  if (typeof node !== "object" || node === null) return "";
  const value = node as { text?: unknown; content?: unknown };
  if (typeof value.text === "string") return value.text;
  if (Array.isArray(value.content)) return value.content.map(flattenRichText).join("");
  return "";
}
