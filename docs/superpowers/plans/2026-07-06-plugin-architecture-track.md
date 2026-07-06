# Plugin-architecture completion track — state

> Orchestration design: `docs/superpowers/specs/2026-07-06-plugin-architecture-track-design.md`.
> Charter: `docs/superpowers/specs/2026-07-06-plugin-architecture-track-charter.md` (pending).
> Updated after every slice merge. Branch: `unified-architecture-migration`.

## Slice queue

| # | Slice | Gate tier | Status | Merge | Notes |
|---|---|---|---|---|---|
| 0 | Charter | user sitting | **in progress** | — | sweep workflow running |
| 1 | 3a clean routes | autonomous | queued | — | route table pinned by charter |
| 2 | 3b tool manifest | autonomous | queued | — | depends on 3a |
| 3 | 3c attribution | autonomous* | queued | — | *promotes to gated if charter leaves mechanism murky |
| 4 | #4 ensembleworks CLI | **gated** | queued | — | retires bin/canvas |
| 5 | #5 connector | autonomous | queued | — | retires gateway-go; validate vs relay-loopback.test.ts |
| 6 | #6 transcriber cutover | autonomous | queued | — | parallelizable beside 3a–#5 |
| 7 | #7 distribution | autonomous | queued | — | compile + fetch-verify-swap deploy |
| 8 | #8 cutover release | **manual (user)** | queued | — | track preps checklist; phase-boundary review before |
| 9 | Phase 4: docStore + tools + /mcp | **gated** | queued | — | builds on branch regardless of #8 timing |
| 10 | Phase 5: memory service | **gated** | queued | — | |
| 11 | Phase 6: plugin packages | **gated** | queued | — | default profile must reproduce Phase-3 build |

## Completed before the track (context)

Phase 0/1/2 done. Phase 3 slices merged: #1 Bun runtime (`140d7d7`),
#2 session manager (`c6fecb0`), 3c-foundation (`a6ebdfe`), write-scoping
(`2b2526d`), gateway-id binding (`7f5bcbf`). Suite: 41. Deploy gate noted:
strict instances need the connector's service-token common_name in the map.

## Escalation log

_(none yet)_

## Deviations log

_(none yet)_
