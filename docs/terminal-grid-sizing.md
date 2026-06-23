# Multi-user terminal sizing

How the canvas terminals decide their grid size (`cols × rows`) when several
people are looking at the same terminal at once, what goes wrong if you do it the
obvious way, and how the current code avoids those problems.

## Why this is hard

A canvas terminal is a tldraw shape whose bytes come from a single `tmux` session
on a VM. The terminal gateway (`server/src/terminal-gateway.ts`) holds **one**
tmux client per session and fans its output out to every attached browser, so all
viewers see identical bytes. That sharing is the whole point — it's how two people
can watch the same `claude code` run — but it has a sharp consequence for sizing:

> A PTY has exactly **one** size. Every viewer of a terminal shares that one
> `cols × rows` grid. There is no per-viewer terminal size.

So "how big is this terminal?" is **global, shared state**. Any client that
changes it changes it for *everyone* watching. That turns a normally-trivial UI
concern (fit the text to the box) into a small distributed-systems problem.

It's made harder by the fact that the grid is **integers** derived from
**pixels**. Turning a shape's pixel box into `cols × rows` means
`floor(box / cell)` over the font's cell metrics — and those pixel measurements
differ subtly between clients for reasons that have nothing to do with intent:

- **Canvas zoom.** tldraw scales every shape by the camera zoom; a viewer zoomed
  to 150% measures a different pixel box than one at 100%.
- **Web-font load timing.** The terminal font (JetBrains Mono) loads async; a
  client that measures before it swaps in gets a slightly different cell.
- **Off-screen culling.** tldraw hides off-screen shapes with `display:none`, so
  a terminal scrolled out of view measures **0 × 0**.
- **Device pixel ratio / OS font rendering.** Sub-pixel differences in how a glyph
  is rasterised vary by machine.

## The failure modes

The obvious design is: *each client measures its own box, proposes a
`cols × rows` to the gateway, the gateway accepts it and broadcasts it to
everyone.* This is "agreement by election" — somebody proposes, the others adopt
— and it fails in proportion to how much the per-client measurements above
disagree. Two concrete bugs this produced:

- **Scroll a terminal off-screen and it collapses to a tiny block for everyone.**
  The culled shape measured `0 × 0`, proposed a degenerate grid, and the gateway
  clamped it to its floor (`20 × 5`) and broadcast *that* to every viewer.

- **Scroll a terminal *into* view and its owner loses a couple of lines.**
  Un-culling re-triggered a measurement; the viewer's rounding differed from the
  owner's by a row or two, and being the last to propose, it shrank the terminal
  for the person actually working in it.

Both are instances of one root problem: **last-writer-wins over a grid sourced
from a live, per-client pixel measurement.** Whoever measured last — under
whatever transient zoom / font / layout conditions they happened to be in —
defined the grid for everybody. Narrowing *who* is allowed to propose (e.g. only
the person interacting) shrinks the blast radius but doesn't remove the race:
two people interacting still measure differently and still fight.

## How the current code solves it: a deterministic grid

The terminal grid is **not measured-then-proposed**. It is **computed**, the same
way, on every client — "agreement by computation." The grid is a pure function of
inputs that are identical everywhere:

```
cols = floor((w - PAD.x) / cell.w)   // clamped to a minimum
rows = floor((h - PAD.y) / cell.h)
```

(`client/src/terminal/grid.ts`, `gridFor()`.) The inputs:

| input | why it's the same on every client |
| --- | --- |
| `w`, `h` (the shape's logical box) | tldraw-synced shape props, conflict-resolved by the canvas's sync layer |
| `PAD` (container padding, scrollbar) | constants in the code |
| `cell` (base-font cell size, CSS px) | fixed by font-family + base font size; the one *measured* input — see below |

Because the inputs are identical, every viewer derives the **same** `cols × rows`
for a given box. There is no proposer to race. Each client applies the grid
locally **and** echoes it to the gateway, but since the value is identical
everywhere those echoes cannot conflict — the gateway dedups identical sizes
(`resizeSession()` is a no-op when nothing changed), so redundant echoes from
other viewers are harmless. The gateway stays **authoritative** for the actual
tmux PTY size and is the boot value / convergence point that a newly-attached
client adopts.

The payoff is that the transient, per-client conditions that used to corrupt the
grid — zoom, font-load timing, culling, DPI — **can no longer affect the value**,
because the value isn't read from the rendered DOM at all. Scrolling, culling, or
zooming a terminal you're merely watching cannot resize it for anyone, by
construction rather than by a guard.

### The one measured input, and why it's safe

`cell` — the width/height of one character cell at the base font — is the only
input that must be measured rather than shared (it depends on the loaded font and
the browser's text rendering). It is measured once the web font is ready and then
**quantised to 0.1 px** (`quantizeCell()`):

> Real-world cross-browser spread in the measured cell is well under 0.05 px, so
> rounding to a 0.1 px grid lands every client on the same value — which is what
> keeps two viewers from computing grids that differ by a row.

The trade-off: the cell used can be up to ~0.05 px off "true", so the last
column/row can sit a hair off a perfect fit — but **identically on every client**,
so it never causes a resize. If a genuinely different OS / DPI combination ever
disagrees by a whole row, the bulletproof escalation is to **snap the shape's
`w/h` to whole multiples of the cell on resize**, which makes the division exact
and removes quantisation ambiguity entirely (at the cost of stepped, rather than
smooth, resize handles).

## Zoom and selection are kept orthogonal

Zoom is a **view** operation and is deliberately decoupled from the grid:

- The grid is derived from the shape's **logical** `w/h`, not the zoomed pixel
  box, so it is zoom-invariant — two differently-zoomed viewers compute the same
  grid.
- To keep text crisp and, crucially, to keep **mouse → cell mapping exact** (so a
  drag-selection lands on the row under the cursor), the terminal renders into an
  inner host that is counter-scaled by `1/zoom` while the font is scaled by
  `zoom`. The net on-screen scale is 1, so xterm's selection math is correct at
  any zoom. Setting `fontSize` makes xterm re-measure its cell on
  activation/zoom; that re-measure is what keeps selection accurate.

Because the grid no longer depends on the zoomed measurement, the selection
counter-scale and the grid computation don't interfere — earlier versions had to
re-fit on zoom, which re-introduced per-zoom rounding fights.

## Where this lives

- `client/src/terminal/grid.ts` — `gridFor()`, `quantizeCell()`, the padding and
  minimum constants. Pure, no DOM. Covered by `grid.test.ts` (dependency-free;
  `npx tsx src/terminal/grid.test.ts`).
- `client/src/terminal/TerminalShapeUtil.tsx` — measures the cell once the font
  loads, computes the grid from the shape's `w/h` in a small effect, and holds the
  zoom/selection counter-scale.
- `server/src/terminal-gateway.ts` — authoritative PTY size: clamps to sane
  bounds, dedups identical sizes, and fans the size out to every viewer.

## Invariants to preserve

If you change the terminal sizing code, keep these true — each one is load-bearing
for the multi-user case:

1. **Never broadcast a grid derived from a live, per-client pixel measurement.**
   That is the proposal/last-writer-wins model and it reintroduces the race.
2. **Keep the grid a pure function of shared state + the quantised cell.** Same
   inputs must give the same `cols × rows` on every client.
3. **Keep zoom/selection geometry separate from grid sizing.** The counter-scale
   (host `scale(1/zoom)` + `fontSize = base × zoom`) is about cursor accuracy, not
   about how many cells fit.
4. **The gateway stays authoritative and dedups identical sizes**, so redundant
   echoes are no-ops and a freshly-attached client has one size to adopt.
