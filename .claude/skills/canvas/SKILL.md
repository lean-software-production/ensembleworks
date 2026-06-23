---
name: canvas
description: Read and write the shared EnsembleWorks from a canvas terminal — see the stickies, text and images teammates have placed in a frame, then post a status light and a summary sticky back. Use whenever you are working in a canvas terminal and want to take instructions from, or report progress to, the humans watching the canvas.
---

# Skill: Canvas

You are running in a terminal that lives **on a shared multiplayer canvas**. The
humans on the canvas drop stickies, notes and reference images into named
frames; you can both **read** those and **write** back. Close the loop — don't
work blind, and don't finish silently.

The `canvas` CLI (`bin/canvas`, usually on `PATH`) is your whole interface. It
talks to the sync server over HTTP, so it works whether or not a browser is
open. Two env vars target it: `CANVAS_URL` (default `http://localhost:8788`)
and `CANVAS_ROOM` (default `team`).

Your terminal's **session id is shown in its title bar** (`tmux: canvas-<id>`)
and, in a seeded session, it equals your **crew name** (e.g. `crew-a`). Your
crew has its own frames: a *drafting table* (your instructions) and an *advice*
frame (where your summaries go).

## Reading the canvas

```bash
canvas frames                 # discover: every frame + child counts (JSON)
canvas read <frame>           # one frame's stickies, text, images, embeds (JSON)
canvas pull-images <frame> [dir]   # download the frame's images; prints local paths
```

`<frame>` matches the first frame whose name *contains* it, case-insensitively
(`drafting` matches `Drafting — crew-a`). `read` returns plain text recovered
from each sticky, plus `/uploads/...` urls for images. To actually **see** an
image, run `pull-images` and then open the printed path with your file-reading
tool — you read images natively.

**Proximity ordering.** When a teammate has a canvas tab open, `read` and
`frames` return results **nearest-their-cursor-first**, each item tagged with a
`dist` (page units), and a top-level `sortedBy: { userName, cursor }`. So the
sticky a human is hovering over is `notes[0]` — that's usually the one they
want you to look at *right now*. When nobody is connected, `sortedBy` is `null`
and you get plain document order. Mention the `sortedBy` user when you act on
the top item ("picking up the note David's cursor is on").

## Writing to the canvas

```bash
canvas status <session-id> <working|needs-you|done|idle>   # light on your terminal
canvas sticky <text> --frame <name> --author <crew> [--color <c>]
```

`--author` tags the note `🤖 <crew>: …` and colours it light-blue, so humans
can tell your stickies from their own at a glance. Always pass it.

## The loop

1. **Look before you act.** `canvas read <your-crew>` (the drafting table) to
   pick up the task, constraints and any reference images. `pull-images` and
   read anything visual.
2. **Signal you're on it.** `canvas status <session-id> working`.
3. Do the work in your terminal.
4. **Report back.** Post a short summary into your crew's advice frame:
   `canvas sticky "what changed + anything risky" --frame advice --author <crew>`.
   One tight sticky beats a wall of text.
5. **Flip the light.** `canvas status <session-id> done` when finished, or
   `needs-you` if you're blocked and want a human — that pulses amber on the
   canvas so someone comes over.

## Notes

- Keep stickies short; they're read at a glance from across the room.
- `read`/`frames` are safe to run any time — they only read.
- If a frame name doesn't match, run `canvas frames` to see the real names.
- A Stop hook can automate step 5 (`canvas status <id> needs-you`) so the
  drafting table always shows who wants attention.
