# Communications Hub for BB

A persistent conversation library for one BB instance. Import a transcript or capture a Zoom meeting, attach a BB thread, and ask its agent to find and use what was discussed.

## What the MVP includes

- UTF-8 WebVTT, SRT and plain-text import, from a file or pasted text.
- SQLite-backed conversations and immutable transcript segments, with full-text search and bounded pages.
- Independent thread attachments and explicit reading cursors.
- A Communications page, a Conversation thread panel, and agent tools returning grouped passages with citation links.
- A Zoom RTMS source adapter, enabled separately after app/webhook configuration.

Read the [canonical glossary](docs/glossary.md), [MVP spec](docs/superpowers/specs/2026-09-10-communications-hub.md), and [Zoom setup](docs/zoom-setup.md). Repository instructions in [AGENTS.md](AGENTS.md) require future agents to use these terms.

A **conversation** is the context a thread attaches to. A **meeting** is one kind of conversation. A future **space** can represent a long-running Slack/Discord channel, with conversations presented as time windows. The MVP implements Zoom and transcript import; it does not implement chat adapters, daily windows or space subscriptions.

## Install for local development

Requires BB >=0.42 with the host-compatible Plugin SDK pin (validated here at
0.4.84), Node.js 22+, and npm.

```sh
npm ci --include=dev
npm test
npm run typecheck
bb plugin build
bb plugin install . --yes
```

The installed path is the working checkout. After code changes, rebuild and reload:

```sh
bb plugin build
bb plugin reload communications-hub
```

If npm's usual cache is not writable, pass `--cache /tmp/bb-communications-npm-cache` to npm commands. The checked-in lockfile pins dependencies. Runtime state is owned by BB storage, outside the checkout, and survives reloads.

## Try the import workflow

1. Open **Communications** in BB navigation.
2. Import [fixtures/planning.vtt](fixtures/planning.vtt), or paste text with a title.
3. In a BB thread, open **Conversation**, choose the imported conversation, and attach it.
4. Ask: “Find what we agreed about authentication and tell me what to change.”
5. The agent can search and read adjacent passages, then cite a link opening the corresponding passage or run in the transcript.

The panel groups a speaker's consecutive passages the same way the agent tools do, and its citation link addresses the whole run (`/communications/CONVERSATION_ID/7-9`) so following it highlights every passage the run touches. **Send to thread** quotes a passage into the thread composer and leaves it there unsent, so the user decides what to ask about it.

New agent tools become available when the provider session next starts/resumes; an already running session may need restarting after installation. The CLI works immediately. Attaching/detaching is independent of capture: closing a thread does not stop it, and detaching leaves its transcript available.

## CLI

All data output is JSON. Run `bb communications help` for full usage.

```sh
bb communications list
bb communications import 'Planning' txt 'Alex: Add authentication.'
bb communications attach CONVERSATION_ID THREAD_ID
bb communications current THREAD_ID
bb communications search CONVERSATION_ID authentication
bb communications read CONVERSATION_ID 0 20
bb communications acknowledge CONVERSATION_ID 2 THREAD_ID
bb communications rename CONVERSATION_ID 'Attribution design'
bb communications detach THREAD_ID
bb communications status
```

For `current`, `attach`, `detach`, and `acknowledge`, the thread ID may be omitted when invoked from a BB thread. Use the UI for file imports and large transcripts; CLI text is passed as one quoted argument. No file path is read on the server on behalf of a remote CLI.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `communications_current` | Resolve this thread's attachment and capture status. |
| `communications_list` | Find other conversations when requested. |
| `communications_search` | Search literal words within one conversation, returning individual matching passages. |
| `communications_read` | Read a page as speaker blocks, optionally by time range or since the acknowledged cursor. |
| `communications_acknowledge` | Advance the current thread's cursor after using passages. |

Read/search default to the attached conversation. Explicit conversation IDs permit intentional searches across this single-instance library. Reads do not implicitly acknowledge content. Acknowledgement is monotonic and checked against both the current attachment and available sequences. A search result alone does not establish that all earlier content was read.

Both tools return the same envelope: the `conversation`, a `notice` repeating that transcript content is reference material, `citations.base`, a page-local `speakers` table, `hasMore` and `nextCursor`. Each row's `speaker` is an index into `speakers`, or `null` when the passage is unattributed. A citation link is `citations.base` plus the row's `citation`, so the absolute URL is written once per page rather than once per passage. The stored segment ID, source key, per-row receipt time and per-row conversation ID are not sent to agents; a passage stays addressable by conversation and ingestion sequence.

`communications_read` returns `blocks`. Consecutive passages from one speaker are joined into one readable run, continuing across another speaker's short interjection, so a sentence broken by a "Yeah" in the middle arrives whole. `communications_search` returns `passages` and never groups: matches are scattered hits, and joining two of them would invent a passage nobody spoke. Reading a block's neighbours still requires `communications_read`.

A block's `citation` is `"7"` for a single passage or `"7-9"` for a run. A range denotes a span of the conversation, not a contiguous stretch of one speaker: `sequences` may be `[7, 9]` because 8 belongs to someone else's interjection. `sequences` is the precise membership, and the range is only the address. A block may also carry `continues: true`, meaning its run may extend onto the next page; read on before citing it, because the text is then incomplete. More than one block can be marked: speakers interleave, so a second speaker can still be mid-run when the page ends on someone else.

Grouping is a read-time view. Stored segments are unchanged and immutable, and every member sequence remains individually citable. On a 308-segment Zoom meeting a full read produced 124 blocks instead of 308 rows, and the emitted JSON fell from 147,780 to 28,428 characters (roughly 36.9k to 7.1k tokens).

