---
name: roadmap-prioritise
description: Move an existing EW<n> card into a priority zone — NOW, NEXT, or LATER — inside the ROADMAP container on the EW Feedback & Roadmap page. Use when a human decides where a captured want belongs on the roadmap ("put EW7 in NOW", "move that to LATER"). Mechanical reparent + placement only; the human names the zone, this skill never invents the priority.
---

# Skill: roadmap-prioritise

The second box of the roadmap pipeline: take a card that already exists (usually
in INTAKE) and move it into one of ROADMAP's three zones — **NOW**, **NEXT**, or
**LATER**. Prioritisation is a **human judgement**: they tell you the zone, you
do the reparent and tidy placement. Never pick the zone yourself.

Read [`docs/roadmap-pipeline.md`](../../../docs/roadmap-pipeline.md) first — the
frame map (ROADMAP is a container; cards live in the NOW/NEXT/LATER subframes,
never in ROADMAP directly) and the move mechanics live there.

## 1. Resolve the card and the target zone

You are given a card (an `EW<n>` or a shape id) and a zone name.

```bash
ensembleworks canvas-v2 document > /tmp/board.json
# card id from its EW number:
jq -r '.. | objects | select((.props.richText|tostring? // "")|test("ID: EW7\\b")) | .id' /tmp/board.json
# confirm the zone exists (NOW / NEXT / LATER are subframes of ROADMAP):
jq -r '.. | objects | select(.kind=="frame" and (.props.name|IN("NOW","NEXT","LATER"))) | "\(.props.name)\t\(.id)"' /tmp/board.json
```

If the named zone doesn't exist, **stop and report** — don't guess or create a
new zone. The three zones are fixed; only a human restructures ROADMAP.

## 2. Move it in

Reparent by zone name (fuzzy match is fine), then place it in a free slot so it
doesn't land on top of another card. `--frame` preserves page position, so you
must set frame-local `--x/--y` too:

```bash
ensembleworks canvas-v2 frame "NOW"     # read members → find the lowest occupied y
ensembleworks canvas shape --op update --id <card-id> --frame "NOW" \
  --x <free-x> --y <free-y>
```

`--x/--y` are frame-local (subtract the zone frame's page-space origin). Drop the
card below the lowest existing member, or in the first empty grid cell.

## 3. Close the loop

```bash
ensembleworks canvas sticky "moved EW7 to NOW" --frame ADVICE --author prioritise
ensembleworks terminal status "$SESSION" done
```

## Notes

- **One card at a time, one zone.** If asked to move several, resolve and place
  each — don't batch-guess positions.
- This skill does **not** touch release subframes. A shipped card goes to
  RELEASE NOTES via `roadmap-release`, not here.
- If the human's instruction is ambiguous about which card or which zone, ask —
  a mis-prioritised card is a real signal to the room, so don't guess.
