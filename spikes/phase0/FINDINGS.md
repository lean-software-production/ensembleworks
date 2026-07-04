# Phase 0 findings

| Spike | Result | Notes |
|---|---|---|
| A: compiled sync server | FAIL as-is; PASS with shim | compile OK (92M binary); boot fails — `node:sqlite` unsupported by Bun 1.3.14 (not `--compile`-specific). Addendum: with a 12-line `bun:sqlite` shim, health + ws-sync PASS; static needs explicit `CLIENT_DIST` (bundle-relative path breaks under `--compile`). See detail below. |
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

### Addendum (bun:sqlite shim) — throwaway experiment, source changes discarded

To get signal on the rest of the stack (express 5, `ws`, tldraw sync-core, static serving), a
throwaway 12-line shim was tried: `server/src/sqlite-compat.ts` exporting a `DatabaseSync` that
subclasses `bun:sqlite`'s `Database`, and `app.ts:29` switched to import from it. This works
because sync-core's `NodeSqliteWrapper` only calls `db.exec(sql)` / `db.prepare(sql)`, and
`SQLiteSyncStorage` only calls `.all()` / `.run()` / `.iterate()` on statements — all of which
`bun:sqlite` provides natively with compatible shapes. The shim and app.ts edit were discarded
after the experiment; only this file is committed.

- **compile** — PASS. Same command; 23ms bundle / 170ms compile, 437 modules, 92 MB binary.
- **health** — PASS. Binary boots with scratch `DATA_DIR`; `curl -fsS http://localhost:8788/api/health` → HTTP 200, body `{"ok":true,"rooms":[]}`. No extra env vars needed.
- **ws-sync** — PASS. `(cd server && npx tsx src/smoke-client.ts)` → `server replied: connect connectRequestId: r1 hydration type: wipe_presence`, exit 0. WS upgrade + sync-core + sqlite persistence all work inside the compiled bundle.
- **static** — FAIL by default, PASS with env override.
  - Default: `curl -fsS http://localhost:8788/` → `curl: (22) The requested URL returned error: 404` (body: `Cannot GET /`); server logged `client build: (not built — dev mode)`. Cause: `sync-server.ts:15` defaults `CLIENT_DIST` to `path.join(import.meta.dirname, '../../client/dist')`, and in the compiled binary `import.meta.dirname` points inside the bundle's virtual filesystem, so `existsSync` fails and static serving is skipped. **Phase-3 work item:** compiled binary must be given/derive a real on-disk client-dist path.
  - With `CLIENT_DIST=<repo>/client/dist` set: `curl -fsS http://localhost:8788/` → HTML starting `<!doctype html>`; the existing env escape hatch is sufficient.

**Addendum conclusion:** everything except `node:sqlite` works under a Bun-compiled binary. Phase 3
needs (1) a sqlite adapter (a trivial `bun:sqlite`-backed `DatabaseSync` shim suffices for the
methods sync-core uses) or a Bun release that ships `node:sqlite`, and (2) an explicit
`CLIENT_DIST` (or equivalent) for static serving, since bundle-relative path resolution breaks
under `--compile`.
