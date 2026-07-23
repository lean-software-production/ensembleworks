# Locked-shape affordance — design

- **Status:** SPEC (agreed 2026-07-23). Implementation plan follows separately
  (superpowers:writing-plans).
- **Date:** 2026-07-23
- **Motivation:** A locked shape is currently **completely indistinguishable from
  an unlocked one** and silently ignores every interaction. This has already cost
  a live session.
- **Companion docs:**
  - [`2026-07-22-tldraw-5.2-upgrade-design.md`](./2026-07-22-tldraw-5.2-upgrade-design.md)
    — related but **not** a prerequisite (see §7)
  - canvas-v2 parity: §8

---

## 1. Motivation — the incident

During a live session, a participant (Petre Barna) reported being unable to type
into his terminal. Triage found the terminal *visible and apparently normal*, but
no double-click would enter edit mode. The cause: **that one shape had
`isLocked: true`** — the only locked shape among 27 terminals on the canvas.

Three things combined to make this take an hour to diagnose:

1. **tldraw ships no locked-shape visual at all.** Verified: there is no
   `tl-locked` CSS class anywhere in the `tldraw` 5.1.0 package. A locked shape
   renders identically to an unlocked one.
2. **Locked shapes are dropped from hit-testing**, so clicking and double-clicking
   do *nothing at all* — not an error, not a cursor change, nothing.
3. For terminals specifically, the body only accepts pointer/keyboard input while
   in edit mode (`client/src/terminal/TerminalShapeUtil.tsx:715`,
   `pointerEvents: isEditing ? 'all' : 'none'`), so a shape that can't enter edit
   mode is inert.

Locking is a **wanted feature** and is user-triggered — tldraw's **Cmd+Shift+L**,
or right-click → Lock. No app code sets `isLocked` on the live v1 path (the only
`isLocked` writes are the *camera* lock in `chrome/focus.ts` and a canvas-v2 REST
endpoint at `server/src/features/shape.ts:227`). Nothing is broken. **The gap is
purely that locking is invisible.**

## 2. Goal and scope

Make "this shape is locked" **discoverable at the moment of confusion** — when a
user points at or selects a shape that isn't responding.

- **All shape types**, uniformly — not a per-shape-util treatment. Terminals,
  frames, text, arrows, draw strokes.
- **No permanent visual change.** A locked shape at rest looks exactly like an
  unlocked one.
- **Informational only.** Not a control — see §6.

## 3. The design

A **padlock chip** appears pinned just outside the **top-right** of the shape's
bounds, whenever that shape is **hovered *or* selected** and is locked.

```
     ┌──────────────────────┐ [🔒]
     │  $ npm test          │
     │  ok 12 passed        │
     └──────────────────────┘
```

**Why hover *or* selection, not hover alone.** Enabling `selectLockedShapes` (§4)
means clicking a locked shape now *selects* it, and tldraw draws its standard
selection indicator — a visible state we don't control. Without the selection
trigger, a user who clicks a locked shape and then moves the pointer away is left
staring at a selected shape that won't respond, with no explanation. Same badge,
one extra condition.

**Why top-right.** The terminal shape's own title chip is pinned top-**left**
(`TerminalShapeUtil.tsx:736-751`, `left: 0; bottom: 100%`), so a top-right badge
cannot collide with it. It also reuses that chip's visual language.

**Design decisions considered and rejected:**

| rejected | why |
|---|---|
| Always-on visual (dashed border / permanent badge) | With 27 terminals and 30 frames on a real canvas, permanent decoration of a rare state becomes wallpaper. |
| Corner fold / dog-ear | Assumes a rectangular area; an arrow or draw stroke has no corner, and its bounding-box corner sits nowhere near the shape. |
| Dim / reduced opacity | Overloads opacity, which is already a real tldraw style channel — a genuinely faded shape and a locked shape become indistinguishable. Also reads as "loading". |
| Centred "🔒 LOCKED" pill | Clearest, but occludes content and doesn't fit small shapes. |
| Cursor-attached padlock | Precise, but adds moving UI to a canvas that already has collaborator cursors in motion. |

## 4. Hard prerequisite — `selectLockedShapes: true`

**This is not optional. Without it the feature cannot work at all.**

Locked shapes are excluded from hover hit-testing by default. Verified in the
tldraw source shipped in `node_modules`:

| file | what it shows |
|---|---|
| `tldraw/src/lib/tools/selection-logic/updateHoveredShapeId.ts:28` | hover calls `getShapeAtPoint(..., { hitLocked: editor.options.selectLockedShapes })` |
| `@tldraw/editor/src/lib/editor/Editor.ts:5808` | `(shape.isLocked && !hitLocked)` ⇒ shape filtered out |
| `@tldraw/editor/src/lib/options.ts:345` | `selectLockedShapes: false` — the default |

So with defaults, **`editor.getHoveredShapeId()` can never return a locked shape**
and the badge would silently never render.

Set it via the `options` prop on `<Tldraw>` in `client/src/App.tsx`.

**Accepted side effects** (agreed, not incidental):

- Locked shapes become **click-selectable** and are **included in marquee/scribble
  selections** (`tldraw/src/lib/tools/SelectTool/childStates/ScribbleBrushing.js:107`
  gates on the same flag). They remain protected from edits, moves and deletes.
- This is a **net win**: it is what ends the silent-dead-shape problem. A click now
  produces visible feedback instead of nothing.

