// Collaborator presence cursors: renders every OTHER peer's cursor (never
// the caller's own) at its current WORLD position, converted to screen via
// worldToScreen like everything else in this overlay.
//
// RemotePresence (OURS — the minimal structural type this component actually
// needs, NOT canvas-sync's `Presence`): canvas-react may not import
// canvas-sync (boundary.test.ts forbids it — clean-room), so this file
// redeclares just the slice it renders: a world-space cursor point (or null),
// plus an optional display name/color. G4 (the client's presence-wiring seam)
// is documented as the adapter from `PresenceStore.all(): Record<string,
// Presence>` (canvas-sync/src/presence.ts) down to `Record<string,
// RemotePresence>` — narrowing `Presence.cursor` (already `{x,y}|null`, same
// shape) and supplying whatever name/color UI layer G4 has, since
// canvas-sync's `Presence` itself carries neither.
//
// SELF-FILTERING (load-bearing — cite the source): canvas-sync's
// `PresenceStore.all()` doc comment states plainly: "Includes the caller's
// own published entry under `selfKey` — Phase 3 renderers should filter it
// out (rendering your own cursor from round-tripped network state is a stale
// duplicate of the local one)." Doing that filtering is explicitly THIS
// component's job (D6 spec) — `selfKey` is a required prop and every entry
// under that exact key is dropped before rendering, unconditionally.
//
// DETERMINISTIC COLOR: when a peer's `RemotePresence.color` is absent, a
// color is picked by hashing `key` (the presence map's own key, i.e. the
// peer id) into a fixed palette — NO wall-clock or PRNG read of any kind
// (boundary.test.ts's raw-text scan forbids the literal call, spelled out
// here only descriptively per camera.ts's own CITATION STYLE precedent for
// dodging a literal-match false trip), and rightly so: the same peer must
// render the same color on every client and every render, which only a pure
// function of a stable input gives you.
//
// PAGE FILTERING (OPT-IN — `currentPageId`): the canvas is multi-page, and
// a peer's `RemotePresence.page` says which page they are on (adapted down
// from canvas-sync's optional `Presence.page`; see that field's doc comment
// for why it is optional and why absent means "unknown"). Three states, and
// the distinction between the last two is the whole point:
//   - `currentPageId` prop ABSENT  -> no filtering at all, today's behaviour
//     exactly. This is what keeps client/src/canvas-v2 (which passes no such
//     prop) rendering unchanged.
//   - prop present, peer's `page` PRESENT and DIFFERENT -> hidden. A cursor
//     drifting through a page you are not on is noise at best; a presence
//     surface that reports it as "here" is wrong and looks right.
//   - prop present, peer's `page` ABSENT or null -> STILL SHOWN. Unknown is
//     not "elsewhere". An older publisher that predates `Presence.page`, or
//     one that has not published a page yet, must not be silently erased.
// This is a render-time filter over network-supplied state — no gesture, no
// FSM, no local interaction of its own.
//
// OFF-VIEWPORT: a cursor whose screen position falls outside
// [0,width]x[0,height] is OMITTED entirely (not clamped to an edge
// indicator) — an explicit v1 simplification (OURS): tldraw's own product
// shows an edge-clamped arrow-plus-label for off-screen collaborators;
// that parity is deferred, noted rather than silently missing.
import { worldToScreen, type Camera } from '@ensembleworks/canvas-editor'
import type { ViewportSize } from '../ShapeLayer.js'

export interface RemotePresence {
  readonly cursor: { readonly x: number; readonly y: number } | null
  readonly name?: string
  readonly color?: string
  /** Which canvas page this peer is on, or null/absent for "unknown".
   * Structurally the same slice as canvas-sync's optional `Presence.page`
   * (which this package may not import — see the header's RemotePresence
   * note), narrowed by the caller's adapter. Only consulted when
   * `CursorsProps.currentPageId` is supplied. */
  readonly page?: string | null
}

