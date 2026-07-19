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
 * v2-shape concern.
 *
 * TASK D5 ADDITIONS (peer-follow): this module now also holds two more
 * plain, module-scope singletons — same "shape bodies import a shared
 * accessor, not a threaded ShapeBodyProps field" shape as
 * embedLifecycles.ts's `canvasV2EmbedLifecycles`, needed because
 * ShapeBodyProps carries no presence handle at all:
 *   - a PEERS CACHE (`getPeers`/`getSelfKey`/`setPeers`): the latest known
 *     `PresenceStore.all()` snapshot, refreshed by CanvasV2App's existing
 *     presence-poll tick, so FileViewerShape's peer-follow read
 *     (`presenterFor` in ../presence.ts) has something live to resolve
 *     against without a DOM subscription of its own;
 *   - a PUBLISHER HANDLE (`getPublisher`/`setPublisher`): the mount's live
 *     `PresencePublisher` (see presence.ts's `createPresencePublisher`) —
 *     the SAME single-write-per-throttle-interval instance CanvasV2App
 *     wires to pointermove/camera, so a shape body's own `setPresenting`
 *     call rides that ONE combined channel instead of opening a second,
 *     independent `PresenceStore.publish()` path (the exact same-millisecond
 *     LWW hazard `setViewportAndRefreshCursor`'s own doc comment in
 *     presence.ts documents).
 * Both default to an empty/`null` "nothing mounted yet" state so this
 * file's own unit tests (and FileViewerShape's SSR smoke test) never need a
 * live CanvasV2App session.
 */
import type { Presence } from '@ensembleworks/canvas-sync'
import type { PresencePublisher } from '../presence.js'

export type PresentingV2 = {
  shapeId: string
  fraction: number
  /** Toggle-on time (Date.now()) — same last-writer-wins token semantics
   * as the legacy store (see presentStore.ts's doc); callers must PRESERVE
   * it across scroll updates. */
  ts: number
}

let current: PresentingV2 | null = null
let peers: Readonly<Record<string, Presence>> = {}
let peersSelfKey = ''
let activePublisher: PresencePublisher | null = null

export const presentStoreV2 = {
  get: (): PresentingV2 | null => current,
  set(next: PresentingV2 | null): void {
    current = next
  },

  /** The latest known snapshot of every peer's published Presence
   * (INCLUDING this mount's own entry under `getSelfKey()` — same
   * "includes self" contract as `PresenceStore.all()` itself; callers that
   * care about peers only must exclude `getSelfKey()` themselves — see
   * presence.ts's `presenterFor`). */
  getPeers: (): Readonly<Record<string, Presence>> => peers,
  /** This mount's own presence-map key, or `''` before any `setPeers` call
   * (e.g. this file's unit tests, or a shape body rendered before
   * CanvasV2App's first presence-poll tick). */
  getSelfKey: (): string => peersSelfKey,
  setPeers(next: Readonly<Record<string, Presence>>, selfKey: string): void {
    peers = next
    peersSelfKey = selfKey
  },

  /** The mount's live PresencePublisher, or `null` when no CanvasV2App
   * session is mounted. */
  getPublisher: (): PresencePublisher | null => activePublisher,
  setPublisher(next: PresencePublisher | null): void {
    activePublisher = next
  },
}
