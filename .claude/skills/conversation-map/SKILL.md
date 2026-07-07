---
name: conversation-map
description: Diagram the structure of the live conversation on the EnsembleWorks — poll the voice transcript and maintain a dialogue map (topics, ideas, pros/cons, links) as real tldraw shapes that humans can rearrange. Use when asked to map the discussion, diagram the conversation, or run a live dialogue map.
---

# Skill: Conversation map

Turn the room's voice transcript into a **live diagram** of the discussion:
what questions are on the table, which ideas answer them, what supports or
undercuts each idea. The map is made of real canvas shapes, so humans can
drag nodes around, and arrows follow — you maintain *structure*, they own
*layout*.

You need the `ensembleworks` CLI on PATH (`ENSEMBLEWORKS_URL`,
`ENSEMBLEWORKS_ROOM` env as usual).

## The vocabulary (IBIS, loosely)

| Node | Shape | Colour |
|---|---|---|
| Question / topic | `geo` rectangle | `violet` |
| Idea / proposal | `geo` ellipse | `blue` |
| Pro / support | `note` | `green` |
| Con / risk | `note` | `light-red` |
| Decision | `geo` rectangle | `green`, label prefixed `✓` |

Links are arrows: idea → the question it answers, pro/con → the idea it
weighs on, decision → the question it closes.

```bash
# nodes — the response carries the shape id; SAVE IT
ensembleworks canvas shape '{"type":"geo","geo":"rectangle","color":"violet","x":80,"y":80,"w":260,"h":90,"text":"How do we stop the retry storm?","frame":"map"}'
ensembleworks canvas shape '{"type":"geo","geo":"ellipse","color":"blue","x":420,"y":60,"text":"exponential backoff"}'
# links — bound at both ends, so they follow when humans drag nodes
ensembleworks canvas shape '{"type":"arrow","fromId":"shape:<idea>","toId":"shape:<question>"}'
# evolve — relabel, recolour, promote an idea to a decision
ensembleworks canvas shape '{"op":"update","id":"shape:<idea>","text":"✓ exponential backoff + jitter","color":"green"}'
ensembleworks canvas shape '{"op":"delete","id":"shape:<dead-end>"}'
```

## The loop

1. **Set up once.** `ensembleworks canvas frames` — use a frame whose name
   contains `map` (ask a human to draw one, or place nodes on open canvas near
   the talkers' cursors). Keep a registry file (e.g. `map-registry.json`) of
   `node text → shape id` so you update nodes instead of duplicating them.
2. **Poll.** `ensembleworks scribe transcript --since <last now>` every
   ~60–90s; save the returned `now` for the next poll.
3. **Segment into threads.** Entries whose `frame.name` matches (or whose
   cursors are within ~600 page units — the huddle radius) belong to one
   conversation; parallel huddles are parallel threads. Don't merge them.
4. **Extract structure, not transcript.** From each thread's new utterances:
   - a question worth mapping ("how should we…", "what if…") → question node
   - a proposal → idea node, arrow to its question
   - support/objection → green/red note, arrow to its idea
   - convergence ("ok let's do that") → recolour the idea green, `✓` prefix
   Map turning points, not every sentence. A 10-minute debate might be one
   question, three ideas, four notes.
5. **Place sanely.** Question nodes in a column (x≈80, y step ≈260); ideas to
   the right of their question; pros/cons to the right of their idea. Offset
   each new node so nothing stacks. Humans will rearrange — that's fine,
   bound arrows survive; **never "tidy" positions of nodes you already
   created**, you'd fight the humans.
6. **Decisions feed the record.** When a thread closes with a decision, also
   post it as a sticky:
   `ensembleworks canvas sticky "✓ <decision>" --frame map --author mapper --color light-blue`
   (the minutes scribe, if one is running, will pick it up too).

## Judgement calls

- STT mangles words; `ensembleworks canvas frame <frame the speakers were in>`
  shows the stickies/code they were discussing — use it to decode jargon before
  labelling a node wrongly.
- If the conversation outgrows the frame, grow the map rightwards, not
  denser; legibility-at-a-glance is the whole point.
- When in doubt whether something was a decision or a musing, make it an
  idea node — a human will promote it by recolouring, or ask you to.
