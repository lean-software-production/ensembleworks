// How BbThreadShape.tsx's "Open full ->" footer button reaches the canvas's
// own return-to-canvas navigation, without threading an `onOpen` prop
// through `ShapeBodyProps` (a contract shared by every registered shape —
// see canvas-react's shapeRegistry.ts — that this plugin may not extend just
// for one shape).
//
// A MODULE-LEVEL REGISTRY, set once from session.tsx (which already builds
// exactly this call — `useThreadReturn`'s return value, wired to
// `SessionView`'s existing `onOpen` prop — see that file's own doc comment:
// "the coming `bbthread` shape body's 'Open full ->' footer button is
// exactly this call"). One canvas session is mounted at a time per panel, so
// one module-level slot is enough; a second session mounting (a page
// remount, a reconnect) simply overwrites it, and unmounting clears it so a
// stale session's callback can never fire after its `Editor` is gone.
export interface BbThreadHost {
  readonly openThread: (threadId: string) => void;
}

let host: BbThreadHost | null = null;

export function setBbThreadHost(next: BbThreadHost | null): void {
  host = next;
}

/** Opens `threadId` through the registered host, or does nothing when no
 * session has registered one yet (e.g. a body rendered before boot
 * finishes) — a silent no-op, not a throw, matching this plugin's
 * "tolerant, never a hard failure over a UI affordance" posture. */
export function openBbThread(threadId: string): void {
  host?.openThread(threadId);
}
