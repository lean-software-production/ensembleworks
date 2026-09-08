// WHETHER AN ATTACH IS ALLOWED, AND WHAT COLOUR THE BADGE STARTS AT. Task 2c.
//
// Launching hardcodes "running" and is entitled to: `bb.sdk.threads.spawn`
// starts a turn, so the badge is telling the truth from the first frame
// (server.ts's `canvas_run_note` says exactly this). Attaching has no such
// guarantee — the thread being bound may be mid-turn, idle for a week, or in
// error — so the starting status is DERIVED from what bb reports rather than
// assumed. That derivation, and the four refusals beside it, are decisions, so
// they are here and not in the rpc handler.
//
// NO SDK TYPES ARE IMPORTED, for the same reason canvas/thread-picker.ts
// imports none: `AttachProbe` names exactly the five fields these rules read,
// which is what lets a test hand one over without building a whole
// `ThreadResponse`. Verified against @get-bb/plugin-sdk 0.4.21's
// `threadResponseSchema` on 2026-09-06 — every field below exists on the value
// `bb.sdk.threads.get` resolves to.
import type { CanvasAgentStatus } from "./wire.js";

/** bb's own five thread runtime states, as `threadResponseSchema.status`. */
export type BbThreadStatus = "active" | "error" | "idle" | "starting" | "stopping";

/** The fields of a fetched thread that decide an attach. */
export interface AttachProbe {
  readonly id: string;
  readonly projectId: string;
  readonly archivedAt: number | null;
  readonly deletedAt: number | null;
  readonly status: BbThreadStatus;
}

/** Why an attach was refused. Machine-readable beside the human message so a
 * test can pin WHICH rule fired rather than matching on prose. */
export type AttachRefusal = "gone" | "archived" | "other-project" | "other-shape";

export type AttachVerdict =
  | { readonly ok: true; readonly status: CanvasAgentStatus }
  | { readonly ok: false; readonly reason: AttachRefusal; readonly message: string };

/**
 * bb's five runtime states, mapped onto the badge's three.
 *
 * The badge has exactly three colours (canvas/wire.ts's AGENT_STATUSES) and
 * that is deliberate there, so this is a narrowing and two of its five answers
 * are judgement calls:
 *
 * - `active` -> running, `idle` -> idle, `error` -> failed are the same 1:1
 *   mapping the three thread lifecycle events already use in server.ts.
 * - `starting` -> RUNNING, because that is the state a freshly spawned thread
 *   is in and launch already paints it amber; two paths that disagreed about
 *   the same instant would be a bug visible as a flicker.
 * - `stopping` -> RUNNING, because a turn being cancelled has not finished.
 *   Both readings self-correct — `thread.idle` fires when it settles and moves
 *   the badge either way — so the tie-break is which is wrong in the meantime,
 *   and "finished" claims an answer that is not there yet.
 */
export function attachStatusFor(status: BbThreadStatus): CanvasAgentStatus {
  switch (status) {
    case "error":
      return "failed";
    case "idle":
      return "idle";
    case "active":
    case "starting":
    case "stopping":
      return "running";
    default:
      // A STATUS THIS PLUGIN HAS NEVER HEARD OF. Reachable, not defensive
      // padding: `BbThreadStatus` above is this plugin's OWN hand-written
      // transcription of bb's statuses, and `bb plugin build` warns that the
      // plugin pins @get-bb/plugin-sdk 0.4.21 while this bb ships 0.4.47. A
      // sixth status added upstream reaches here as a value the union says
      // cannot exist, so TypeScript alone cannot stop it.
      //
      // Without this branch the function returned `undefined`,
      // `AgentLinks.record` stored it unvalidated, and `agentLinkFrom`
      // (canvas/agents.ts:103) then DROPPED the broadcast — leaving a shape
      // linked server-side with NO BADGE AT ALL, which reads to the user as
      // "attach silently did nothing". A stale badge self-corrects on the next
      // thread.active/thread.idle event; a missing one never does.
      //
      // `running` rather than `idle` for the SAME tie-break the `stopping`
      // case above argues: when we do not know, "finished" claims an answer
      // that is not there yet, and every plausible new status (queued,
      // waiting, paused) means unfinished.
      return "running";
  }
}

