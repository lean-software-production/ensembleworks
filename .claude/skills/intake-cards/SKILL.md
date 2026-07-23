---
name: intake-cards
description: Turn the room's voice transcript into INTAKE user-story cards on the EW Feedback & Roadmap page — listen for someone describing a want or a pain, distil it into "As a / I want to / So that", and place it as a geo card in the INTAKE frame. Use when asked to capture feature requests, write up what was just discussed as a story, or run intake for the roadmap.
---

# Skill: INTAKE cards

The **EW: Feedback & Roadmap** page is a left-to-right pipeline:

```
INTAKE  →  PRIORITISER  →  ROADMAP  →  RELEASE NOTES
```

Your job is the first box. People *talk* about what they want; you turn the
talk into a card in the **INTAKE** frame, written in the house format. Everything
downstream (the value/effort grid, the roadmap zones) is a human's call —
**never** move a card past INTAKE yourself.

You need the `ensembleworks` CLI on PATH (`ENSEMBLEWORKS_URL`,
`ENSEMBLEWORKS_ROOM` env as usual).

## The card format

Four lines, exactly:

```
ID: EW<n>, User: <who asked>
As a <role>
I want to <capability>
So that <benefit>
```

Rules that matter:

- **IDs are unique across the whole page**, not just INTAKE — cards migrate
  rightwards and keep their id. Always scan every frame before allocating.
- **`User:` is the person who asked**, from the transcript's `name` field — not
  you, not the room.
- **One want per card.** A single stretch of conversation often contains two or
  three; split them. See the worked example below.
- **"So that" is the benefit, not a restatement** of the want. If your So-that
  is just the I-want in other words, you haven't found the reason yet — keep
  reading the transcript.
- Keep the role concrete and drawn from how they described themselves
  ("product owner", "canvas A/V user", "terminal user"), not a generic "user".
