// The `bbthread` shape body's pure decisions — DOM-free, host-SDK-free, and
// React-free on purpose, the same split every other decision module in this
// plugin already makes (canvas/thread-picker.ts, canvas/thread-frames.ts):
// BbThreadShape.tsx is "hands only" and calls every function here rather
// than re-deciding inline, so this file is where the real unit tests live
// (bbthread-model.test.ts) — see docs/plans/2026-09-15-bb-thread-frame.md.
//
// FOUR THINGS LIVE HERE:
//   1. `bbthreadPaneState` — what the pane shows: unbound / loading / bound
//      (with a title, a status pill and a tone) / gone.
//   2. `spawnPromptFor` — the seed prompt for "New thread from these
//      elements", joining the frame's children's text.
//   3. `reduceInteractionMode` / `shouldSwallowEvents` — the idle/focused
//      state machine the web app's client/src/canvas-v2/shapes/
//      interactionMode.ts already ships. REIMPLEMENTED HERE, NOT IMPORTED:
//      this plugin may not depend on `client/`, and the rule itself is one
//      paragraph — see OURS v1 below, copied verbatim from that file's own
//      header so the two never state the policy differently.
//   4. `paneLayout` — the pane's own local-pixel sub-rects (title row /
//      chat body / footer), built on top of canvas-model's
//      `bbthreadPaneLocalBounds`/`bbthreadWorkspaceLocalBounds`/
//      `frameHeaderLocalBounds`, which already know the OUTER pane/workspace/
//      header split (hit-testing depends on it); this file only subdivides
//      the pane's own interior, which hit-testing has no opinion about.
import type { Bounds, Shape } from "@ensembleworks/canvas-model";
import { bbthreadPaneLocalBounds, bbthreadWorkspaceLocalBounds, frameHeaderLocalBounds } from "@ensembleworks/canvas-model";
import { promptTextFor } from "../shape-text.js";

// ---------------------------------------------------------------------------
// 1. PANE STATE
// ---------------------------------------------------------------------------

export type PaneTone = "working" | "idle" | "attention" | "failed";

export interface UnboundPaneState {
  readonly kind: "unbound";
}
export interface LoadingPaneState {
  readonly kind: "loading";
}
export interface BoundPaneState {
  readonly kind: "bound";
  readonly title: string;
  readonly statusLabel: string;
  readonly tone: PaneTone;
  readonly isArchived: boolean;
}
export interface GonePaneState {
  readonly kind: "gone";
}
export type PaneState = UnboundPaneState | LoadingPaneState | BoundPaneState | GonePaneState;

/**
 * The fields this module reads off a host `experimental_useSidebarThreads()`
 * row — a local structural type, same posture as thread-picker.ts's own
 * `ThreadListRow`: a component that needs eight fields should not have to
 * hand a test a whole SDK type to prove it.
 */
export interface SidebarThreadLike {
  readonly id: string;
  readonly title: string | null;
  readonly titleFallback: string | null;
  readonly indicator: string;
  readonly indicatorLabel: string | null;
  readonly isArchived: boolean;
  readonly hasPendingInteraction: boolean;
  readonly activity: {
    readonly workflows: number;
    readonly backgroundAgents: number;
    readonly backgroundCommands: number;
    readonly planMode: number;
    readonly goals: number;
  };
}

/** `experimental_useSidebarThreads().status`, restated locally for the same
 * reason as `SidebarThreadLike` above. */
export type SidebarThreadsStatus = "loading" | "ready" | "error";

/**
 * A `bbthread` shape's `threadId` prop, or null when unbound.
 *
 * EMPTY STRING COUNTS AS UNBOUND, deliberately: canvas-editor's `UpdateProps`
 * intent is a props-only MERGE (canvas-doc's `updateProps`), and the CRDT
 * layer turns a merged-in `undefined` into `null`, which the shape's own
 * `threadId: z.string().optional()` schema then rejects — so an `Unbind`
 * action has no way to truly REMOVE the key. Writing `""` instead, and
 * treating it identically to "absent" everywhere a `bbthread` shape's binding
 * is read, is this plugin's one workaround for that gap (mirrors
 * thread-frames.ts's own `stringProp` — non-empty-after-trim, or null).
 */