/**
 * May this shape be bound to this thread, and at what status.
 *
 * THE ORDER OF THE REFUSALS IS THE MESSAGE. Each one is checked before the
 * next so the sentence the user gets is the most fundamental true thing:
 * "that thread is gone" beats "that thread is archived" beats "that thread is
 * in another project" beats "that thread is on another shape". A thread can be
 * several of those at once.
 *
 * `gone` / `archived` — the two states canvas/agents.ts's `sweep` retires a
 * link for. Allowing either would mint a badge with a scheduled death: the next
 * gc tick would drop the kv row and publish an unlink, and the user would watch
 * their new badge vanish for no visible reason. Note that a DELETED thread can
 * still be fetched (the sweep reads `deletedAt` off exactly such a fetch), so
 * "the call did not throw" is NOT evidence the thread is usable — which is why
 * the handler's `threads.get` is only half the check and this is the other.
 *
 * `other-project` — defence in depth. `threadListArgsFor` already scopes the
 * picker to the canvas's project, so this is only reachable by a hand-made rpc
 * call or by the project setting changing between the list and the attach. It
 * is refused anyway because a badge that opens a conversation living in a
 * project the user is not watching is precisely the failure Task 2d exists to
 * end — the same argument, one layer down.
 *
 * `other-shape` — THE MIRROR CANNOT HOLD IT. `AgentLinks` keys BOTH directions
 * (`#byShape` and `#shapeByThread`), so a thread on two shapes would leave the
 * second shape owning the reverse entry: the first shape's badge would freeze
 * at whatever status it had, `thread.idle` would only ever move the second, and
 * `removeByThread` would only ever retire the second. That is silent
 * corruption, so it is refused rather than allowed.
 *
 * The two alternatives were considered and rejected. Silently moving the link
 * (unlinking the other shape) is a destructive edit to a shape the user did not
 * select and may not be able to see. Making the mirror a multimap changes
 * `apply` and `removeByThread` for the LAUNCH path too, which is a far larger
 * blast radius than this task warrants.
 *
 * RE-ATTACHING THE SAME THREAD TO THE SAME SHAPE IS ALLOWED — `holderShapeId`
 * is compared, not merely tested for presence. Two tabs can both press it, and
 * a shape re-picking the thread it already has is not an error; it is the state
 * that was asked for. (Re-attaching a shape to a DIFFERENT thread is also
 * allowed and is not checked here at all: `AgentLinks.record` replaces a
 * shape's link by design, and its own header argues why.)
 */
export function attachVerdictFor(input: {
  readonly thread: AttachProbe;
  /** The shape being bound. */
  readonly shapeId: string;
  /** The shape this thread is already on, or null. */
  readonly holderShapeId: string | null;
  /** The project the canvas's agents live in. */
  readonly canvasProjectId: string;
}): AttachVerdict {
  const { thread, shapeId, holderShapeId, canvasProjectId } = input;
  if (thread.deletedAt !== null) {
    return {
      ok: false,
      reason: "gone",
      message: `Thread ${thread.id} has been deleted in bb, so there is nothing to attach to.`,
    };
  }
  if (thread.archivedAt !== null) {
    return {
      ok: false,
      reason: "archived",
      message: `Thread ${thread.id} is archived. Unarchive it in bb first — an archived thread's badge would be swept away again.`,
    };
  }
  if (thread.projectId !== canvasProjectId) {
    return {
      ok: false,
      reason: "other-project",
      message: `Thread ${thread.id} lives in project ${thread.projectId}, not the canvas's project ${canvasProjectId}.`,
    };
  }
  if (holderShapeId !== null && holderShapeId !== shapeId) {
    return {
      ok: false,
      reason: "other-shape",
      message: `Thread ${thread.id} is already attached to ${holderShapeId}. Unlink it there first — one thread can only badge one shape.`,
    };
  }
  return { ok: true, status: attachStatusFor(thread.status) };
}
