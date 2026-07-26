---
name: roadmap
description: Maintain a room's canvas roadmap control — the live Done/Now/Next/Later board of outcomes, initiatives, metrics and features that humans re-prioritise by dragging and clicking, and agents populate and read back. Use when the user wants to initialise a roadmap, refresh its horizon after things have shifted, bump a status/position, or publish a read-only Markdown snapshot. Auto-routes between INIT / REFRESH / BUMP by whether the roadmap exists and the size of the change; PUBLISH is explicit-only. Reads human edits before every write; single Claude session, no external model calls.
---

# Roadmap

Maintain a **canvas roadmap control** — the zoned outcome board (Done / Now /
Next / Later) that lives server-side per room and that humans re-prioritise
directly on the canvas (drag across zones, reorder, click a status glyph to
cycle). You talk to it only through the `canvas roadmap` CLI. The canvas
document is the roadmap, and its `rev` is the source of truth. There is **no
authoritative markdown file** — PUBLISH can export a Markdown *snapshot* for
readers, but that is a downstream copy, never an input and never canonical.

One entry point, three routed write paths plus one explicit read-only export:

- **INIT** — the named roadmap has no content yet (missing, or an empty
  shell a human placed from the toolbar). First-time population. You draft the
  whole document and `push` it.
- **REFRESH** — the roadmap exists and the *horizon* has drifted: outcomes need
  re-sequencing, initiatives added or retired, the plan re-reasoned. You
  regenerate the document and `push --if-rev`, having first folded in the human
  edits you read back.
- **BUMP** — a small, targeted change: flip a status, move one outcome across a
  zone, toggle a metric, park something. A short `ops` batch (`set` / `move`).
  No regeneration.
- **PUBLISH** — export a **read-only Markdown snapshot** of the live roadmap to
  a repo file (default `docs/ROADMAP.md`). Touches only the repo, never the
  canvas. Explicit-only; never auto-routed. See Path D.

Argument override: `/roadmap init`, `/roadmap refresh`, `/roadmap bump`,
`/roadmap publish` forces a path. No argument = auto-detect between the three
write paths (see Routing); PUBLISH only ever runs when asked for by name.

> **Not sprint-driven.** If you have seen a `docs/ROADMAP.md`-based roadmap
> skill that auto-refreshes off a sprint ledger and tracks "tactical vs
> strategic currency" — this is not that. There is no ledger and no markdown
> here, so nothing advances a currency marker automatically. Routing is
> intent-driven, and REFRESH is only ever run when the horizon has actually
> moved or the user asks for it.

## The rule that matters most: read before every write

Human drags, reorderings and status-clicks live **only** in the canvas
document — nowhere else. So **always `canvas roadmap read <name>` first**, on
every path, and treat what comes back as authoritative. Never regenerate blind:
a REFRESH that ignores the read will silently stamp on a human's re-prioritisation.

Every write is optimistically concurrent:

- `read` returns the document **and its `rev`**.
- `push --if-rev <rev>` / `ops --if-rev <rev>` write only if `rev` is still
  current. A stale write returns **409** (the CLI prints the current rev in the
  body and exits non-zero).
- On 409: **re-read, merge the human edit that landed meanwhile, retry** with
  the fresh rev. Do not `--force` past it and do not drop the human change.

Pass `--if-rev` on every REFRESH `push` and every BUMP `ops`. (INIT of a
brand-new roadmap has no prior rev, so no `--if-rev`.)

## Routing (step 1, always)

1. **Argument override.** If the user passed `publish`, go straight to Path D —
   it is read-only and skips the existence/size routing entirely (it only needs
   the roadmap to exist). If they passed `init` / `refresh` / `bump`, honour it —
   but still apply the refusals below.
2. **`canvas roadmap list`** — the room's roadmaps (`id`, `name`, `rev`,
   `updated`). Identify the target by the user's name; if ambiguous, ask which
   one rather than guessing (see the fuzzy-match footgun below).
