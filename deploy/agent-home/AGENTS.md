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

## Pushing to GitHub

You commit and push as the box's **GitHub App bot** (`ensembleworks-lsp[bot]` on
the prod boxes), never a personal account — and you don't handle a token to do
it. Just use `git` and `gh`:

```sh
git push origin HEAD:my-branch   # HTTPS remote — credentials are automatic
gh pr create --fill              # acts as the bot
gh api /repos/lean-software-production/<repo>
```

Clones must use an **HTTPS remote**
(`https://github.com/lean-software-production/<repo>.git`). A `git@github.com:`
remote goes over SSH, which bypasses the credential helper entirely and will
fail.

Open a PR and let a human merge. Don't push to `main` or merge your own PR, even
when GitHub lets you: most org repos don't enforce branch protection, and
private ones like `workshops` can't on the org's plan, so nothing stops you but
this rule. Credit teammates who paired with you using `Co-authored-by:`
trailers.

**When GitHub auth fails, match the symptom before doing anything else:**

- **`gh auth login`, `could not read Username`, `CONNECT tunnel failed`, or a
  `deny network-outbound github.com` violation** — you're inside an agent
  sandbox, which blocks the credential path. Re-run the same `git`/`gh` command
  outside the sandbox. Don't run `gh auth login`, switch to SSH, mint a token
  by hand, or ask anyone for a personal token.
- **`Bad credentials` or `Invalid username or token` in a BB thread** — the
  `GH_TOKEN` BB injected at the start of your turn has expired (it lives ~1h).
  Run `eval "$(bb github-app-auth env)"` and retry in that same shell.
- **`Resource not accessible by integration` (403)** — auth worked; the App
  lacks that permission, or isn't installed on that repo (personal repos never
  are). Say so and carry on without it; don't work around it with other
  credentials.
- **A quiet `git fetch -q` can fail without you noticing.** Check its exit code
  before trusting `origin/main`.

Otherwise run **`ensembleworks-gh-doctor`**, outside the sandbox. It names the
actual cause — an expired injected token, App not provisioned on this box,
missing sudo rule, stale credential config, an SSH remote — instead of the
generic 403 every one of those produces. If it reports the App isn't
provisioned here, GitHub pushing just isn't set up on this box: carry on
without it.
