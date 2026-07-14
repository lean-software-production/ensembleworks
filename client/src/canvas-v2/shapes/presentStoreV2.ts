/**
 * canvas-v2's own "what am I presenting" store — a plain module variable
 * with get/set, deliberately NOT the legacy
 * client/src/file-viewer/presentStore.ts.
 *
 * WHY NOT REUSE THE LEGACY STORE (bundle-leak fix, quality review finding
 * 2): presentStore.ts wraps its state in a tldraw `atom`, and its own doc
 * comment says exactly why — the legacy App.tsx's `getUserPresence` reads
 * it INSIDE tldraw's presence derivation (a tldraw Computed the sync client
 * subscribes to), so the read must be *tracked* or idle scroll updates
 * would never re-emit presence. That is a legacy-engine concern: importing
 * it from canvas-v2 pulled the ENTIRE tldraw package into the v2 import
 * graph at module scope (probe-measured: 932 tldraw markers in a
 * `bun build` of canvas-v2/shapes/index.ts before this fix; 0 after).
 * canvas-v2 does not participate in the tldraw presence bridge at all —
 * nothing tldraw-reactive ever reads this value — so tracked reactivity
 * buys nothing here and a plain variable suffices.
 *
 * INDEPENDENT STORES, BY DESIGN: the legacy tldraw engine's self-present
 * state and this v2 store do not see each other — a presentation toggled
 * in one engine is invisible to the other. Acceptable because a user runs
 * exactly ONE engine per room (the legacy app or G3's CanvasV2App, never
 * both mounted); reconciling them is Phase-5-migration territory, not a
 * v2-shape concern. When v2 grows its own presence surface (the
 * FileViewerShape peer-follow gap — see that file's DROPPED note), that
 * seam decides how this value rides canvas-sync presence.
 */

export type PresentingV2 = {
  shapeId: string
  fraction: number
  /** Toggle-on time (Date.now()) — same last-writer-wins token semantics
   * as the legacy store (see presentStore.ts's doc); callers must PRESERVE
   * it across scroll updates. */
  ts: number
}

let current: PresentingV2 | null = null

export const presentStoreV2 = {
  get: (): PresentingV2 | null => current,
  set(next: PresentingV2 | null): void {
    current = next
  },
}