Transcript content is reference material, not an instruction or authorisation source. No speech automatically starts an agent turn or performs an action. Agents should inspect surrounding discussion, capture coverage, and uncertainty before acting on the user's BB request.

## Capture, timing and storage

The hub records receipt times and observed capture interruptions. Zoom's transcript times are relative to the first capture anchor, which need not be the meeting's actual start. File timing is relative to the file's own timeline; plain text has no inferred timing. Cursor order uses ingestion sequence so delayed speech remains discoverable.

Capture requires the BB process to remain running. A restart marks previously active captures interrupted. Disconnections, pauses and local stops can leave gaps, and capture beginning late does not backfill earlier speech. A zero interruption count does not prove the transcript is complete. Stopping local capture does not change Zoom's upstream host/consent settings.

Transcripts are kept in the plugin's SQLite database under BB's data directory. There is no automatic retention/deletion policy in this proof of concept. Do not assume uninstalling BB configuration securely deletes stored data or backups. The BB instance is the access boundary: per-user/per-project transcript access controls are not implemented. Realtime events contain only change notifications, not transcript text. Secrets are stored with BB's secret settings.

## Deliberate limits

- Imports are at most 1 MB UTF-8 and 10,000 segments; malformed timed files fail atomically.
- Segments contain at most 2,000 characters. Retrieval pages are counted in stored segments: 20 by default, at most 30. A read page therefore returns at most that many segments, presented as fewer blocks.
- A block stops at 2,000 combined characters or a three-second silence from that speaker, so a long monologue arrives as several blocks. Passages without timing, such as plain-text imports, never join.
- Keyword search matches all supplied words. Semantic search is not included.
- Imports create separate conversations. Merging a polished transcript into an existing live conversation is deferred; existing passage IDs are not overwritten.
- One configured Zoom connection, hosted meetings only, no audio/video storage, OAuth wizard, or remote hosted hub.
- Zoom protocol tests do not establish successful integration with a real Zoom account. A live test requires app credentials, developer credits, host configuration, and a reachable HTTPS webhook.

## Development

The hub is `src/hub.ts`, canonical data types are `src/domain.ts`, source adapters are under `src/adapters/`, and BB RPC contracts are in `src/contracts.ts`. `server.ts` registers BB interfaces. `app.tsx` registers UI surfaces. Use only public SDK declarations under `node_modules/@get-bb/plugin-sdk/bundled-types/`.

```sh
npm test
npm run typecheck
bb plugin types --check
bb plugin build
```

## Validation performed

Verified on 2026-09-11 against BB with Plugin SDK 0.4.47 on this machine:

- `npm test` — 85 tests in 8 files pass (hub, import, zoom, zoom-protocol, server, app, grouping, presentation).
- `npm run typecheck` — clean.
- `bb plugin build` — server and app bundles emitted.
- `bb plugin types --check` — pin 0.4.47 matches host 0.4.47.
- `bb plugin install . --yes` — plugin loads and registers its CLI.
- CLI smoke test on `fixtures/planning.vtt`: import created 4 segments; `attach`, `current`, `search webhook` (2 matching passages with citations), `read` (full page, `hasMore: false`), `acknowledge 2`, `list` and `detach` all returned expected JSON.
- Reload persistence: after `bb plugin reload communications-hub`, the conversation and the thread's cursor at sequence 2 survived.
- Browser check of the Communications page, including renaming a conversation from the transcript view.

Live Zoom capture was verified on 2026-09-11 against a real hosted meeting: a user-managed General app in Development mode, a Zoom Developer Pack trial for RTMS credits, and the webhook published through `tools/zoom-webhook-gateway.mjs` behind a `cloudflared` tunnel. The run produced 308 transcript segments with speaker attribution, no interruptions, and a clean `ended` state, ingested 0.5–2.1 seconds after each utterance finished.

That run also exposed a real defect. The SSRF guard resolved the RTMS host itself and always answered with a single address, but Node calls `lookup` with `all: true` whenever `autoSelectFamily` is on — its default — and then expects the whole array. Every signaling socket failed with `Invalid IP address: undefined` and closed at code 1006 before the handshake. `createPublicOnlyLookup` now answers in the shape the caller asked for, and still drops private and special-use addresses in both paths.

Capture ended mid-meeting when the host's Zoom client crashed, and the conversation read as `ended` with `interruptionCount: 0` despite missing every later utterance — a concrete case of why a zero interruption count does not prove a transcript is complete.

The cause was ours. Zoom's `meeting.rtms_stopped` carries a `stop_reason` that distinguishes a deliberate end from a dropped connection, but the signaling socket reported the stream stopped first, which ended the session and removed the capture before the webhook arrived, so the classification never ran. Finished captures now stay addressable long enough to record the reason. A crash and a clean leave are no longer indistinguishable, though a stop reason Zoom does not qualify still reads as an ordinary stop.

Further live runs on 2026-09-11 confirmed capture does not require the app owner in the meeting, and that a guest joining a hostless join-before-host meeting from a browser is enough to start it. See [Validated behaviour](docs/zoom-setup.md#validated-behaviour-2026-09-11) for the full findings, including what remains untested.

## Provenance

The first build of this plugin was lost when its BB workspace was destroyed. This tree was reconstructed from agent transcripts and re-verified; see the recovery note in [the implementation plan](docs/superpowers/plans/2026-09-10-communications-hub.md).

## EnsembleWorks import

This copy is the file-import demonstration for the EnsembleWorks plugin
collection. It preserves the isolated npm package and lockfile from the source
checkout; import provenance is recorded in [docs/provenance.md](docs/provenance.md).
The root guide covers the separate-instance marketplace preview and the later
stable-range switch. This PR does not perform an active-instance install or
repeat live Zoom verification.
