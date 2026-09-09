// The ANSWER VOCABULARY every tree tool speaks — read (W6) and write (W10).
//
// Extracted from agent-tools.ts at W10, verbatim, for the reason W6 extracted
// tests/lib/tree-fixture.ts: a second copy of `id — title [state] (ready)`
// would be a second vocabulary, and the two would drift the first time either
// one changed. A model reading a write's answer must recognise the same node
// line it just read in a digest, or it has to learn the surface twice.
//
// Nothing here reads a document or a service: the input is W5's flattened
// views, the output is text.
import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";
import type { SubtreeView, TreeNodeView, TreeQuery } from "./service.js";

/**
 * Ceiling on one tool answer. Twice the digest's own 2,000, because a subtree
 * or a blocker list is allowed to be the BIG answer a model asks for after the
 * digest told it something was missing — but still bounded, since a tool
 * result lands in the same context window the digest was rationing.
 */
export const MAX_ANSWER_CHARS = 4_000;

/** Longest node list any one answer spells out before it starts counting. */
export const MAX_LISTED = 40;

/** A node's title, or the one word said in its place.
 *
 * WIDENED to anything carrying a title (W9's `NodeCardFacts`, which is the rpc
 * subset a `::node` card gets, not a whole `TreeNodeView`). `TreeNodeView` is
 * still assignable, so every existing caller is unchanged — and there is now
 * one definition of what an untitled node is CALLED, rather than a second one
 * in the card that could drift from what a model is told. */
export const titleOf = (view: { readonly title: string }): string =>
  view.title.trim() === "" ? "(untitled)" : view.title.trim();

/** One node on one line: the unit every list answer is built from. */
export const oneLine = (view: TreeNodeView): string =>
  `${view.id} — ${titleOf(view)} [${view.state}]${view.isReady ? " (ready)" : ""}`;

/** A list of nodes, capped, saying what it left out. */
export function listing(views: readonly TreeNodeView[], empty: string): string {
  if (views.length === 0) return empty;
  const shown = views.slice(0, MAX_LISTED).map(oneLine);
  if (views.length > MAX_LISTED) {
    shown.push(
      `… ${views.length - MAX_LISTED} of ${views.length} not shown — ask about a node by id for the rest`,
    );
  }
  return shown.join("\n");
}

/** A subtree as an indented outline, with the service's own cut markers. */
export function outline(view: SubtreeView, depth = 0): string[] {
  const indent = "  ".repeat(depth);
  const lines = [`${indent}${oneLine(view.node)}`];
  for (const child of view.children) lines.push(...outline(child, depth + 1));
  if (view.elided === "depth") {
    lines.push(
      `${indent}  … blockers not shown (depth) — call canvas_tree_subtree on ${view.node.id}`,
    );
  }
  if (view.elided === "cycle") {
    lines.push(`${indent}  … blockers not shown (cycle) — this node is already above`);
  }
  return lines;
}

/** Trim an answer to the ceiling, saying so in the answer itself. */
export function bounded(text: string): string {
  if (text.length <= MAX_ANSWER_CHARS) return text;
  const marker = "\n… answer cut here — ask a narrower question";
  return text.slice(0, MAX_ANSWER_CHARS - marker.length) + marker;
}

export const ok = (text: string): PluginAgentToolResult => ({
  content: [{ type: "text", text: bounded(text) }],
});

/**
 * A refusal the model can act on.
 *
 * `isError` is set, and that is NOT a retreat from W5's "a miss is data, not a
 * throw" — nothing throws here, the tool set stays up, and the next call works.
 * The flag exists so a model cannot mistake the sentence "no node shape:x" for
 * tree CONTENT it just read. W5's rule is about the service never failing;
 * this one is about the answer never being ambiguous. W10 leans on it harder
 * still: a REFUSED WRITE that read as prose would leave a model believing it
 * had changed a tree it did not touch.
 */
export const refuse = (text: string): PluginAgentToolResult => ({
  content: [{ type: "text", text: bounded(text) }],
  isError: true,
});

/** A failed query, rendered with the reason the service gave. */
export const failed = <T>(
  result: Extract<TreeQuery<T>, { ok: false }>,
): PluginAgentToolResult => refuse(`${result.reason}: ${result.detail}`);