- **Link the PR once one exists.** When a card's want has been implemented,
  append `, PR: #<n>` to the ID line and make `#<n>` a real link (see
  [Linking the implementation PR](#linking-the-implementation-pr)). The id
  stays put — the PR is the implementation, not a new id.

## Reading the room

```bash
ensembleworks scribe transcript --since $(( $(date +%s000) - 600000 ))   # last 10 min
```

Chain polls with the response's top-level `now` rather than your own clock.
Each entry carries `name`, `text`, and the `frame` the speaker's cursor was in —
frame context is a strong hint about what they're talking about.

Most of the transcript is **not** a feature request: greetings, tangents, tool
noise, thinking-aloud. Only cut a card when someone expresses a *want or a
pain* with a discernible beneficiary. When in doubt, draft it and ask before
writing.

## Before you write: read what's already there

```bash
ensembleworks canvas frames                     # the four frames + child counts
for f in INTAKE PRIORITISER ROADMAP "RELEASE NOTES"; do
  ensembleworks canvas frame "$f"
done
```

Two things you need from this:

1. **The highest `EW<n>` in use anywhere** → your next id is `n+1`.
2. **Whether the want is already carded.** Duplicates are worse than a missed
   card — a near-match means you should say so, not add a second card.

## Placing the card

Cards sit in a left-to-right row under the template card, so you need the row's
current geometry — and `canvas frame` deliberately doesn't give it, mapping each
drawing to `{id, type, text}` only (`server/src/features/frames.ts`). Use the v2
*read* endpoint, which does return bounds:

```bash
ensembleworks canvas-v2 frame INTAKE
```

**This is not the v2 canvas engine.** `/api/v2/canvas/*` is a read-only view that
converts the same legacy tldraw store on every request
(`server/src/features/canvas-v2.ts`); the engine swap is `/sync/v2/:roomId`
behind `EW_CANVAS_SYNC`, which this room does not run. Reading it changes
nothing and works regardless of that flag — but all **writes** below go through
the ordinary v1 `canvas shape` endpoint.

`ensembleworks canvas shape --frame INTAKE` takes **frame-local** `--x/--y`
(subtract the frame's page-space origin from the v2 bounds). The house card
style, matching the existing ones:

```bash
ensembleworks canvas shape --op create --type geo --frame INTAKE \
  --geo rectangle --color yellow --fill solid \
  --w 384 --h 202 --x <next-x> --y 229 \
  --text 'ID: EW7, User: David
As a product owner
I want the ROADMAP frame organised into now / next / later
So that I can see what is coming up when'
```

The current row sits at frame-local `y: 229`, `w: 384`, pitch **~427px** in x
(first card at `x: 43`). Put the next card at `maxX_of_last_card - frame_origin_x
+ 43`. If the row would overflow the frame's width, start a second row at
`y: 229 + 230`.

Humans rearrange these constantly — **always recompute from live bounds, never
from a remembered x**.

## Linking the implementation PR

Once a card's want ships as a PR, link it from the ID line. Two traps:

- **Markdown doesn't render.** `[#60](url)` shows as literal text — geo text is
  a tldraw (5.1.0) ProseMirror/TipTap `richText` doc, not markdown.
- **`--text` strips the link.** The `canvas shape --text` path runs through
  `toRichText()`, which flattens to plain paragraphs and drops every mark. You
  MUST write `--props` with a raw `richText` doc where the `#<n>` text node
  carries a `link` mark.

Copy the exact mark shape from an already-linked card (capture to a file — the
document can exceed a 64k pipe buffer):

```bash
ensembleworks canvas-v2 document > /tmp/doc.json
jq -c '.. | objects | select(.id?=="<shape-id>") | .props.richText' /tmp/doc.json
```

Then write it back — PR link on the ID line, one paragraph per card line — and
set `props.url` too (that adds the clickable link chip in the corner):

```bash
HREF=https://github.com/lean-software-production/ensembleworks/pull/60
PROPS=$(jq -nc --arg href "$HREF" '{
  url: $href,
  richText: {type:"doc",attrs:{dir:"auto"},content:[
    {type:"paragraph",attrs:{dir:"auto"},content:[
      {type:"text",text:"ID: EW2, User: David, PR: "},
      {type:"text",marks:[{type:"link",attrs:{href:$href,target:"_blank",rel:"noopener noreferrer nofollow",class:null,title:null}}],text:"#60"}
    ]},
    {type:"paragraph",attrs:{dir:"auto"},content:[{type:"text",text:"As a canvas A/V user"}]},
    {type:"paragraph",attrs:{dir:"auto"},content:[{type:"text",text:"I want to have noise canceling"}]},
    {type:"paragraph",attrs:{dir:"auto"},content:[{type:"text",text:"So that noisy backgrounds do not ruin the meeting"}]}
  ]}
}')
ensembleworks canvas shape --op update --id <shape-id> --props "$PROPS"
```

The `link` mark on the `#60` node is the whole trick — that is what the
WYSIWYG editor writes when you hand-make a link, and it round-trips through the
store the same way.

## Closing the loop

After writing, say what you added in the room:

```bash
ensembleworks canvas sticky "added EW7 + EW8 to INTAKE from the roadmap-organising discussion" \
  --frame advice --author intake
ensembleworks terminal status "$SESSION" done
```

## Worked example

This is the real conversation that motivated this skill — David, cursor in the
INTAKE frame, thinking aloud (transcript, lightly joined):

> "I think that one of the things that we want to ensure we have in the EW
> feedback and roadmap is some way of organizing the actual roadmap portion.
> And so I think this would be something that's kind of for the product owner,
> which is me, to have a good sense for the prioritization of what's coming up
> now, next and later. And for people who are using the EnsembleWorks tool, the
> students who are using it, for them to have a sense for where their feature
> request has been prioritized."

Note what the analysis has to do: the speaker names **two different roles**
with **two different benefits** from one capability. That's two cards, not one.

```
ID: EW7, User: David
As a product owner
I want the ROADMAP frame organised into now / next / later
So that I can see what is coming up when

ID: EW8, User: David
As an EnsembleWorks user
I want to see where my feature request has been prioritised
So that I know whether and when it will be picked up
```

What was deliberately *not* carded from the same five minutes: the toy-penguin
tangent, "can I come back to you in five minutes", and every "yeah". Silence is
the right output for most of the transcript.
