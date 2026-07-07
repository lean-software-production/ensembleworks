---
name: minutes
description: Act as the session-minutes scribe for the EnsembleWorks — poll the live voice transcript, distil it into running minutes (decisions, actions, topics, who said what and where), and keep both a markdown file and a Minutes frame on the canvas up to date. Use when asked to take minutes, summarise the session, or "be the scribe".
---

# Skill: Session minutes

The canvas transcribes everyone's voice: the scribe bot turns each utterance
into a transcript entry, **stamped with the speaker's cursor position and the
frame they were working in** when they said it. Your job is to turn that raw
feed into minutes a teammate who missed the session would actually want to
read.

You need the `ensembleworks` CLI on PATH (`ENSEMBLEWORKS_URL`,
`ENSEMBLEWORKS_ROOM` env as usual).

## Reading the transcript

```bash
ensembleworks scribe transcript                    # everything so far (JSON, oldest first)
ensembleworks scribe transcript --since 1750000000000   # only entries newer than that ms-epoch
```

The response carries a top-level `now` (server clock). **Chain your polls with
it**: save `now`, sleep, then `--since <saved now>`. Never trust your own
clock. Each entry looks like:

```json
{ "t": 1750000012345, "name": "Alice", "text": "let's cap retries at three",
  "page": "page:page", "cursor": { "x": 1180, "y": 420 },
  "frame": { "name": "Drafting — crew-a", "dist": 0 } }
```

`frame` is *where the speaker was* — `dist: 0` means inside that frame. With
no tab open, `cursor`/`frame` are null; those lines still belong to the
conversation, just without a place.

## The loop

1. **Set up once.** `ensembleworks canvas frames` to find (or pick a spot for)
   a frame whose name contains `minutes`; humans usually seed one. Create the
   minutes file, e.g. `minutes-$(date +%F).md`, with the session name and start
   time. Post one sticky so the room knows minutes are running:
   `ensembleworks canvas sticky "minutes started" --frame minutes --author scribe --color light-blue`.
2. **Poll.** Every 2–3 minutes (`sleep 150`), fetch the new tail with
   `--since`. No new entries → just sleep again.
3. **Distil — don't transcribe.** Fold the new entries into the minutes:
   - **Decisions** ("we'll go with…", agreement after debate) — verbatim-ish,
     with who and when.
   - **Actions** (someone committed to doing something) — owner + thing.
   - **Topics** — one line per discussion thread, not per utterance.
   - **Open questions** — raised but not settled.
4. **Use the places.** Group by `frame.name`: utterances inside
   `Drafting — crew-a` are crew-a's huddle; a cluster at the retro corner is
   its own thread. Two groups talking simultaneously in different frames are
   **parallel conversations — keep them as separate threads**, don't
   interleave them into nonsense.
5. **Write back.**
   - Append the distilled section to the markdown file (keep raw quotes out;
     it's minutes, not a court record).
   - Keep the canvas summary fresh: maintain **one text shape** in the
     minutes frame — create it once and remember the id, then update in
     place so the frame doesn't fill with stale copies:
     ```bash
     ensembleworks canvas shape '{"type":"text","frame":"minutes","x":24,"y":24,"w":560,"text":"…"}'
     ensembleworks canvas shape '{"op":"update","id":"shape:<saved-id>","text":"…refreshed summary…"}'
     ```
     Keep it to ~15 lines: latest decisions + actions on top.
6. **On "wrap up" / session end:** do a final pass over the whole transcript
   (`ensembleworks scribe transcript` with no `--since`), write the complete
   minutes — attendees (distinct `name`s), timeline of topics with rough times,
   decisions, actions, open questions — and post a closing sticky:
   `ensembleworks canvas sticky "minutes ready: <path>" --frame minutes --author scribe --color light-blue`.

## Judgement calls

- Speech-to-text is imperfect: names and jargon arrive mangled. Use the
  canvas for context (`ensembleworks canvas frame <frame>` shows what the
  speakers were looking at) before guessing what a garbled term meant.
- Standup mode produces one big room-wide conversation — frame stamps still
  tell you what people were *looking at* while speaking.
- Don't editorialise; minutes record what the room decided, not what you
  would have decided.