**Known limitation:** hover is maintained only in the select tool and the text tool
(`SelectTool/childStates/Idle.ts:49,62`, `EditingShape.ts:48,98,228`,
`shapes/text/toolStates/Idle.ts:15`, `defaultSideEffects.ts:13`). With a draw or
arrow tool armed, hovering a locked shape will not surface the badge. Accepted —
users are in the select tool essentially all the time, and the selection trigger
covers the rest.

## 5. Wiring

**A single React badge — not a canvas overlay util.**

Because only one shape is hovered at a time, and selection is typically small, this
needs one DOM element, not a per-shape canvas decoration. That is markedly simpler
than the overlay-util approach originally considered.

It mounts in the existing **`InFrontOfTheCanvas`** slot, which is already a
composition point in `client/src/ui.tsx:36` (currently `ContextualStylePanel` +
`FocusOverlay`). The badge becomes a third sibling.

```
client/src/chrome/LockedShapeBadge.tsx   (new)
client/src/ui.tsx                        (add <LockedShapeBadge /> to the fragment)
client/src/App.tsx                       (add options={{ selectLockedShapes: true }})
```

**Behaviour:**

1. Reactively read `editor.getHoveredShapeId()` and `editor.getSelectedShapeIds()`
   (via `useValue`, as the codebase does elsewhere).
2. Resolve the set of **locked** shapes among them. Prefer
   `editor.isShapeOrAncestorLocked(shape)` over a bare `isLocked` check, so a shape
   inside a **locked frame** is also reported — a locked frame makes its children
   non-interactive too, and that was a live hypothesis during the incident.
3. For each, compute viewport position from `editor.getShapePageBounds(id)` mapped
   through `editor.pageToViewport(...)` — the same technique as
   `client/src/av/leashes.tsx:49`.
4. Render the chip at the top-right of those bounds.

**No cap — badge every locked shape in the hovered/selected set.**

An earlier draft capped the badge count to avoid a select-all lighting up dozens of
padlocks. That was wrong, for two reasons:

1. **A cap lies.** Showing 3 badges across 10 locked selected shapes reads as
   "3 of these are locked". Partial information about a set is worse than none.
2. **The wallpaper objection doesn't transfer.** It applies to always-on decoration
   of a canvas *at rest* (§3) — unrequested noise. Selection is transient and
   user-initiated: the badges are answering a question the user just asked by
   selecting. Rendering a few dozen small DOM nodes is not a performance concern.

So: every locked shape in the hovered/selected set gets a badge, with no ordering
rule or truncation needed.

**Possible follow-up, deliberately not specified here:** when zoomed far out, badges
may become illegible or overlap. If that proves ugly in practice, the fix is to
suppress badges whose shape bounds fall below a legibility threshold — a rule
grounded in "this badge is too small to read" rather than an arbitrary count. Not
built until observed; YAGNI.

## 6. Not a control

The badge is **informational only** — not clickable, no unlock button.

Right-click → **Unlock** already works and is how the live incident was actually
resolved. Adding an unlock control to the badge would mean hit-testing, hover
states, and a click target competing with the canvas — significant complexity for
a path that already exists and is discoverable once the user knows the shape is
locked. **Telling them it's locked is the whole problem.**

## 7. Relationship to the tldraw 5.2 upgrade

**None — this does not depend on it.** The upgrade spec
([`2026-07-22-tldraw-5.2-upgrade-design.md`](./2026-07-22-tldraw-5.2-upgrade-design.md))
was originally written to unblock this feature, on the assumption it needed
`ShapeIndicatorOverlayUtil` (not re-exported from `tldraw` in 5.1.0). The hover-only
single-badge design removes that need entirely. `selectLockedShapes` already exists
in **5.1.0**. This feature can ship on the current version, and the upgrade is now
maintenance-only.

## 8. canvas-v2 parity

The live engine is **tldraw-v1** (`client/src/App.tsx`); canvas-v2 (`CanvasV2App`)
has its own sync layer and shape stack. This design targets v1.

When canvas-v2 becomes the live engine it must reproduce: the `selectLockedShapes`
equivalent in its own hit-testing, and the hover/selection badge. Tracked by (a)
this section and (b) a `// TODO(canvas-v2 locked-shape-affordance)` marker to be
added in `CanvasV2App.tsx` at implementation time — mirroring how
`docs/plans/2026-07-22-connection-health-modal-design.md` §7 handles the same
problem.

## 9. Testing

- **Pure unit test** — the decision function: given hovered id, selected ids, and a
  lock-state lookup, return the set of shapes that should show a badge. Cases:
  hovered-and-locked; hovered-and-unlocked (none); selected-and-locked; a mix of
  locked and unlocked in one selection (only the locked ones); a shape whose
  *ancestor frame* is locked (included); hovered shape also selected (no duplicate
  badge). Plain `.test.ts` with `node:assert/strict`, auto-discovered by
  `bun scripts/run-tests.ts`.
- **Positioning** is thin glue over existing tldraw APIs; covered by manual smoke.
- **Manual smoke:** lock a terminal → it looks unchanged at rest; hover → badge;
  move away → gone; click → selects, badge persists; lock a *frame* → hovering a
  child shows the badge; verify on an arrow and a draw stroke; select-all → every
  locked shape badges, and judge whether that is actually unpleasant when zoomed
  out (this is what would motivate the §5 legibility follow-up).
- **Regression:** confirm `selectLockedShapes: true` has not made locked shapes
  editable, movable or deletable.

## 10. Non-goals

- **Not** changing lock semantics, or who can lock/unlock.
- **Not** an unlock control (§6).
- **Not** a facilitator "unlock all" tool — plausible follow-up, out of scope here.
- **Not** canvas-v2 (§8).
- **Not** the tldraw 5.2 upgrade (§7).
- **No server changes.**