3. **Does the target exist with content?**
   - **Not listed** → path = INIT. If the user asked for `refresh`/`bump`,
     refuse: there is nothing to refresh yet — suggest `/roadmap init`.
   - **Listed but empty** (`read` returns zero outcomes — a human placed the
     shape but never populated it) → path = INIT, targeting that existing name.
   - **Listed with content** → REFRESH vs BUMP by the size of the change:
     - Structural or strategic (add/remove/re-sequence outcomes or initiatives,
       rethink the plan) → **REFRESH**.
     - One or a few field/position tweaks (status, zone move, metric toggle,
       park) → **BUMP**.
     - Genuinely unsure → default to **BUMP** (cheap, targeted, easy to reverse)
       and say which you chose and why. Don't regenerate the whole document for
       a one-status change.
4. If the user asked for `init` while the target already has content: refuse.
   Point them at `/roadmap refresh`, or tell them to clear it first (re-`push` a
   deliberately emptied document) if they truly want to start over.

## Wire format

Adopted verbatim from the roadmap control (see
`client/src/roadmap/model.ts`, `server/src/roadmap-store.ts`). One document:

```
meta:        { title, revision?, updated? }   # server stamps `updated`; your values are ignored
outcomes[]:  { key, zone, status, title, why?, initiatives[] }
initiative:  { key, title, status, statement?, metrics[], features[] }
metric:      { key, text, done }               # boolean, not status
feature:     { key, text, status }
```

- **Zones** (outcomes only): `done | now | next | later`.
- **Statuses** (outcomes, initiatives, features): `planned | in-progress | done | parked`.
- **Keys** — `O3`, `O3.I1`, `O3.I1.F2`, `O3.I1.M1` — are **unique across the
  whole document** and are how `ops` address nodes. The server rejects duplicate
  keys on write. **Keep keys stable across a REFRESH** so any later `ops` still
  point at the same node; don't renumber gratuitously. New nodes get fresh keys
  that don't collide.
- Metrics carry `done` (a boolean), everything else carries `status`.

A concrete, valid document (trimmed from `server/src/roadmap-fixture.ts`):

```json
{
  "meta": { "title": "Product Roadmap", "revision": "rev 01", "updated": "2026-07-01" },
  "outcomes": [
    {
      "key": "O1", "zone": "done", "status": "done",
      "title": "Reliable Nightly Sync",
      "why": "Stale source data means every report is second-guessed.",
      "initiatives": [
        {
          "key": "O1.I1", "title": "Ingest one source end-to-end", "status": "done",
          "statement": "FOR: analysts. OUTCOME: data present at 09:00 untouched.",
          "metrics": [
            { "key": "O1.I1.M1", "text": "Sync completes by 09:00 unattended", "done": true }
          ],
          "features": [
            { "key": "O1.I1.F1", "text": "Connector framework + registry", "status": "done" }
          ]
        }
      ]
    },
    {
      "key": "O4", "zone": "next", "status": "planned",
      "title": "Self-Serve Onboarding",
      "why": "Setup time is measured in days, not minutes.",
      "initiatives": []
    }
  ]
}
```

## Detail decays across the zones

The Done/Now/Next/Later zones ARE the detail gradient — treat distance from
"now" the way a milestone ladder treats distance from the active sprint:

- **Done / Now** — fully detailed. Outcomes carry `why`; initiatives carry a
  `statement` and their real metrics and features.
- **Next** — lighter. Initiatives named, a metric or two, features optional.
- **Later** — skeletal. Often just outcomes with a title and `why`, few or no
  initiatives. It is a ranked wish-list, not a contract, and REFRESH is expected
  to re-shape it.

Don't over-specify `later`: it will change. Do fully specify `now`: people are
working against it.

## Path A — INIT

Runs when the target roadmap is missing or an empty shell.

