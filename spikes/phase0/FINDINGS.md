# Phase 0 findings

| Spike | Result | Notes |
|---|---|---|
| A: compiled sync server | FAIL | compile OK (92M binary); boot fails — `node:sqlite` unsupported by Bun 1.3.14 (not `--compile`-specific); ws-sync/static not run (server never started) |
| B: Vite build under Bun | _pending_ | |
| C: rtc-node under Bun | _pending_ | |
| D: Bun.Terminal PTY | PASS (2026-07-04) | see unified doc §2.1 |

## Spike A detail

Environment: `bun 1.3.14` (via mise), Node client build via plain `npm run build -w client`.

- **compile** — PASS. `bun build --compile server/src/sync-server.ts --outfile spikes/phase0/dist/ew-server` succeeded (24ms bundle, 142ms compile; 436 modules). Output binary: 92 MB, ELF 64-bit executable — within the expected 90–110 MB range.
- **health** — FAIL. Running the compiled binary (`DATA_DIR=$(mktemp -d) ./spikes/phase0/dist/ew-server`) crashes immediately with:
  ```
  error: No such built-in module: node:sqlite

  Bun v1.3.14 (Linux x64)
  ```
  No process remained after the crash (confirmed via `ps aux`), so `curl http://localhost:8788/api/health` could not connect (`curl: (7) Failed to connect to localhost port 8788`).

  This is not specific to `--compile`: running the same entrypoint directly via `bun run server/src/sync-server.ts` (uncompiled) produces the identical `No such built-in module: node:sqlite` error. Bun 1.3.14 does not implement `node:sqlite`, which `server/src/app.ts:29` imports (`import { DatabaseSync } from 'node:sqlite'`).
- **ws-sync** — NOT RUN. Server process never came up, so `server/src/smoke-client.ts` was not exercised.
- **static** — NOT RUN. Same reason; `curl http://localhost:8788/` was not attempted since the server was never listening.

**Conclusion:** the sync server cannot run under Bun 1.3.14 as-is because of the `node:sqlite` gap — this blocks the compiled-binary path entirely, independent of any `--compile`/bundling behavior. No server source was modified per spike rules.
