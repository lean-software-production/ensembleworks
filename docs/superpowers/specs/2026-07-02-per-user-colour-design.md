# Per-user colour identity — design

**Date:** 2026-07-02
**Status:** Approved, ready for implementation plan

## Goal

Give every canvas user a coherent **colour identity**, and default the things they
create on the canvas to that colour, so ownership reads at a glance. Their cursor,
faces-rail ring, stickies, and screenshare-tile border should all be *the same*
colour.

## Background — what exists today

- `client/src/identity.ts` is the single source of user identity: `getIdentity()`
  returns `{ id, name, color }`. `color` is derived deterministically by hashing
  `id` against a fixed **arbitrary-hex** 6-colour palette. It is not user-chosen
  and not persisted.
- That colour is already fed into tldraw presence (`setUserPreferences` in
  `App.tsx`), so it drives native cursors, the faces-rail rings, speaker leashes,
  and roster dots (`AvOverlay.tsx`).
- **None of a user's creations inherit it.** Screenshare tiles
  (`screenshare/ScreenShareShapeUtil.tsx`), the terminal/iframe/neko frames, and
  native stickies all style from the shared `wm.*` theme or tldraw's own default.
- **Palette mismatch:** identity colours are arbitrary hex (`#4f8fef`), but
  tldraw's *native* shapes (stickies, geo) use a **named enum** palette (`blue`,
  `green`, `violet`…). "Border on a custom shape" (any hex) and "fill on a native
  sticky" (needs a named colour) are two different integration paths.

## Decisions

1. **Palette:** Align the identity palette to tldraw's *named* colours (resolves
   the mismatch — a user's cursor, ring, sticky, and screenshare border are all
   literally the same colour).
2. **Assignment:** Deterministic hashed default, with a **personal override**
   persisted in `localStorage` (no server coordination; collisions possible but
   self-correctable).
3. **Scope:** Stickies + all native shapes (default colour) + screenshare-tile
   border. **Deferred:** terminal / iframe / neko frames (tool chrome, not
   "something I made").
4. **Override UI:** A small colour-swatch picker (click your own face in the
   faces rail → popover of palette swatches).

## Design

### 1. Colour model (`client/src/identity.ts`)

Flip the source of truth from arbitrary hex to a **named tldraw colour key**.

- `IDENTITY_COLORS` = the "colourful" subset of tldraw's `DefaultColorStyle`
  palette: `blue, light-blue, green, light-green, violet, light-violet, orange,
  yellow, red, light-red` (10 keys; drop `black`/`grey`).
- `getIdentity()` returns `{ id, name, colorKey }`.
- **Resolution — override wins, else hash:** read
  `localStorage["ensembleworks.userColor"]`; if it is a valid key, use it;
  otherwise `IDENTITY_COLORS[hashCode(id) % IDENTITY_COLORS.length]` (same hashing
  as today, over the new list).
- `hexForColor(colorKey, isDark)` maps a key → its theme hex via tldraw's
  `getDefaultColorTheme(...)[colorKey].solid`. This is the single hex handed to
  presence, so a user's cursor/ring hex visually matches their sticky fill.
- `setUserColor(key)` persists the override under
  `localStorage["ensembleworks.userColor"]`.

`peekIdentity()` (non-prompting reader) keeps working, now surfacing `colorKey`.

### 2. Native shapes default to your colour

- On `editor` mount (`App.tsx` `onMount`, next to the existing
  `updateUserPreferences` call): `editor.setStyleForNextShapes(DefaultColorStyle,
  colorKey)`. The next sticky/geo/arrow/draw/text the user creates starts in their
  colour. It is a *default*, not a lock — tldraw's style panel still overrides per
  shape.
- Re-applied whenever the user changes their colour (§4), so the default tracks
  their current identity.
- Imperative note-creation sites that hard-code colours (`demo.ts`,
  `seedSessionCanvas.ts`) are left as-is *except* where a note represents "a
  user's" sticky; seed/system scaffolding colours stay. (Flagged so nothing
  changes silently — the plan should enumerate exactly which call sites, if any,
  change.)

### 3. Screenshare tile border (custom shape — needs server schema mirror)

- Add prop `ownerColor: string` (a hex) to `ScreenShareShapeUtil` `props` +
  `getDefaultProps` (default `""`), and **mirror it in `server/src/schema.ts`**.
- Keep it optional with an empty-string default + a render fallback, so existing
  persisted tiles that lack the prop still render (border falls back to today's
  `wm.ruleStrong`) — **no hard data migration required**. The plan follows
  whatever prop pattern the existing custom shapes already use.
- Stamp it at creation in `screenshare/share.ts`: read the local user's
  `hexForColor(colorKey, isDark)` and pass into `createShape`.
- In `component()`, swap the hard-coded outer frame `border: 1px solid
  ${wm.ruleStrong}` for `2px solid ${ownerColor || wm.ruleStrong}` — a slightly
  thicker coloured accent. Header bar and status dot stay theme-driven.
- **Captured at creation:** if the sharer later changes colour, existing tiles
  keep the colour they were made with (matches stickies; avoids reactive
  recolouring).

### 4. Swatch picker + change propagation

- **UI:** the faces rail (`AvOverlay.tsx`) already renders the local user with a
  coloured ring. Clicking **your own face** opens a small popover: a grid of the
  10 palette swatches, current one marked, click to choose. Local popover state
  only — no new menu plumbing or settings surface.
- **On `setUserColor(key)`, three things fan out:**
  1. **Persist** — `localStorage["ensembleworks.userColor"] = key`.
  2. **Presence** — `editor.user.updateUserPreferences({ color: hexForColor(key,
     isDark) })`. Cursor, faces-rail ring, speaker leashes, and roster dot update
     reactively for free.
  3. **Next-shape default** — `editor.setStyleForNextShapes(DefaultColorStyle,
     key)`.
- Newly created stickies and screenshares pick up the new colour; **existing
  shapes are unchanged.** One control governs the whole identity.

## Testing

- **Unit (`identity.ts`):** deterministic hash stable for a given id; override
  precedence over hash; `setUserColor` → `getIdentity().colorKey` round-trips
  through `localStorage`; every `IDENTITY_COLORS` key resolves to a valid hex via
  `hexForColor` in both light and dark themes.
- **Typecheck/build across all three workspaces** (the server-schema change must
  compile): `npm run typecheck && npm run build`.
- **Manual smoke** (canvas interactions are hard to unit-test): create a sticky →
  it's your colour; start a screenshare → tile border is your colour; open the
  picker, change colour → cursor/ring/roster update immediately and your next
  sticky uses the new colour while existing shapes keep theirs; reload → override
  persists.

## Out of scope / deferred

- Terminal / iframe / neko custom-shape frame borders.
- Room-aware unique-colour assignment (collisions are self-correctable via the
  picker).
- Reactive recolouring of existing shapes when a user changes colour.