export function threadIdOf(shape: Shape): string | null {
  const raw = (shape.props as Record<string, unknown>).threadId;
  return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
}

function titleOf(thread: SidebarThreadLike): string {
  const title = (thread.title ?? "").trim();
  if (title.length > 0) return title;
  const fallback = (thread.titleFallback ?? "").trim();
  if (fallback.length > 0) return fallback;
  return thread.id;
}

const WORKING_INDICATORS = new Set(["working-draft", "runtime", "background-agent", "background-command", "workflow"]);

function activityCount(activity: SidebarThreadLike["activity"]): number {
  return activity.workflows + activity.backgroundAgents + activity.backgroundCommands + activity.planMode + activity.goals;
}

/**
 * A bound thread's tone: `attention` when it is waiting on the user (either
 * the host's own `hasPendingInteraction` flag or its "waiting-for-input"
 * indicator — the same fact, asked two ways, so either is enough), `failed`
 * on an unread-error indicator, `working` while any activity counter is
 * nonzero or the indicator itself names running work, else `idle`.
 */
export function toneFor(thread: SidebarThreadLike): PaneTone {
  if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input") return "attention";
  if (thread.indicator === "unread-error") return "failed";
  if (activityCount(thread.activity) > 0 || WORKING_INDICATORS.has(thread.indicator)) return "working";
  return "idle";
}

const TONE_LABEL: Record<PaneTone, string> = { working: "Working", idle: "Idle", attention: "Needs input", failed: "Failed" };

function statusLabelFor(thread: SidebarThreadLike, tone: PaneTone): string {
  return thread.indicatorLabel ?? TONE_LABEL[tone];
}

/**
 * The pane's state — see the four-way union above.
 *
 * `unbound`: no `threadId` (see `threadIdOf`).
 * `loading`: a `threadId` is set, but the sidebar's live list is not `ready`
 * yet (still `loading`, or `error` — treated the same here: neither tells
 * this pane anything more specific than "not resolved yet", and the sidebar
 * itself is expected to retry).
 * `gone`: `ready`, but no row matches this `threadId`, or the one that does
 * is archived — either way the thread this frame pointed at is not
 * reachable from here any more.
 * `bound`: `ready` and a live, non-archived row matches.
 */
export function bbthreadPaneState(shape: Shape, thread: SidebarThreadLike | undefined, status: SidebarThreadsStatus): PaneState {
  const threadId = threadIdOf(shape);
  if (threadId === null) return { kind: "unbound" };
  if (status !== "ready") return { kind: "loading" };
  if (thread === undefined || thread.isArchived) return { kind: "gone" };
  const tone = toneFor(thread);
  return { kind: "bound", title: titleOf(thread), statusLabel: statusLabelFor(thread, tone), tone, isArchived: thread.isArchived };
}

// ---------------------------------------------------------------------------
// 2. SPAWN PROMPT
// ---------------------------------------------------------------------------

/**
 * The seed prompt for "New thread from these elements": every child's text
 * (`promptTextFor`, shape-text.ts's shared rule), ordered top-to-bottom then
 * left-to-right (`y` then `x` — a frame's children share ITS parent frame,
 * so their own `x`/`y` are already local offsets within it, exactly the
 * reading order the plan's mockup describes), blank children dropped, joined
 * with a blank line between them. Null (not "") when nothing survives, so
 * the spawn button can disable itself on an honest "there is nothing to
 * seed from" rather than trying to spawn an empty-prompt thread.
 */
export function spawnPromptFor(children: readonly Shape[], getText: (id: string) => string): string | null {
  const lines = [...children]
    .sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((child) => promptTextFor(child, getText(child.id)))
    .filter((text) => text.length > 0);
  return lines.length === 0 ? null : lines.join("\n\n");
}