export interface CursorsProps {
  readonly presence: Readonly<Record<string, RemotePresence>>
  readonly selfKey: string
  readonly camera: Camera
  readonly viewportSize: ViewportSize
  /** The page the LOCAL view is showing. OPTIONAL: omit it and no page
   * filtering happens at all (see the header's PAGE FILTERING note) — an
   * omission is "this caller is not page-aware", never "the local page is
   * unknown, hide everyone". */
  readonly currentPageId?: string
}

// Fixed palette — arbitrary but stable; swapping these values never changes
// WHICH key maps to WHICH index, only what that index looks like.
const COLOR_PALETTE = ['#e0575b', '#4b8bf4', '#2fa86e', '#d98c2b', '#8a5fd6', '#2aa7a1', '#c2447a', '#6b7a8f'] as const

/** Deterministic string hash (djb2 — a small, well-known, allocation-free
 * hash; no cryptographic property needed, just "stable and well-distributed
 * enough to spread peer ids across the palette"), reduced mod the palette
 * length. Exported so cursors.test.ts can assert "same key -> same color"
 * against this EXACT function rather than just observing the component's
 * output. */
export function colorForKey(key: string): string {
  let hash = 5381
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 33 + key.charCodeAt(i)) | 0 // |0 keeps this a 32-bit int, matching djb2's usual overflow behavior
  }
  const index = Math.abs(hash) % COLOR_PALETTE.length
  return COLOR_PALETTE[index]!
}

function isOnScreen(point: { x: number; y: number }, size: ViewportSize): boolean {
  return point.x >= 0 && point.x <= size.width && point.y >= 0 && point.y <= size.height
}

/** True when this peer should be hidden because they are demonstrably on a
 * DIFFERENT page. Both "the caller is not page-aware" (`currentPageId`
 * undefined) and "the peer has not said" (`page` null/undefined) fall
 * through to false — only a known-and-different pair hides anyone. Exported
 * so cursors.test.ts can assert the three states directly rather than only
 * inferring them from rendered markup. */
export function isOnOtherPage(peerPage: string | null | undefined, currentPageId: string | undefined): boolean {
  if (currentPageId === undefined) return false
  if (peerPage === null || peerPage === undefined) return false
  return peerPage !== currentPageId
}

export function Cursors({ presence, selfKey, camera, viewportSize, currentPageId }: CursorsProps) {
  const entries = Object.entries(presence).filter(
    ([key, peer]) => key !== selfKey && !isOnOtherPage(peer.page, currentPageId),
  )
  if (entries.length === 0) return null

  return (
    <svg
      data-canvas-layer="cursors"
      width={viewportSize.width}
      height={viewportSize.height}
      style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}
    >
      {entries.map(([key, peer]) => {
        if (!peer.cursor) return null // no cursor published (or expired) for this peer — not rendered
        const screen = worldToScreen(camera, peer.cursor)
        if (!isOnScreen(screen, viewportSize)) return null // off-viewport: OMIT (see module header)
        const color = peer.color ?? colorForKey(key)
        return (
          <g key={key} data-overlay="cursor" data-presence-key={key}>
            {/* A small pointer-arrow glyph, tip at the cursor's exact
                screen point — an arbitrary but simple pointer silhouette,
                not a claim of parity with any specific product's cursor
                art. */}
            <polygon
              points={`${screen.x},${screen.y} ${screen.x},${screen.y + 14} ${screen.x + 4},${screen.y + 10} ${screen.x + 7},${screen.y + 16} ${screen.x + 9.5},${screen.y + 15} ${screen.x + 6.5},${screen.y + 9} ${screen.x + 11},${screen.y + 9}`}
              fill={color}
              stroke="var(--canvas-cursor-stroke, #ffffff)"
              strokeWidth={1}
            />
            {peer.name ? (
              <text
                x={screen.x + 12}
                y={screen.y + 12}
                fontSize={11}
                fill={color}
                data-overlay="cursor-label"
              >
                {peer.name}
              </text>
            ) : null}
          </g>
        )
      })}
    </svg>
  )
}
