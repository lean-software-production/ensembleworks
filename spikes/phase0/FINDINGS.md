# Phase 0 findings

| Spike | Result | Notes |
|---|---|---|
| A: compiled sync server | FAIL as-is; PASS with shim | compile OK (92M binary); boot fails — `node:sqlite` unsupported by Bun 1.3.14 (not `--compile`-specific). Addendum: with a 12-line `bun:sqlite` shim, health + ws-sync PASS; static needs explicit `CLIENT_DIST` (bundle-relative path breaks under `--compile`). See detail below. |
| B: Vite build under Bun | PASS (2026-07-05) | `bun --bun run build` (tsc --noEmit && vite build) exits 0; `dist/index.html` + hashed JS/CSS assets produced. See detail below. |
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

## Spike B detail

Environment: `bun 1.3.14` (via mise). `rm -rf client/dist && cd client && bun --bun run build`.

- **build** — PASS, exit 0. `bun --bun run build` ran the package's own script (`tsc --noEmit && vite build`) with Bun forced as the JS runtime for both `tsc` and `vite`. tsc reported no type errors; Vite (v7.3.5) transformed 897 modules and emitted `dist/index.html`, `dist/assets/index-*.css` (83.77 kB), `dist/assets/sanitizeSvg-*.js` (7.32 kB), and `dist/assets/index-*.js` (2,925.81 kB) — the same file set/sizes as a Node build, just different content hashes. Vite's stock "chunk larger than 500 kB" warning appeared, as it does under Node; no Bun-specific warnings or errors.
- **output check** — PASS. `test -f client/dist/index.html` succeeded; `ls client/dist/assets` showed `index-*.js`, `index-*.css`, `sanitizeSvg-*.js`.
- **timing vs Node** — comparable, no meaningful difference. Bun run: `real 0m5.392s` (Vite reported "built in 3.49s"). Immediately after, a plain Node build (`npm run build --workspace=client`) took `real 0m4.722s` (Vite "built in 3.23s") on the same machine/cache state. Single-run numbers, within normal noise for this sample size — not a basis for a performance claim either way.
- **final `client/dist` state** — left populated by the last successful build (the Node comparison run above), so later spike tasks that expect `client/dist` to exist have it; contents are equivalent to the Bun-built output (same modules/sizes, different hashes).
