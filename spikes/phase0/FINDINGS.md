# Phase 0 findings

| Spike | Result | Notes |
|---|---|---|
| A: compiled sync server | FAIL as-is; PASS with shim | compile OK (92M binary); boot fails — `node:sqlite` unsupported by Bun 1.3.14 (not `--compile`-specific). Addendum: with a 12-line `bun:sqlite` shim, health + ws-sync PASS; static needs explicit `CLIENT_DIST` (bundle-relative path breaks under `--compile`). See detail below. |
| B: Vite build under Bun | PASS (2026-07-05) | `bun --bun run build` (tsc --noEmit && vite build) exits 0; `dist/index.html` + hashed JS/CSS assets produced. See detail below. |
| C: rtc-node under Bun | PASS (2026-07-05) | import PASS (`Room: function`); runtime PASS — starts, imports rtc-node, fails at token-fetch with `ConnectionRefused` against the bogus URL (network-layer, not module-load); compiled PASS — `bun build --compile` embeds the 25 MB `rtc-node.linux-x64-gnu.node` addon, binary reaches the identical `ConnectionRefused` failure (verified runnable from a different cwd, confirming no external addon dependency). See detail below. |
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

## Spike C detail

Environment: `bun 1.3.14` (via mise), from `transcriber/` unless noted. `@livekit/rtc-node@0.13.29`
resolves (via npm workspace hoisting) to `node_modules/@livekit/rtc-node` +
`node_modules/@livekit/rtc-ffi-bindings-linux-x64-gnu/rtc-node.linux-x64-gnu.node` (25,300,032
bytes) at the repo root.

- **import** — PASS.
  ```
  $ bun -e 'const m = await import("@livekit/rtc-node"); console.log("Room:", typeof m.Room)'
  Room: function
  ```
  No napi/dlopen error — the native addon loads cleanly under the Bun runtime.

- **runtime start** — PASS, classified as a **network-layer failure**, not a module-load failure.
  ```
  $ CANVAS_URL=http://localhost:1 CANVAS_ROOM=spike timeout 15 bun src/transcriber.ts
  scribe failed to start: 53 | 		room: CANVAS_ROOM,
  54 | 		identity: SCRIBE_IDENTITY,
  55 | 		name: SCRIBE_NAME,
  56 | 		role: 'scribe',
  57 | 	})
  58 | 	const res = await fetch(`${CANVAS_URL}/api/livekit-token?${params}`)
                          ^
  error: Unable to connect. Is the computer able to access the url?
    path: "http://localhost:1/api/livekit-token?room=spike&identity=scribe&name=%F0%9F%93%9D+scribe&role=scribe",
   errno: 0,
    code: "ConnectionRefused"

        at async fetchToken (transcriber/src/transcriber.ts:58:20)
        at async main (transcriber/src/transcriber.ts:137:21)
  ```
  Exit code 1 (not the 124-idle case) — the process reached `fetchToken()`'s own `fetch()` call
  against the bogus `CANVAS_URL` and failed there. All the `@livekit/rtc-node` imports at the top
  of `transcriber.ts` (`Room`, `RoomEvent`, `TrackKind`, `AudioStream`) resolved without error
  before this point — the failure is plain Bun `fetch()` refusing a connection to
  `localhost:1`, not anything inside the native addon. rtc-node's own `room.connect()` is never
  reached in this scenario because `fetchToken()` (a sync-server HTTP call, unrelated to LiveKit)
  fails first — a property of this transcriber's startup sequence, not of rtc-node itself.

- **compiled binary** — PASS. This is the interesting result: the platform-specific native
  package bundles cleanly and the embedded addon dlopens correctly.
  ```
  $ bun build --compile transcriber/src/transcriber.ts --outfile spikes/phase0/dist/ew-transcriber
    [22ms]  bundle  128 modules
   [151ms] compile  spikes/phase0/dist/ew-transcriber
  ```
  Output binary: 120,617,088 bytes (~115 MB) — includes the 25 MB `.node` addon plus the Bun
  runtime and bundled JS. Running it against the same bogus URL:
  ```
  $ CANVAS_URL=http://localhost:1 CANVAS_ROOM=spike timeout 15 ./spikes/phase0/dist/ew-transcriber
  scribe failed to start: 17393 |   const params = new URLSearchParams({
  17394 |     room: CANVAS_ROOM,
  17395 |     identity: SCRIBE_IDENTITY,
  17396 |     name: SCRIBE_NAME,
  17397 |     role: "scribe"
  17398 |   const res = await fetch(`${CANVAS_URL}/api/livekit-token?${params}`);
                                   ^
  error: Unable to connect. Is the computer able to access the url?
    path: "http://localhost:1/api/livekit-token?room=spike&identity=scribe&name=%F0%9F%93%9D+scribe&role=scribe",
   errno: 0,
    code: "ConnectionRefused"

        at async fetchToken (/$bunfs/root/ew-transcriber:17398:26)
        at async main (/$bunfs/root/ew-transcriber:17472:32)
  ```
  Identical failure point and error shape to the source-run case — no dlopen error, no "unable to
  bundle platform package" error at build time. Re-ran from `/tmp` (a different cwd, outside the
  repo) to confirm the addon is truly embedded in the binary rather than loaded via a
  repo-relative path: same result, same `ConnectionRefused` at the same call site.

**Conclusion:** all three checks pass cleanly. `@livekit/rtc-node`'s native napi addon is fully
compatible with Bun 1.3.14, both as source-run-under-Bun and as a `bun build --compile` standalone
binary — no shims or workarounds were needed (unlike Spike A's `node:sqlite` gap). The transcriber
can ship as a compiled artifact.

## Spike B detail

Environment: `bun 1.3.14` (via mise). `rm -rf client/dist && cd client && bun --bun run build`.

- **build** — PASS, exit 0. `bun --bun run build` ran the package's own script (`tsc --noEmit && vite build`) with Bun forced as the JS runtime for both `tsc` and `vite`. tsc reported no type errors; Vite (v7.3.5) transformed 897 modules and emitted `dist/index.html`, `dist/assets/index-*.css` (83.77 kB), `dist/assets/sanitizeSvg-*.js` (7.32 kB), and `dist/assets/index-*.js` (2,925.81 kB) — the same file set/sizes as a Node build, just different content hashes. Vite's stock "chunk larger than 500 kB" warning appeared, as it does under Node; no Bun-specific warnings or errors.
- **output check** — PASS. `test -f client/dist/index.html` succeeded; `ls client/dist/assets` showed `index-*.js`, `index-*.css`, `sanitizeSvg-*.js`.
- **timing vs Node** — comparable, no meaningful difference. Bun run: `real 0m5.392s` (Vite reported "built in 3.49s"). Immediately after, a plain Node build (`npm run build --workspace=client`) took `real 0m4.722s` (Vite "built in 3.23s") on the same machine/cache state. Single-run numbers, within normal noise for this sample size — not a basis for a performance claim either way.
- **final `client/dist` state** — left populated by the last successful build (the Node comparison run above), so later spike tasks that expect `client/dist` to exist have it; contents are equivalent to the Bun-built output (same modules/sizes, different hashes).
