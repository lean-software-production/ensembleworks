# Plugin-architecture completion track — state

> Orchestration design: `docs/superpowers/specs/2026-07-06-plugin-architecture-track-design.md`.
> Charter: `docs/superpowers/specs/2026-07-06-plugin-architecture-track-charter.md` (pending).
> Updated after every slice merge. Branch: `unified-architecture-migration`.

## Slice queue

| # | Slice | Gate tier | Status | Merge | Notes |
|---|---|---|---|---|---|
| 0 | Charter | user sitting | ✅ done 2026-07-06 | — | 33 decisions mined (6-agent sweep); 7 user-arbitrated; rest pinned to recommendations |
| 1 | 3a clean routes | autonomous | ✅ merged 2026-07-06 | `1524708` | panel 2 rounds (r1: inventory gaps → fixed; r2: 2/2 pass); 6 tasks; suite stays 41; deviations: '// was' breadcrumbs stripped by Task-6 backstop; README route docs consciously stale (sweep in #4) |
| 2 | 3b tool manifest | autonomous | ✅ merged 2026-07-06 | `de6aaad` | panel 3/3 r1; envelope+plugin field escalated → user RATIFIED (charter ext.); suite 41→43; deviations: runtime pkg.json version read, process.exit(0) plan omission fixed after suite hang. Carry-forward for #4: some zodInputs stricter than handler coercion (CLI must not over-reject) |
| 3 | 3c attribution | autonomous | ✅ merged 2026-07-06 | `7885d2c` | panel 3/3 + fix round; final review caught a CRITICAL (anonymous roadmap meta.author forge via replace-op passthrough) — fixed `13599f2` (server always wins: stamp-or-delete) + forge/stale regressions; suite 43→45 |
| 4 | #4 ensembleworks CLI | **gated** | ✅ merged 2026-07-06 | `7bd9a50` | user gate passed (6 verb changes, Layer-2 in); 8 tasks; TWO security catches: implementer found+fixed plan's extension path-traversal (`69fc44a`), final review found+fixed backslash same-origin bypass (`855d5c6`); suite 45→52; SKILL.md×4 reseeded; bin/canvas + gateway-go stay until #8 |
| 5 | #5 connector | autonomous | ✅ merged 2026-07-07 | `1bcd655` | panel r1 blocker (initial-grid clamp lost) → fixed + r2 pass; 6 tasks; parity constants verified vs relay.go; connector-loopback e2e (real subprocess) green; final review found+fixed abort-listener leak on reconnect; suite 53→58. gateway-go still present, retires at #8 |
| 6 | #6 transcriber cutover | autonomous | ✅ merged 2026-07-06 | `cc80d06` | HARD GATE PASSED (--strict, in-container vs live dev stack): transcript "testing 1, 2, 3"; timings ms: preflight 5, publish-visible 187, connect→…→POST 4006, total 4198 — compiled binary, every hop proven, no Node fallback. Root-caused en route: rtc-node captureFrame drops Int16Array subarray views under Bun (copy fix + spec note). Suite 52→53 |
| 7 | #7 distribution | autonomous | ✅ merged 2026-07-07 | `8fd2f30` | panel r1 blocker (CI drops tldraw license key → blank prod canvas) → fixed + r2 pass; 8 tasks; compiled binaries boot-check green, fake-release.sh integration proof ALL PASS (byte-flip + truncated negatives), era guard + KillMode=process preserved; final review found+fixed BUILD_FROM_SOURCE reintroducing the same blank-canvas gap; release-termgw.yml retired; suite 58. #7/#8 boundary held — gateway-go/connect.sh/bin-canvas/node-pty/Node all still present |
| — | Phase-boundary review + remediation | autonomous | ✅ done 2026-07-07 | `eb6d6d5` | 4-lens review; keel lens caught BLOCKING broken data-load check (polled lazy /api/health) → fixed via EW_WARM_ROOMS eager load + test; also auth-posture boot log + AGENTS.md reseed; suite 58→59. Packet: `docs/superpowers/specs/2026-07-07-cutover-readiness-packet.md` |
| 8 | #8 cutover release | **manual (user)** | **READY — packet delivered, awaiting user** | — | see readiness packet: 3 operator prereqs (service-token, CF_ACCESS confirm, canvas render), 2 #8-must-do (devcontainer feature, skills topology), must-delete list |
| 9 | Phase 4: docStore + tools + /mcp | **gated** | queued | — | builds on branch regardless of #8 timing |
| 10 | ~~Phase 5: memory service~~ | — | **DEFERRED** (user, 2026-07-06) | — | out of track; embedding decisions parked in charter |
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

## Post-track slices (after the phase-boundary review)

| Slice | Gate tier | Status | Merge | Notes |
|---|---|---|---|---|
| ensembleworks-cli devcontainer feature | autonomous | ✅ merged 2026-07-07 | `18c3bf6` | #8-must-do #1 closed early: installs the CLI + runs `terminal connect`; panel 3/3 + r2; added a connector-side token scrub (canvasTmuxSpawnSpec strips ENSEMBLEWORKS_TOKEN_*/CF_ACCESS_CLIENT_* — net-new credential exposure the feature would otherwise ship) + 0600 baked env. gateway-go/termgw-feature retires at #8. Suite 59. |
