---
name: room-transcript
description: Read what the team actually said out loud in the canvas room. Use whenever a task depends on a conversation you were not in — "what did we decide about X", "catch me up on the last hour", "who raised the concern about the migration", a note or prompt that references "what we just discussed", or any request to summarise, quote, or act on the room's spoken discussion.
---

# The room transcript

The canvas room is a voice room. A scribe service (LiveKit → Whisper) posts
every utterance to the Canvas plugin, which keeps them in a queryable table:
one row per utterance, with a timestamp, a speaker, and the text.

This is **not** a bb thread. Nobody replies to it, it has no turns, and it is
not in your context by default — you have to go and read it.

## Reading it from a shell

```
bb canvas transcript                       # the last 200 utterances
bb canvas transcript --since 10m           # the last ten minutes
bb canvas transcript --since 2h --speaker alice
bb canvas transcript --search "rate limit" # every mention of it, whenever
bb canvas transcript --since 1d --json     # [{ "ts": …, "speaker": …, "text": … }]
```

- `--since` takes a duration — `45s`, `10m`, `2h`, `1d`. There is no bare-number
  form: say the unit.
- `--search TEXT` is a case-insensitive substring of what was **said**;
  `--speaker NAME` is a case-insensitive exact name. Both together is an AND.
- `--limit N` (default 200, max 1000) is the **tail**: the newest N matching
  utterances. Output is always oldest-first, so it reads top to bottom.
- Human output is one line per utterance: `HH:MM speaker: text`.

Nothing here writes. Reading the transcript can never disturb the room.

## Pulling it into a message

A human can attach a window of transcript to any message by typing
`@transcript` in the composer and picking **Last 15 minutes**, **Last hour**,
**Today**, or **matches for …**. The block is resolved when they hit send, so it
is the window before *sending*, not before typing — and it is capped at ~8000
characters, dropping the oldest lines first and saying so in its header when it
does.

If you have been handed such a block, it is already the tail: do not assume it
is the whole window when its header says entries were dropped.

## Reading it well

- **Prefer a window to a search when you are catching up**, and a search when
  you are checking a fact. "What did we decide" is `--since 30m`; "did anyone
  mention Postgres" is `--search postgres`.
- **Transcripts are lossy.** Names, acronyms, and code identifiers come back
  mangled ("Loro" as "Lorow", "psql" as "sequel"). Read for intent, and when a
  decision hangs on an exact token, say what you read rather than asserting it.
- **Turn-taking is implicit.** Speakers interleave and the diariser splits
  mid-sentence; two adjacent lines from one speaker are usually one thought.
- **A transcript is not a decision record.** People think out loud, reverse
  themselves, and joke. Prefer the last thing said on a topic, and if the room
  never converged, say that instead of picking a side.