1. **Gather the brief from the room, not a file.** There is no `idea.md` here.
   Pull intent from the canvas and the user:
   - `canvas frames` then `canvas read <frame>` (your crew frame, `advice`, a
     `roadmap`/`planning` frame) for stickies, text and embeds teammates left.
   - `canvas transcript --since <ms>` if a live session is discussing direction.
   - Ask the user directly for anything load-bearing that isn't on the canvas:
     the title, the handful of outcomes that matter, which are already done.
2. **Draft the document yourself** (single Claude session — no external model
   calls). Shape it to the wire format above, applying the detail-decays rule.
   Set `meta.title` to the human name; leave `updated` for the server. Assign
   clean keys (`O1`, `O1.I1`, …).
3. **Write it to a scratch file and push.** Use the scratchpad dir, not the
   repo:
   ```sh
   canvas roadmap list                      # confirm the exact target name first
   canvas roadmap read "<name>"             # if an empty shell exists, sanity-check it
   # write the JSON to $SCRATCH/roadmap-init.json
   canvas roadmap push "<name>" "$SCRATCH/roadmap-init.json"
   ```
   `push` creates the roadmap data if it doesn't exist. **It does not create a
   shape.** If no human has placed a roadmap shape (toolbar → name) pointing at
   this name, the data exists but renders nowhere — tell the user to add the
   shape from the toolbar and bind it to `<name>` so they can see it.
4. Read it back once (`canvas roadmap read "<name>"`) and confirm it looks right.

## Path B — REFRESH

Runs when the horizon has drifted, or on explicit `/roadmap refresh`.

1. **Read the current document and its rev.** `canvas roadmap read "<name>"`.
   This is where the human's zone-drags, reorderings and status-clicks are — you
   are refreshing *on top of* their edits, not replacing them.
2. **Reason about what changed** and rebuild the document:
   - Re-sequence outcomes across zones where progress or new priorities warrant.
     If a human dragged something to a new zone, **respect it** unless your
     reasoning explicitly supersedes it — and if it does, say why in your summary.
   - Add newly-real outcomes/initiatives; retire finished or abandoned ones
     (move to `done`, or `park` via status — don't silently delete history the
     human can see).
   - Re-detail `now`, thin out `later`, promote `next` items that are becoming
     active.
   - **Preserve keys** for surviving nodes; mint new keys only for new nodes.
3. **Push with the rev you read:**
   ```sh
   # write merged JSON to $SCRATCH/roadmap-refresh.json
   canvas roadmap push "<name>" "$SCRATCH/roadmap-refresh.json" --if-rev <rev>
   ```
   On **409**: someone edited while you reasoned. Re-read, fold that edit into
   your document, retry with the new rev. Never `--force` over it.
4. Summarise the delta for the room (a short `advice` sticky): what moved zones,
   what was added, what was retired/parked.

## Path C — BUMP

The cheap path: a targeted `ops` batch, no regeneration.

1. `canvas roadmap read "<name>"` for the current rev and the exact key(s).
2. Build the smallest ops batch that does the job and apply it with `--if-rev`:
   ```sh
   canvas roadmap ops "<name>" '[{"op":"set","key":"O3.I1.F2","fields":{"status":"done"}}]' --if-rev <rev>
   ```
   Op vocabulary and the fields each kind accepts:
   - `{"op":"set","key":"O3","fields":{...}}` — field updates. Per kind:
     - **outcome**: `status` / `title` / `why`
     - **initiative**: `status` / `title` / `statement`
     - **feature**: `status` / `text`
     - **metric**: `done` (boolean) / `text`
   - `{"op":"move","key":"O4","zone":"now","index":0}` — outcomes take `zone`
     and/or `index`; initiatives / metrics / features take `index` only (reorder
     within their parent).
3. Ops batches are **all-or-nothing** and atomic; a bad key fails the whole
   batch (404 naming the key). On **409**, re-read and retry as above.

