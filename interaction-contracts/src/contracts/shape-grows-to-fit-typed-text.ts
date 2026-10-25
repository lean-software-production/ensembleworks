// text-autosize task — a browser-level contract for growY-on-typed-text.
// Structurally browser-only (like enter-key-edit-preserves-text.ts): the
// measurement that decides growY happens in the DOM (canvas-react's
// TextEditor.tsx + a measure-text helper), so a headless FSM run (no DOM at
// all) has nothing to measure — there is no meaningful FSM-level version of
// this contract to write, matching the established throw-stub precedent for
// DOM-only observations elsewhere in this package.
//
// Reuses the EXISTING `shapeStyle` Obs method (already implemented at BOTH
// levels — see types.ts's doc comment on it) rather than adding a new Obs
// method: `shapeStyle(id, 'growY')` reads `props.growY` directly off the
// doc, which is exactly what canvas-model/geometry.ts's `size()` reads to
// grow a note/geo's rendered box. No new Obs surface, so no fsm-runner.ts /
// e2e/lib/contracts.ts adapter changes are needed for this declaration.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const NOTE_ID = 'shape:autosize-note'
const GEO_ID = 'shape:autosize-geo'

// A long, break-friendly sentence with no long unbreakable tokens — repeated
// enough to wrap many lines at either seeded shape's box width and push well
// past both shapes' default box heights (note: 200; geo: the seeded h:80).
const LONG_TEXT = Array(10).fill('grow the box to fit the text').join(' ')

function typeText(text: string): GestureOp[] {
  return Array.from(text).map((ch) => ({ kind: 'key' as const, key: ch }))
}

export const shapeGrowsToFitTypedText: Contract = {
  name: 'shape-grows-to-fit-typed-text',
  level: 'browser',
  tool: 'select',
  when: 'at-end',
  scene: () => [
    { id: NOTE_ID, kind: 'note', x: 100, y: 100, w: 200, h: 200 },
    { id: GEO_ID, kind: 'geo', x: 500, y: 100, w: 150, h: 80 },
  ],
  gesture: (_rng: Rng): GestureOp[] => [
    // Select-then-Enter begins editing (same sequence
    // enter-key-edit-preserves-text.ts proves is safe/non-mutating on its
    // own), then type LONG_TEXT and Escape out.
    { kind: 'down', at: { ref: 'shape', id: NOTE_ID } },
    { kind: 'up' },
    { kind: 'key', key: 'Enter' },
    ...typeText(LONG_TEXT),
    { kind: 'key', key: 'Escape' },
    { kind: 'down', at: { ref: 'shape', id: GEO_ID } },
    { kind: 'up' },
    { kind: 'key', key: 'Enter' },
    ...typeText(LONG_TEXT),
    { kind: 'key', key: 'Escape' },
  ],
  check: (obs: Obs): string | null => {
    const noteGrowY = obs.shapeStyle(NOTE_ID, 'growY')
    if (typeof noteGrowY !== 'number' || noteGrowY <= 0) {
      return `typing long text into note ${NOTE_ID} should grow its box via props.growY, got ${JSON.stringify(noteGrowY)}`
    }
    const geoGrowY = obs.shapeStyle(GEO_ID, 'growY')
    if (typeof geoGrowY !== 'number' || geoGrowY <= 0) {
      return `typing long text into geo ${GEO_ID} should grow its box via props.growY, got ${JSON.stringify(geoGrowY)}`
    }
    // Fixer round: growY > 0 alone doesn't prove growY is ENOUGH — a
    // systematically-too-small growY (e.g. measuring against the wrong box
    // model) still passes the two checks above while the rendered label
    // clips half its text. labelOverflow reads the actual static body the
    // user sees after Escape.
    if (obs.labelOverflow(NOTE_ID)) {
      return `note ${NOTE_ID}'s rendered label still overflows its box after growY was applied — text is clipped`
    }
    if (obs.labelOverflow(GEO_ID)) {
      return `geo ${GEO_ID}'s rendered label still overflows its box after growY was applied — text is clipped`
    }
    return null
  },
}
