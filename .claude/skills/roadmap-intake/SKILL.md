---
name: roadmap-intake
description: Capture a want or pain from the room's voice transcript as an EW<n> user-story card in the INTAKE frame of the EW Feedback & Roadmap page. Use when asked to capture a feature request, write up what was just discussed as a story, or run intake. First skill of the roadmap-* collection — it only creates cards in INTAKE; prioritising and releasing are roadmap-prioritise / roadmap-release.
---

# Skill: roadmap-intake

The first box of the roadmap pipeline. People *talk* about what they want; you
turn the talk into a card in the **INTAKE** frame, in the house format. You do
**not** prioritise or move cards onward — that is `roadmap-prioritise` and
`roadmap-release`, invoked separately by a human.

Read [`docs/roadmap-pipeline.md`](../../../docs/roadmap-pipeline.md) first — the
card format, the `EW<n>` id rules, the frame map, and the board-reading commands
all live there and are assumed below.

You need the `ensembleworks` CLI on PATH (`ENSEMBLEWORKS_URL`,
`ENSEMBLEWORKS_ROOM` env as usual).

## 1. Read the room

```bash
ensembleworks scribe transcript --since $(( $(date +%s000) - 600000 ))   # last 10 min
```

Chain polls on the response's top-level `now`, not your own clock. Each entry
carries `name`, `text`, and the `frame` the speaker's cursor was in.

Most of the transcript is **not** a request — greetings, tangents, thinking
aloud. Cut a card only when someone voices a *want or a pain* with a discernible
beneficiary. **One want per card:** a single stretch often holds two or three;
split them. When in doubt, draft it and ask before writing. Silence is the right
output for most of any transcript.

## 2. Allocate the id

Scan the **whole page**, because cards keep their id as they migrate into
ROADMAP zones and release subframes — the highest `EW<n>` may not be in INTAKE:

```bash
ensembleworks canvas-v2 document > /tmp/board.json
grep -oE 'EW[0-9]+' /tmp/board.json | sort -t W -k2 -n | tail -1   # next id is n+1
```

Also check the want isn't **already carded** (in any frame). A near-duplicate
should be reported, not added — duplicates are worse than a missed card.

## 3. Place the card in INTAKE

Cards sit in a left-to-right grid. Read live bounds (never a remembered x —
humans rearrange constantly) and drop the new card in a free slot:

```bash
ensembleworks canvas-v2 frame INTAKE          # member bounds, to find the next free slot
ensembleworks canvas shape --op create --type geo --frame INTAKE \
  --geo rectangle --color yellow --fill solid \
  --w 384 --h 202 --x <next-x> --y <row-y> \
  --text 'ID: EW<n>, User: <who>
As a <role>
I want to <capability>
So that <benefit>'
```

`--x/--y` are **frame-local** (subtract INTAKE's page-space origin from the v2
bounds). If a row would overflow the frame width, start a new row lower down.

## 4. Close the loop

```bash
ensembleworks canvas sticky "added EW<n> to INTAKE from the <topic> discussion" \
  --frame ADVICE --author intake
ensembleworks terminal status "$SESSION" done
```

## Worked example

David, cursor in INTAKE, thinking aloud:

> "…for the product owner, which is me, to have a good sense for the
> prioritization of what's coming up now, next and later. And for people who are
> using the tool … for them to have a sense for where their feature request has
> been prioritized."

One capability, **two roles with two different benefits** → two cards:

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

Not carded from the same five minutes: a toy-penguin tangent, "can I come back
in five minutes", and every "yeah". Knowing what to throw away is most of the job.