**Parking is a BUMP job.** The canvas status-click cycle
(`planned → in-progress → done`) deliberately skips `parked` — a human can't
park by clicking. Setting `status: "parked"` is a considered act that only the
CLI/agent does, so it belongs here.

**Structural changes are NOT a BUMP.** Adding or removing outcomes,
initiatives, metrics or features has no `ops` verb — it goes through a `push`
`replace` (REFRESH). `set`/`move` only edit fields and positions of nodes that
already exist.

## Path D — PUBLISH

Export a **read-only Markdown snapshot** of the live roadmap. This is a
*publishing* step, not a source of truth: the canvas stays canonical, the file
is a point-in-time copy for people who read the repo rather than the room. It
**does not sync back** and goes stale the moment anyone edits the canvas.

Explicit-only (`/roadmap publish [name] [path]`). Never auto-routed, never part
of INIT/REFRESH/BUMP — a write path should not silently emit a file that will
immediately drift.

1. **Read the live document** — `canvas roadmap read "<name>"`. This is a plain
   read; no `--if-rev`, no write, nothing to conflict with. If the roadmap
   doesn't exist, stop and say so (there is nothing to publish yet).
2. **Render with the bundled script**, which stamps the snapshot date, the
   `rev` it was taken at, and a prominent "not the source of truth" banner:
   ```sh
   canvas roadmap read "<name>" \
     | python3 .claude/skills/roadmap/render-snapshot.py > docs/ROADMAP.md
   ```
   - Default output is `docs/ROADMAP.md`; honour a path the user gives instead.
   - The script self-dates to today; pass `--date YYYY-MM-DD` only to override.
   - Zones render **Now → Next → Later → Done** (reader-first), independent of
     the canvas's Done-first zone order.
3. **Never hand-edit the output** and never treat it as an input to a later
   REFRESH — the canvas is the only source. Regenerating simply re-runs step 2.
4. Publishing changes only the repo. Commit it if the user wants it tracked
   (feature branch + PR; never straight to `main`); otherwise leave it in the
   working tree. Don't post a canvas sticky or touch the status light for a
   publish — nothing changed in the room.

## Canvas etiquette

You're working on a shared, watched canvas — keep the room informed (see
`~/AGENTS.md`):

- Set your status light: `canvas status "$SESSION" working` while heads-down,
  `needs-you` if you're blocked on a human decision (e.g. which of two
  same-named roadmaps to target), `done` when finished.
- Post a short summary sticky on `advice` (`--author <you>`) after INIT/REFRESH:
  what the roadmap now says at a glance, and what you changed.
- Don't flood frames. One clear sticky beats five.

## Notes and edge cases

- **Fuzzy name match is a footgun.** `read`/`push`/`ops` match an existing
  roadmap by case-insensitive substring, **exact id first**. `push "roadmap"`
  will happily *replace* an existing "Product Roadmap" rather than create a new
  one. Always `list` first and address the target by a precise name. If two
  roadmaps could match, stop and ask — don't guess.
- **push creates data, not a shape.** New roadmap data is invisible until a
  human places a roadmap shape (toolbar only) bound to that name. Say so; don't
  claim the user can see something they can't.
- **The server owns `meta.updated` and `rev`.** Don't try to set them; anything
  you send is ignored (`updated`) or managed (`rev`).
- **Don't undo human edits by accident.** The whole reason to read first is that
  the canvas is the only record of a human's drag/click. If a REFRESH moves
  something a human just placed, that must be a deliberate, explained choice.
- **Multiple roadmaps per room** are normal. A room can hold several; each is
  `(room, id)`. Keep them distinct and don't cross-contaminate keys — keys only
  need to be unique *within* a document.
- **Single session, no external model calls.** Draft and merge yourself. This
  skill has no multi-model fan-out and needs no credentials.
- Use **UK English** in titles, `why`, statements and stickies (initialise,
  prioritise, recognise, …).
