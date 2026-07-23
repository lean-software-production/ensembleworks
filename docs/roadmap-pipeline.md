# The EW roadmap pipeline (shared reference)

The three `roadmap-*` skills — [`roadmap-intake`](../.claude/skills/roadmap-intake/SKILL.md),
[`roadmap-prioritise`](../.claude/skills/roadmap-prioritise/SKILL.md), and
[`roadmap-release`](../.claude/skills/roadmap-release/SKILL.md) — all drive the
same board on the **EW: Feedback & Roadmap** canvas page. This file is the
conventions they share; each skill links here rather than repeating it.

## The flow

```
INTAKE ──►  ROADMAP ──►  RELEASE NOTES
 (want)     NOW│NEXT│LATER   RELEASE: vX.Y.Z
```

One card = one want. It is **created** in INTAKE, **prioritised** into a zone
inside ROADMAP, and, when it ships, **moved** into the matching release subframe.
Each hop is a deliberate, human-triggered act — the matching skill does the hop
only when a human invokes it. Nothing promotes itself.

- **`roadmap-intake`** creates cards in INTAKE. It never moves anything onward.
- **`roadmap-prioritise`** moves a card INTAKE → NOW / NEXT / LATER. A human
  names the zone; the skill just does the reparent + placement.
- **`roadmap-release`** moves a shipped card into `RELEASE: vX.Y.Z` and stamps
  its PR link.

> PRIORITISER is retired. The old value/effort grid frame was renamed `LATER`
> and folded into ROADMAP; prioritisation is now expressed purely as the
> NOW / NEXT / LATER zones.

## The frame structure (look it up, never hard-code)

Humans reorganise this board constantly (that is the whole point of it), so
resolve frames by **name** every time — never cache a shape id or a coordinate.

- **INTAKE** — a flat frame; cards are direct children.
- **ROADMAP** — a *container* frame. Cards live in its subframes **NOW**,
  **NEXT**, **LATER** — never as direct children of ROADMAP itself. (A v1
  `canvas frame ROADMAP` read returns zero children for exactly this reason.)
- **RELEASE NOTES** — a *container* frame holding one subframe per shipped
  release, named `RELEASE: vX.Y.Z`. Cards live in those.
- **EW:FOREMAN** — the agent area (a terminal, a file-viewer, and the
  **ADVICE** subframe where status stickies go). Not part of the card flow.

## The card format

```
ID: EW<n>, User: <who asked>
As a <role>
I want to <capability>
So that <benefit>
```

- **`EW<n>` ids are unique across the whole page**, not one frame — a card keeps
  its id as it migrates. Allocate the next id by scanning **everywhere** (see
  below), not just INTAKE.
- **`User:`** is the person who asked (the transcript `name`), never the agent.
- **"So that" is the benefit**, not a restatement of the want.
- Roles are concrete ("product owner", "canvas A/V user"), never a bare "user".

## Reading the board

Geometry and nesting come from the v2 *read* view, which returns bounds and
`parentId` and — crucially — descends into subframes. It is a read-only
projection of the same legacy tldraw store (not the v2 engine, which this room
does not run); **all writes still go through the v1 `canvas shape` endpoint.**

The document can exceed a 64k pipe buffer, so capture it to a file first:

```bash
ensembleworks canvas-v2 document > /tmp/board.json

# highest EW<n> in use anywhere → next id is n+1
grep -oE 'EW[0-9]+' /tmp/board.json | sort -t W -k2 -n | tail -1

# where every card currently sits (text → containing frame id)
jq -r '.. | objects
  | select((.props.richText|tostring? // "")|test("EW[0-9]"))
  | "\((.props.richText.content[0].content[0].text // "?")|.[0:24])\t\(.parentId)"' /tmp/board.json

# resolve a frame name → id (fuzzy is fine; exact wins)
jq -r '.. | objects | select(.kind=="frame") | "\(.props.name)\t\(.id)"' /tmp/board.json
```

## Moving a card between frames

Reparent by **frame name** — the write endpoint fuzzy-matches it:

```bash
ensembleworks canvas shape --op update --id <card-id> --frame "NOW"
```

`--frame` reparents INTO the frame and **preserves page position**, so the card
keeps its old screen location and may land visually outside the target. Always
follow up (or combine) with frame-local `--x/--y` placing it in a free slot —
read the target frame's members via `canvas-v2 frame "<name>"`, then drop the
card below the lowest existing one (subtract the frame's page-space origin to
get frame-local coordinates).

## Linking a card to its PR

Once a want ships, link the PR from the ID line: `ID: EW<n>, User: …, PR: #<k>`
where `#<k>` is a **real** link. Two traps:

- **Markdown doesn't render.** `[#61](url)` shows as literal text — geo text is
  a tldraw (5.1.0) ProseMirror/TipTap `richText` doc, not markdown.
- **`--text` strips the link.** That path runs through `toRichText()`, which
  flattens to plain paragraphs and drops every mark. The link MUST be written
  via `--props` as a raw `richText` doc whose `#<k>` text node carries a `link`
  mark. Also set `props.url` to the same PR (adds the corner link chip).

```bash
HREF=https://github.com/lean-software-production/ensembleworks/pull/60
PROPS=$(jq -nc --arg href "$HREF" '{
  url: $href,
  richText: {type:"doc",attrs:{dir:"auto"},content:[
    {type:"paragraph",attrs:{dir:"auto"},content:[
      {type:"text",text:"ID: EW2, User: David, PR: "},
      {type:"text",marks:[{type:"link",attrs:{href:$href,target:"_blank",rel:"noopener noreferrer nofollow",class:null,title:null}}],text:"#60"}
    ]},
    {type:"paragraph",attrs:{dir:"auto"},content:[{type:"text",text:"As a canvas A/V user"}]}
  ]}
}')
ensembleworks canvas shape --op update --id <card-id> --props "$PROPS"
```

The `link` mark on the `#60` node is exactly what the WYSIWYG editor writes when
you hand-make a link; copy the shape verbatim from an already-linked card.

## Gotchas worth remembering

- **Renaming a frame:** `--name` silently no-ops on `--op update`. Rename via the
  raw merge instead: `canvas shape --op update --id <frame> --props '{"name":"NOW"}'`.
- **Closing the loop:** post a short sticky to the **ADVICE** frame
  (`--frame ADVICE --author <skill>`) and set your status light
  (`ensembleworks terminal status "$SESSION" done`).
