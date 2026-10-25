# Conversation watch MVP

## Agreed outcome

A user can enable watching on a thread attached to a conversation. New passages wake the thread agent to continue the user's existing task. The infrastructure does not prescribe an artifact or interpret spoken instructions as authorization. A local HTML mind map is the first example task, not a product feature or output contract.

Implement in the Communications Hub plugin using its SQLite storage and public BB SDK. Use cheaper sub-agents for bounded implementation work; the primary agent integrates and reviews. Preserve unrelated checkout changes.

## Design

- Persist one watch per thread, bound to the currently attached conversation, with an independent processed cursor and a unique watch generation. Starting includes existing history from sequence zero; repeated start is idempotent. Stopping and restarting explicitly creates a new generation.
- Keep the ordinary reading cursor unchanged. Add a separate watch acknowledgement operation requiring the current generation and conversation, validating monotonic progress against available passages. Advance only after the agent successfully handles the material, never on read, wake delivery, or thread idle alone.
- Signal the dispatcher after hub changes. Coalesce notifications into a bounded batching window (initially 15 seconds), without postponing forever during continuous speech. Recheck durable state before dispatch.
- Wake only an eligible idle thread, retain pending work while busy, and serialize dispatch. Use public thread APIs and a metadata-only wake message instructing the agent to read the conversation and continue its existing task. Never copy transcript text into the message.
- Poll periodically (initially 60 seconds) and sweep at service startup to recover missed signals or restarts. Bound retries of unacknowledged work with a cooldown. Delivery is at least once; artifact tasks must tolerate replay. Do not promise atomic exactly-once behavior across SQLite and the thread API.
- Stop watching on detach, a change of attached conversation (including room rollover), archive, or thread deletion. A room without a conversation cannot be watched yet. Stop prevents future dispatch; it cannot undo a turn already delivered.
- Dispose listeners and timers on plugin reload/shutdown. Revalidate watch generation and attachment after asynchronous thread checks so stopped/replaced watches cannot send stale work.

## User and agent surfaces

Add Watch conversation / Stop watching controls to the existing thread Conversation panel, with processed position and concise guidance to give the thread a task first. Add CLI start/status/stop and agent watch status/acknowledgement tools. Watch activation is an explicit user action through UI or CLI; the agent's user-supplied task remains in its existing thread. No mind-map-specific settings, keyword rules, new provider, or new public SDK surface are included.

Document exact commands, wake cadence, acknowledgement protocol, failure/replay behavior, and an HTML mind-map example in plugin docs and its agent skill. The original no-automatic-work rule is refined only for explicitly enabled watches.

## Implementation and review

1. Inspect public SDK wake, thread state, service, and lifecycle contracts; record any limitations here.
2. Add durable watch state and independent cursor validation with real SQLite tests.
3. Add dispatcher, event batching, startup/recovery polling, status and acknowledgement tooling, and CLI/RPC integration.
4. Add thread-panel controls and rendered behavior tests.
5. Integrate and review race handling, per-thread isolation, stop behavior, and replay. Commit the implementation after checks pass.

Sub-agents receive disjoint file ownership. Interaction-contract obligations apply if work expands into canvas-editor/src/tools, canvas-react/src, or client/src/canvas-v2; this plugin change currently touches none of those paths.

## Acceptance and validation

- Two threads watching one conversation retain independent processing cursors; casual reads and acknowledgements cannot consume watch work.
- Bursts yield a batched wake. Arrivals while busy remain discoverable; a dropped signal is recovered by a poll. No overlapping dispatch for a thread.
- Persisted watches survive reload; rejected sends and unacknowledged work remain retryable without a tight loop. Stale generation acknowledgements cannot advance a restarted watch.
- Stop, detach, rollover, archive, and deletion prevent later automatic wakes; no-watch threads are unaffected.
- UI exposes start/stop/status and handles failures. Wake messages contain identifiers and processing instructions, not transcript content or an output format.
- Run `npm test`, `npm run typecheck`, and `bb plugin build` in plugins/communications-hub. Existing import, persistence, isolation, pagination, webhook, stream lifecycle, and UI tests remain green.
- Exercise the full delivery path with the public fake host. Provide a reproducible live smoke procedure: ask a thread to maintain an HTML mind map, start watching, stream speech, observe file updates, simulate a missed signal, then stop. Report live agent/artifact verification separately from deterministic harness coverage; do not claim it without running it.

## Execution evidence

Implemented on 2026-09-12 with three `gpt-5.6-luna` sub-agents for storage, dispatcher, and UI, followed by primary-agent integration and review.

- Public SDK 0.4.84 matches the host (`bb plugin types --check`). `threads.send` supports idle-check/auto delivery but has no idempotency key; the durable attempt timestamp and separate processing acknowledgement implement the documented at-least-once behavior.
- Added SQLite watch migration, generation validation, independent processing cursor, lifecycle stop, metadata-only dispatcher, 15-second batching, 60-second polling/cooldown, UI and CLI controls, agent status/ack tools, and user/agent documentation.
- Review corrected realtime watch-status refresh, pending UI request invalidation, polling timer/abort-listener cleanup, stale dispatch checks, and Stop cancelling a still-pending Start request. The send API can queue a message if the thread becomes busy after its status check; already dispatched work cannot be revoked by this MVP.
- `npm test`: all 188 tests in 14 files passed. After adding the final pending-Start cancellation regression, focused server tests passed (12 tests across server and watch-server), and focused dispatcher tests passed (9). These include real SQLite/public fake-host integration for dropped pokes, busy arrivals, independent acknowledgements, reload persistence, and stop during asynchronous dispatch checks.
- `npm run typecheck`: passed after final changes.
- `bb plugin build`: server and frontend bundles emitted; no public SDK additions or dependency changes.
- `git diff --check`: passed. Unrelated pre-existing edits remain untouched.

Live limitation: no watch was enabled on an existing thread, and no live provider-generated HTML mind map was exercised. The README contains the live smoke procedure. This delivery builds the plugin; it does not reload a currently capturing plugin or publish/deploy it.

The BB instance remains the access boundary, matching existing attachment RPC/CLI behavior. Watch agent tools are scoped to the invoking thread; explicit CLI/UI thread IDs remain supported. `ux-contract: none — this change touches the Communications Hub plugin, not the repository’s canvas interaction-bearing paths.`
