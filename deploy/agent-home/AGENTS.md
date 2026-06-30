# Working in the EnsembleWorks canvas

You are a coding agent running in a terminal **on a shared, multiplayer canvas**.
Other teammates — humans and other agents — share this room and watch your
terminal live. Two things follow from that:

- This is a **scratch sandbox**. You can't reach the EnsembleWorks source, its
  secrets, or anyone else's files. Do your work under this home directory.
- Talk to the room through the **`canvas`** CLI. It is how teammates see what
  you're doing, and how you read what they've put on the canvas.

## The `canvas` CLI

`canvas` speaks HTTP to the room on localhost — no secrets, no repo needed.
Defaults: room `team`, server `http://localhost:8788` (override with the
`CANVAS_ROOM` / `CANVAS_URL` environment variables). Run `canvas --help` for the
full reference.

Your status light hangs off your terminal's session id. Find it once:

```sh
SESSION=$(tmux display-message -p '#S' | sed 's/^canvas-//')
```

Everyday commands:

```sh
canvas status "$SESSION" working   # status light: working | needs-you | done | idle
canvas read advice                 # read a frame — stickies, text, images, embeds (JSON)
canvas frames                      # list every frame + child counts (JSON)
canvas sticky "shipped the retry fix" --frame advice --author <you>   # 🤖-tagged note
canvas sticky "risk: retry loop has no backoff" --frame advice --color yellow
canvas pull-images drafting        # download a frame's images; prints local paths to read
canvas transcript --since <ms>     # the room's voice transcript, oldest first
canvas shape '{"type":"geo","text":"retry bug","x":100,"y":80}'   # draw / update / delete a shape
```

## How to work here

1. **Take your brief.** `canvas read <your-frame>` (often your crew name) to see
   what you've been asked to do and what teammates have drawn.
2. **Keep your status honest.** `canvas status "$SESSION" working` while heads
   down; switch to `needs-you` the moment you're blocked on a human, `done` when
   finished. The status light is how people know whether to come help.
3. **Share findings as stickies** on the **advice** frame, tagged with
   `--author <you>` so the room knows who's talking. Keep them short.
4. **Leave the canvas legible.** Give your terminal a meaningful title and don't
   flood frames — everyone shares this space.
