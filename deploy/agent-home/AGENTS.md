# Working in the EnsembleWorks canvas

You are a coding agent running in a terminal **on a shared, multiplayer canvas**.
Other teammates — humans and other agents — share this room and watch your
terminal live. Two things follow from that:

- This is a **scratch sandbox**. You can't reach the EnsembleWorks source, its
  secrets, or anyone else's files. Do your work under this home directory.
- Talk to the room through the **`ensembleworks`** CLI (`ew` for short). It is
  how teammates see what you're doing, and how you read what they've put on
  the canvas.

## The `ensembleworks` CLI

`ensembleworks` speaks HTTP to the room on localhost — no secrets, no repo
needed. Defaults: room `team`, server `http://localhost:8788` (override with
the `ENSEMBLEWORKS_ROOM` / `ENSEMBLEWORKS_URL` environment variables). Run
`ensembleworks --help` for the full reference.

Your status light hangs off your terminal's session id. Find it once:

```sh
SESSION=$(tmux display-message -p '#S' | sed 's/^canvas-//')
```

Everyday commands:

```sh
ensembleworks terminal status "$SESSION" working   # status light: working | needs-you | done | idle
ensembleworks canvas frame advice                  # read a frame — stickies, text, images, embeds (JSON)
ensembleworks canvas frames                        # list every frame + child counts (JSON)
ensembleworks canvas sticky "shipped the retry fix" --frame advice --author <you>   # 🤖-tagged note
ensembleworks canvas sticky "risk: retry loop has no backoff" --frame advice --color yellow
ensembleworks canvas pull-images drafting          # download a frame's images; prints local paths to read
ensembleworks scribe transcript --since <ms>       # the room's voice transcript, oldest first
ensembleworks canvas shape '{"type":"geo","text":"retry bug","x":100,"y":80}'   # draw / update / delete a shape
```

## Roadmap

A room can hold named roadmap controls — zoned outcome boards (Done / Now /
Next / Later) that humans re-prioritise by dragging and clicking status
glyphs, and agents populate and read back:

- `ensembleworks roadmap read` — the room's roadmaps (id, name, rev, updated).
- `ensembleworks roadmap read <name>` — full document + `rev`. Fuzzy name
  match, exact id first. Read before you regenerate: human drags and status
  clicks live here and nowhere else.
- `ensembleworks roadmap write <name> --ops '[{"op":"replace","data":<doc>}]' [--if-rev <rev>]` —
  create or wholesale-replace from a roadmap.json document
  (`meta + outcomes[] → initiatives[] → metrics[]/features[]`; keys like
  `O3.I1.F2` must be unique). Use `--if-rev` with the rev you read; a 409
  reply means someone edited meanwhile — re-read, merge, retry.
- `ensembleworks roadmap write <name> --ops '<ops-json>' [--if-rev <rev>]` — targeted edits
  without touching the rest:
  `[{"op":"set","key":"O3.I1.F2","fields":{"status":"done"}}]`
  `[{"op":"move","key":"O4","zone":"now","index":0}]`
  `set` fields per kind — outcome: status/title/why; initiative:
  status/title/statement; feature: status/text; metric: done/text. Statuses:
  planned | in-progress | done | parked. `move` takes `zone` (outcomes only)
  and/or `index` (position within the zone or parent list).

Structural changes (add/remove outcomes, initiatives, metrics, features) go
through a replace op — regenerate the document and replace it.

## How to work here

1. **Take your brief.** `ensembleworks canvas frame <your-frame>` (often your
   crew name) to see what you've been asked to do and what teammates have
   drawn.
2. **Keep your status honest.** `ensembleworks terminal status "$SESSION" working`
   while heads down; switch to `needs-you` the moment you're blocked on a
   human, `done` when finished. The status light is how people know whether
   to come help.
3. **Share findings as stickies** on the **advice** frame, tagged with
   `--author <you>` so the room knows who's talking. Keep them short.
4. **Leave the canvas legible.** Give your terminal a meaningful title and don't
   flood frames — everyone shares this space.

## Pushing to GitHub

You commit and push as the **`ensembleworks[bot]`** GitHub App, never a personal
account. You can't read the App key (it's outside this sandbox) — instead mint a
short-lived (~1h) token through the wrapper, then push over HTTPS:

```sh
TOKEN=$(sudo -u ensembleworks ensembleworks-gh-token)          # all org repos
# TOKEN=$(sudo -u ensembleworks ensembleworks-gh-token myrepo) # or scope to one
git push "https://x-access-token:${TOKEN}@github.com/lean-software-production/<repo>.git" HEAD:my-branch
```

The **`gh` CLI is pre-wrapped** to do this for you — `gh pr create …`, `gh api …`,
`gh run …` mint a fresh token automatically and act as the bot, so you rarely need
the raw `git push` above.

`main` is branch-protected, so open a PR and let a human merge — pushes straight to
`main` are rejected by design. Credit teammates who paired with you using
`Co-authored-by:` trailers. If the wrapper says the App isn't provisioned on this
box, GitHub pushing just isn't set up here — carry on without it.