// ---------------------------------------------------------------------------
// 3. INTERACTION MODE (idle/focused) — reimplemented, not imported; see the
// module header for why.
// ---------------------------------------------------------------------------

/**
 * OURS v1 (copied verbatim from client/src/canvas-v2/shapes/
 * interactionMode.ts's own header, which is the ratified statement of this
 * policy — restated here because this plugin cannot import that file):
 *
 *   'idle'    — a single click selects the shape; pointer/keyboard events
 *               are NOT swallowed, so they reach the canvas's own
 *               select/pan/zoom handling exactly like any other shape.
 *   'focused' — entered via a dedicated affordance (double-click on the
 *               pane); pointer/keyboard events ARE swallowed
 *               (stopPropagation) so scrolling the timeline, clicking a
 *               message, etc. never also drives canvas tools. Escape or a
 *               click outside the pane's own DOM exits back to 'idle'.
 */
export type InteractionMode = "idle" | "focused";

export type InteractionEvent = "focus-request" | "exit-request";

/** Pure transition table — total, idempotent no-ops where the event doesn't
 * apply (a focus-request while already focused stays focused; an
 * exit-request while already idle stays idle). */
export function reduceInteractionMode(mode: InteractionMode, event: InteractionEvent): InteractionMode {
  if (event === "focus-request") return "focused";
  return "idle";
}

/** True iff `mode` should stopPropagation on pointer/wheel/keyboard events
 * reaching the pane — the one predicate every event handler in
 * BbThreadShape.tsx consults, so idle/focused -> swallow-or-not is decided
 * in exactly one place. */
export function shouldSwallowEvents(mode: InteractionMode): boolean {
  return mode === "focused";
}

// ---------------------------------------------------------------------------
// 4. PANE LAYOUT
// ---------------------------------------------------------------------------

/** Height of the pane's own title row (thread title + status pill). */
export const PANE_HEADER_ROW_HEIGHT = 32;
/** Height of the pane's own footer row (short thread id + "Open full ->"). */
export const PANE_FOOTER_HEIGHT = 36;

export interface BbThreadLayout {
  /** The frame's header band (name label), ABOVE the shape's own box —
   * canvas-model's `frameHeaderLocalBounds`, unchanged; restated here so
   * BbThreadShape.tsx has one function to call for every rect it needs. */
  readonly header: Bounds;
  /** The hollow left two-thirds where captured children live. */
  readonly workspace: Bounds;
  /** The solid right-third thread pane, the whole thing. */
  readonly pane: Bounds;
  /** The pane's own title row: thread title + status pill. */
  readonly paneHeaderRow: Bounds;
  /** The pane's own middle: the `ThreadChat` mount (or the picker/gone
   * message, when unbound/gone). Never inverted — clamped so a pane too
   * short for its own header+footer rows still reports a nonnegative body,
   * matching this codebase's "over-inclusion/clamped, never inverted"
   * geometry convention (canvas-model/src/geometry.ts's own `size()`). */
  readonly paneBody: Bounds;
  /** The pane's own footer row: short thread id + "Open full ->". */
  readonly paneFooter: Bounds;
}

export function paneLayout(shape: Shape): BbThreadLayout {
  const header = frameHeaderLocalBounds(shape);
  const workspace = bbthreadWorkspaceLocalBounds(shape);
  const pane = bbthreadPaneLocalBounds(shape);
  const paneHeaderRow: Bounds = { minX: pane.minX, minY: pane.minY, maxX: pane.maxX, maxY: pane.minY + PANE_HEADER_ROW_HEIGHT };
  const paneFooter: Bounds = { minX: pane.minX, minY: pane.maxY - PANE_FOOTER_HEIGHT, maxX: pane.maxX, maxY: pane.maxY };
  const bodyMaxY = Math.max(paneHeaderRow.maxY, paneFooter.minY);
  const paneBody: Bounds = { minX: pane.minX, minY: paneHeaderRow.maxY, maxX: pane.maxX, maxY: bodyMaxY };
  return { header, workspace, pane, paneHeaderRow, paneBody, paneFooter };
}
