# Communications Hub implementation plan

**Goal:** Deliver the agreed single-instance plugin vertical slice.
**Architecture:** SQLite hub with independent source adapters; BB RPC/tools/CLI and React panels consume the same hub.
**Tech stack:** TypeScript, BB Plugin SDK 0.4.47, Zod, better-sqlite3, WebSockets, React, Vitest.
**Spec:** [MVP specification](../specs/2026-09-10-communications-hub.md)

## Global constraints
Use docs/glossary.md terminology. Runtime data uses BB storage. Credentials never enter frontend/logs. No autonomous actions from speech. Imported and live segments use the same domain schema. One BB instance; no hosted service. Segments <=2,000 chars; pages <=30; imports <=1 MB. Use only public BB SDK.

## Task 1: Persistent hub and transcript import
Files: src/domain.ts, src/hub.ts, src/adapters/import.ts, tests/hub.test.ts, tests/import.test.ts.
Interfaces: Hub.ensureConversation(sourceId, externalId, title), appendSegments(conversationId, segments), setCapture(conversationId,state,detail), listConversations, getConversation, attach, detach, getAttachment, readTranscript, searchTranscript, acknowledge. SegmentInput contains sourceKey,speaker,text,startMs,endMs. SQLite transaction makes imports atomic and source keys unique.
- [x] Write failing behavioural tests for persistence, deduplication, cursor isolation, time filtering, input bounds, and import parsing.
- [x] Implement domain validation, SQLite migration and hub operations, then parsers.
- [x] Run focused tests before BB registration.

## Task 2: Zoom source adapter
Files: src/adapters/zoom.ts, src/adapters/zoom-protocol.ts, tests/zoom.test.ts, docs/zoom-setup.md.
Interface: registerZoom(bb, sink); sink.ensureConversation returns {id}; sink.appendSegments consumes SegmentInput[]; sink.setCapture consumes CaptureState. Return controller.stop(conversationId), status() with configured boolean and enabled boolean. Adapter declares its own Zoom settings and webhook; BB-facing code consumes only controller status.
- [x] Write authentication and controlled-peer lifecycle tests first.
- [x] Implement signed webhook receiver and transcript-only WebSocket lifecycle with bounded retries/disposal.
- [x] Document app setup and exact live-testing limitations.

## Task 3: BB interfaces
Files: server.ts, src/contracts.ts, app.tsx, tests/server.test.ts, tests/app.test.tsx, README.md, fixtures/planning.vtt.
- [x] Test RPC import/read, tool current-thread resolution and CLI errors using the official BB fake host.
- [x] Register validated RPC, bounded tools and CLI, status-only realtime signals.
- [x] Build application panel and thread attachment/view panels using host controls/tokens; test user flows.
- [x] Include operational and agent instructions in tool descriptions and docs.

## Task 4: Integration and review
- [x] Run npm test, npm run typecheck, bb plugin build, and SDK surface check.
- [x] Review implementation against spec, fix defects, rerun affected checks.
- [x] Install the plugin locally and smoke-test import, search, attachment and reload persistence when possible.
- [x] Record exact validation and remaining live Zoom setup in README; deliver links.

## Decisions during execution
- The user approved the architecture and requested spec plus build in one turn; continue implementation without another approval gate.
- This is a new isolated directory in a personal workspace, with its own feature branch. No existing project/yak store is in scope.

## Recovery note (2026-09-11)
The original workspace was destroyed when its BB thread was archived, before the work reached any remote. The tree was reconstructed from Codex rollout transcripts in `~/.codex/archived_sessions` and the BB thread event log: heredoc writes, apply_patch blocks, and `cat`/`sed`/`nl` read output. Recovery was accepted only after the restored tree reproduced 43/43 passing tests, a clean typecheck and a successful plugin build. `tsconfig.json`, `components.json`, `components/`, `hooks/`, `lib/` and `.gitignore` came from a fresh `bb plugin new` scaffold, not from the transcripts.
