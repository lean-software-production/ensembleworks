# Phase 0 spike battery

De-risks the Bun migration (docs/unified-architecture-design.md §7, Phase 0).
Each spike records its result in FINDINGS.md — pass or fail, with the exact
error verbatim on failure. A failed spike is a *completed* spike.

Requires Bun ≥ 1.3.14 (`bun --version`). Compiled outputs go to `dist/`
(git-ignored).

- Spike A: the sync server compiled with `bun build --compile`
- Spike B: the Vite client build driven by Bun
- Spike C: `@livekit/rtc-node` under Bun (import, runtime start, compiled)

(Spike D, Bun.Terminal PTY, already passed on 2026-07-04 — see
docs/unified-architecture-design.md §2.1.)
