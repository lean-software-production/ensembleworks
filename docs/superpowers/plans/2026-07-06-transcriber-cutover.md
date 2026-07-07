# Transcriber cutover — env rename + a compiled binary that really `room.connect()`s (sub-project #6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two things land together inside `transcriber/`. (a) A **clean-break env
rename** — `CANVAS_URL`/`CANVAS_ROOM` → `ENSEMBLEWORKS_URL`/`ENSEMBLEWORKS_ROOM` —
extracted into a network-free, unit-tested resolver (`config.ts`) whose test pins
the **clean break** (the old names are ignored, not aliased). (b) The proof that
closes Spike C's one deferred question — a `bun build --compile` transcriber
**binary** (`dist/ensembleworks-transcriber`, embedded rtc-node addon) plus a live
**e2e gate harness** (`e2e-gate.ts`) that drives the *compiled* binary through a
real `room.connect()` → subscribe → segment → STT → `POST /api/scribe/transcript`
against a live LiveKit SFU, with **no Node fallback**. After the slice
`bun run typecheck`, `bun run build`, `bun run test` are green and the suite count
is **52 → 53** (one new network-free suite `transcriber/src/config.test.ts`; the
gate harness and its WAV fixture are **not** `*.test.ts` and are not discovered by
`scripts/run-tests.ts`).

**Spec:** `docs/superpowers/specs/2026-07-06-transcriber-cutover-design.md` —
panel-approved (3/3 + fix round); implement it exactly. Its `config.ts`, the
`transcriber.ts` rename, the `build:binary` script, the gate design (preflight,
self-check, compiled-scribe launch, `--strict` semantics), the fixture provenance
+ whisper pre-commit check, and the merge-evidence DoD are authoritative.
**Charter:** `docs/superpowers/specs/2026-07-06-plugin-architecture-track-charter.md`
— user decision 6 (the transcriber gate — no Node fallback; failure blocks + escalates)
and §"#5 — Connector / #6 — Transcriber" (env rename ONLY; the scribe is a
co-located localhost "none" worker with no service token).

**Scope boundary (from the spec — do not cross it):** #6 touches **only**
`transcriber/`. It does **not** change the STT/VAD/transcript pipeline
(`segmenter.ts`, `stt.ts`, `wav.ts`, `livekit-url.ts` and the `pumpTrack` /
`postTranscript` logic are untouched except a symbol rename), does **not** touch
any server route or wire shape, does **not** rename any env var other than the two
named (`STT_*`, `SCRIBE_*`, `LIVEKIT_URL` keep their names; the scribe gains **no**
`ENSEMBLEWORKS_TOKEN_ID/_TOKEN_SECRET`), does **not** edit systemd units, deploy
scripts, or `bin/dev` (verified: `bin/dev` never sets `CANVAS_*`), and compiles for
the **host arch only** (the cross-arch release matrix is #7's job).

---

## Environment & conventions (read before starting)

1. **Bun version.** The default PATH `bun` is too old. Before any `bun` command:
   ```bash
   export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
   bun --version   # must print 1.3.14
   ```
2. **Indentation: TABS** in all `transcriber/src/*` files (verified: `transcriber.ts`,
   `livekit-url.ts`, `stt.ts`, `livekit-url.test.ts` are all tab-indented). Every
   verbatim `.ts` block below is written with tabs; preserve them. `package.json`
   stays 2-space (its existing style).
3. **Imports use `.ts` extensions** — `./config.ts`, `./livekit-url.ts` (the
   existing transcriber convention).
4. **rtc-node version.** `@livekit/rtc-node` **0.13.30** is installed (spec cited
   0.13.29; the publish-path signatures below were re-verified against 0.13.30's
   `.d.ts`). `transcriber/tsconfig.json` sets `"types": ["node"]` and
   `noUncheckedIndexedAccess: true` — so the gate harness uses **`node:child_process`**
   (not `Bun.spawn`, which would need a bun-types tsconfig change) and indexes
   defensively. `node:child_process` `spawn` runs fine under Bun and keeps typecheck
   green with no tsconfig edit.
5. **Test convention.** Self-running `bun src/x.test.ts` scripts, discovered by
   `scripts/run-tests.ts`'s `**/src/**/*.test.ts` glob, ending `console.log('ok: …')`
   (mirrors `livekit-url.test.ts`). `config.test.ts` boots nothing (pure resolver) —
   no `process.exit(0)` needed.
6. **`dist/` is already git-ignored.** Root `.gitignore` line 2 is `dist/` (no leading
   slash → matches at any depth), so `transcriber/dist/` — the compiled binary — is
   ignored automatically. **No `.gitignore` edit is needed.** The WAV fixture lives in
   `transcriber/src/fixtures/` (not under `dist/`) and **is** committed.
7. **Commit trailer, exactly** (this repo's `git` runs through a direnv wrapper —
   commit exactly as shown):
   ```
   Co-Authored-By: Claude <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
   ```

### Gating policy — which gates apply per task vs at the end

- **Per task (Tasks 1–4): `bun run typecheck` MUST be green**, and any test suite a
  task names MUST be at the state the task declares (RED at a written-test checkpoint,
  GREEN at the task's end). These are the only gates run mid-plan.
- **No task leaves a red suite at its end.** A RED checkpoint is an explicit, momentary
  TDD step, driven to GREEN by the same task.
- **End only (Task 5): the full `bun run test` (`all 53 suites passed`),
  `bun run build`, and the live `--strict` gate as manual acceptance** (with the
  merge-evidence capture — Definition-of-Done).
- **The live gate is NOT a per-task gate.** It needs `bin/dev up` (a real SFU + whisper
  + sync server) and is the slice's manual acceptance step in Task 5. Tasks 1–4 never
  require an SFU.

---

## Task 1 — `config.ts` resolver + its unit test + the `transcriber.ts` rename (TDD: RED → GREEN)

Write the unit test **first** (it fails: no `config.ts` module), then author the
verbatim resolver to green, then thread it through `transcriber.ts` (a symbol rename
only — no control-flow change).

### Step 1 — Write the failing unit test

- [ ] **`transcriber/src/config.test.ts`** (create it). Pure `readScribeEndpoint`, no
  server boot; pins defaults, the new names, and the **clean break** (old names
  ignored). TABS.
  ```ts
  // Rename guard for the scribe's sync-server endpoint resolver (network-free).
  // Pins the clean break: ENSEMBLEWORKS_URL/_ROOM only; the pre-cutover
  // CANVAS_URL/CANVAS_ROOM names are gone, not aliased. Run with: bun src/config.test.ts
  import assert from 'node:assert/strict'
  import { readScribeEndpoint } from './config.ts'

  // Defaults — the pre-cutover fallbacks are unchanged (regression guard).
  assert.deepEqual(readScribeEndpoint({}), { url: 'http://localhost:8788', room: 'team' })

  // New names honoured.
  assert.deepEqual(
  	readScribeEndpoint({ ENSEMBLEWORKS_URL: 'http://sync.test:9', ENSEMBLEWORKS_ROOM: 'demo' }),
  	{ url: 'http://sync.test:9', room: 'demo' },
  )

  // Clean break (the load-bearing case): the old names are IGNORED — no alias survives.
  assert.deepEqual(
  	readScribeEndpoint({ CANVAS_URL: 'http://old:1', CANVAS_ROOM: 'old' }),
  	{ url: 'http://localhost:8788', room: 'team' },
  )

  // New wins when both are set (ENSEMBLEWORKS_URL unset here → default; room is new).
  assert.deepEqual(
  	readScribeEndpoint({ ENSEMBLEWORKS_ROOM: 'demo', CANVAS_ROOM: 'old' }),
  	{ url: 'http://localhost:8788', room: 'demo' },
  )

  console.log('ok: config — ENSEMBLEWORKS_URL/_ROOM resolve, defaults hold, CANVAS_* ignored (clean break)')
  ```

- [ ] **RED checkpoint — run it, expect failure (no resolver module yet):**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd transcriber && bun src/config.test.ts)
  ```
  Expected: **fails** — `Cannot find module './config.ts'`. This is the RED state;
  Step 2 turns it green.

### Step 2 — Write the resolver (verbatim from spec)

- [ ] **`transcriber/src/config.ts`** (create it — exactly the spec's resolver block).
  TABS.
  ```ts
  /**
   * Resolve the scribe's sync-server connection from the environment. Clean break
   * (charter #6): the scribe reads ENSEMBLEWORKS_URL / ENSEMBLEWORKS_ROOM only —
   * the pre-cutover CANVAS_URL / CANVAS_ROOM names are gone, not aliased. Kept
   * pure (env in, config out) so the rename is unit-tested without a network.
   */
  export interface ScribeEndpoint {
  	/** Sync server base URL — token fetch + transcript POST. */
  	url: string
  	/** Room the scribe transcribes. */
  	room: string
  }

  export function readScribeEndpoint(env: Record<string, string | undefined>): ScribeEndpoint {
  	return {
  		url: env.ENSEMBLEWORKS_URL ?? 'http://localhost:8788',
  		room: env.ENSEMBLEWORKS_ROOM ?? 'team',
  	}
  }
  ```

- [ ] **GREEN checkpoint — the unit test passes:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd transcriber && bun src/config.test.ts)
  ```
  Expected: prints
  `ok: config — ENSEMBLEWORKS_URL/_ROOM resolve, defaults hold, CANVAS_* ignored (clean break)`
  and exits 0.

### Step 3 — Thread the resolver through `transcriber.ts` (symbol rename only)

Five edits, in order. Edits A and C remove every literal `CANVAS_*`; edits D and E
then blanket-rename the remaining references (all now the internal role names). No
control flow changes.

- [ ] **Edit A — docblock `Environment:` block.** Replace:
  ```ts
   *   CANVAS_URL    sync server (default http://localhost:8788)
   *   CANVAS_ROOM   room to scribe (default team)
  ```
  with:
  ```ts
   *   ENSEMBLEWORKS_URL    sync server (default http://localhost:8788)
   *   ENSEMBLEWORKS_ROOM   room to scribe (default team)
  ```
  (`STT_*`, `SCRIBE_*` docblock lines stay verbatim.)

- [ ] **Edit B — add the resolver import.** Replace:
  ```ts
  import { resolveScribeConnectUrl } from './livekit-url.ts'
  import { createSegmenter } from './segmenter.ts'
  ```
  with:
  ```ts
  import { readScribeEndpoint } from './config.ts'
  import { resolveScribeConnectUrl } from './livekit-url.ts'
  import { createSegmenter } from './segmenter.ts'
  ```

- [ ] **Edit C — replace the two module-level consts with one resolver call.** Replace:
  ```ts
  const CANVAS_URL = process.env.CANVAS_URL ?? 'http://localhost:8788'
  const CANVAS_ROOM = process.env.CANVAS_ROOM ?? 'team'
  ```
  with:
  ```ts
  const { url: SYNC_URL, room: SYNC_ROOM } = readScribeEndpoint(process.env)
  ```

- [ ] **Edit D — rename the three remaining `CANVAS_ROOM` reads (replace-all).** After
  edits A + C the only remaining `CANVAS_ROOM` tokens are the log prefix, the
  `fetchToken` query param, and the `postTranscript` body — three occurrences.
  Replace-all `CANVAS_ROOM` → `SYNC_ROOM`. Confirm the three sites become:
  ```ts
  const log = (...args: unknown[]) => console.log(`[scribe ${SYNC_ROOM}]`, ...args)
  ```
  ```ts
  		room: SYNC_ROOM,
  		identity: SCRIBE_IDENTITY,
  ```
  ```ts
  			room: SYNC_ROOM,
  			identity: participant.identity,
  ```

- [ ] **Edit E — rename the three remaining `CANVAS_URL` reads (replace-all).** After
  edits A + C the only remaining `CANVAS_URL` tokens are the `fetchToken` fetch, the
  `postTranscript` fetch, and the startup banner — three occurrences. Replace-all
  `CANVAS_URL` → `SYNC_URL`. Confirm the three sites become:
  ```ts
  	const res = await fetch(`${SYNC_URL}/api/av/token?${params}`)
  ```
  ```ts
  	const res = await fetch(`${SYNC_URL}/api/scribe/transcript`, {
  ```
  ```ts
  	log(`connected to ${info.url} as ${SCRIBE_NAME}; posting to ${SYNC_URL}`)
  ```

### Step 4 — GREEN gate

- [ ] **Confirm the clean break, then typecheck + regression:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  # No CANVAS_* anywhere in transcriber/ (must print nothing):
  grep -rn 'CANVAS_URL\|CANVAS_ROOM' transcriber/ || echo 'clean break confirmed: no CANVAS_* left'
  bun run typecheck
  (cd transcriber && bun src/config.test.ts)
  (cd transcriber && bun src/livekit-url.test.ts)
  ```
  Expected: the grep prints `clean break confirmed: no CANVAS_* left`; `bun run typecheck`
  exits 0; `config.test.ts` prints its `ok:` line; `livekit-url.test.ts` prints
  `livekit-url.test.ts: all tests passed` (unchanged regression guard).

- [ ] **Commit:**
  ```bash
  git add transcriber/src/config.ts transcriber/src/config.test.ts transcriber/src/transcriber.ts
  git commit -m "$(cat <<'EOF'
  feat(transcriber): rename CANVAS_* → ENSEMBLEWORKS_* via a tested resolver (slice #6)

  New transcriber/src/config.ts (readScribeEndpoint) is the one place the scribe's
  two sync-connection env vars are read — ENSEMBLEWORKS_URL / ENSEMBLEWORKS_ROOM
  only; the pre-cutover CANVAS_URL / CANVAS_ROOM names are a clean break, gone not
  aliased. transcriber.ts consumes it (local role names SYNC_URL / SYNC_ROOM) — a
  symbol rename with no control-flow change; docblock + startup banner updated. A
  network-free unit test pins defaults, the new names, and the clean break (old
  names ignored). Suite 52 → 53.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 2 — The `build:binary` script + a no-SFU boot probe

Add the compile script and prove it yields a runnable, host-arch binary with the
embedded rtc-node addon. `room.connect()` is **not** exercised here — that is the
Task 4 gate. This task needs no SFU.

### Step 1 — Add the script

- [ ] **`transcriber/package.json`** — add `build:binary` to `scripts` (2-space JSON).
  Replace:
  ```json
    "scripts": {
      "dev": "bun --watch src/transcriber.ts",
      "start": "bun src/transcriber.ts",
      "build": "bunx tsc --noEmit",
      "typecheck": "bunx tsc --noEmit"
    },
  ```
  with:
  ```json
    "scripts": {
      "dev": "bun --watch src/transcriber.ts",
      "start": "bun src/transcriber.ts",
      "build:binary": "bun build --compile --sourcemap src/transcriber.ts --outfile dist/ensembleworks-transcriber",
      "build": "bunx tsc --noEmit",
      "typecheck": "bunx tsc --noEmit"
    },
  ```
  (`build:binary` is separate from `build`; it is **not** wired into the root
  `build`/`test`, so `bun run build` stays fast and hermetic. Host-arch only — no
  `--target`; the cross-arch matrix is #7.)

### Step 2 — Build + boot probe (no SFU / no server)

- [ ] **Compile the binary and confirm it launches, loads its embedded runtime, and
  fails only at the network step:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun --cwd transcriber run build:binary
  test -x transcriber/dist/ensembleworks-transcriber && echo 'binary built + executable'

  # Boot probe: point the binary at an unreachable sync URL (port 1). It must
  # launch, run main(), and fail ONLY at the token fetch (ECONNREFUSED) — proving
  # no compile/link/startup crash and that the embedded rtc-node import loaded.
  # room.connect() is NOT reached (the token fetch fails first) — that is Task 4.
  timeout 15s env ENSEMBLEWORKS_URL=http://127.0.0.1:1 \
    transcriber/dist/ensembleworks-transcriber 2>&1 | head -5 || true
  ```
  Expected: `binary built + executable`, then a line beginning
  `scribe failed to start:` followed by a connection error (e.g. `ConnectionRefused`
  / `ECONNREFUSED` / `Unable to connect`). **No** `dlopen` / `cannot find module` /
  napi error, and no hang (the probe returns within the 15 s guard). This re-confirms
  Spike C's compiled-launch + embedded-addon result for the freshly built artifact.

- [ ] **Commit** (the `dist/` binary is git-ignored; only `package.json` is staged):
  ```bash
  git add transcriber/package.json
  git commit -m "$(cat <<'EOF'
  feat(transcriber): add build:binary (bun build --compile) for the scribe (slice #6)

  build:binary compiles a host-arch, sourcemapped standalone binary
  dist/ensembleworks-transcriber with the embedded @livekit/rtc-node addon. Kept
  separate from the hermetic `build` (tsc --noEmit) and out of the root build/test,
  so `bun run build` stays fast and offline; the e2e gate invokes build:binary on
  demand. dist/ is already git-ignored. A no-SFU boot probe confirms the artifact
  launches and fails only at the network step (room.connect is the Task 4 gate).

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 3 — The gate speech fixture (generate + whisper-verify, then commit)

A short, clear, mono 16 kHz PCM16 spoken-word clip that the segmenter's energy VAD
trips on and `whisper-base` reliably transcribes to **non-empty** text. **An unverified
fixture bakes a never-passing gate into the repo (spec R6) — the whisper check below is
mandatory before commit.**

### Step 1 — Generate the WAV (named-TTS provenance)

- [ ] **Generate with `espeak-ng` piped through `ffmpeg`** (host or devcontainer — needs
  `espeak-ng` + `ffmpeg`):
  ```bash
  mkdir -p transcriber/src/fixtures
  espeak-ng -v en -s 140 'testing testing one two three' --stdout \
    | ffmpeg -y -i - -ar 16000 -ac 1 -c:a pcm_s16le transcriber/src/fixtures/gate-speech.wav
  ```
  (macOS alternative: `say -o /tmp/s.aiff 'testing testing one two three'` then
  `ffmpeg -y -i /tmp/s.aiff -ar 16000 -ac 1 -c:a pcm_s16le transcriber/src/fixtures/gate-speech.wav`.
  Or a clean human recording downsampled the same way. Provenance must be real
  speech, not a tone.)

- [ ] **Confirm the format is exactly 16 kHz mono PCM16, ~2–4 s:**
  ```bash
  ffprobe -v error -show_entries stream=codec_name,sample_rate,channels \
    -show_entries format=duration -of default=noprint_wrappers=1 \
    transcriber/src/fixtures/gate-speech.wav
  ```
  Expected: `codec_name=pcm_s16le`, `sample_rate=16000`, `channels=1`, `duration`
  roughly `2`–`4`. (The harness's WAV reader asserts 16 kHz mono 16-bit and refuses
  anything else.)

### Step 2 — Whisper verification (mandatory; requires the dev whisper-server)

- [ ] **Bring the dev stack up (whisper-server lives inside the devcontainer) and confirm
  a NON-EMPTY transcription:**
  ```bash
  bin/dev up   # from the repo root — starts the devcontainer stack incl. whisper :8091
  curl -sS -F file=@transcriber/src/fixtures/gate-speech.wav -F model=whisper-1 \
    http://localhost:8091/v1/audio/transcriptions
  ```
  Expected: JSON like `{"text":"testing testing one two three"}` with **non-empty**
  `text` (wording may vary — whisper-base is non-deterministic; the gate asserts
  non-empty, not exact words). If `text` is empty or whitespace, **do not commit** —
  regenerate a clearer / slightly longer clip and re-verify. If whisper `:8091` is
  unreachable, the stack is not up: run `bin/dev up` first. There is **no** "commit
  unverified" path — an unhearable fixture is a gate that can never pass.

### Step 3 — Commit the verified fixture

- [ ] **Commit** (the fixture is a small binary asset under `src/fixtures/`, ~tens of
  KB — accepted per spec R6; it is not under `dist/`, so it is committed):
  ```bash
  git add transcriber/src/fixtures/gate-speech.wav
  git commit -m "$(cat <<'EOF'
  test(transcriber): add whisper-verified gate speech fixture (slice #6)

  transcriber/src/fixtures/gate-speech.wav — a short clear mono 16 kHz PCM16
  spoken-word clip ("testing testing one two three"), generated via espeak-ng |
  ffmpeg. Verified before commit against the dev whisper-server
  (POST /v1/audio/transcriptions) to return a non-empty transcription, so the e2e
  gate cannot be seeded with an unhearable fixture (spec R6). Small binary asset,
  kept out of the compiled binary and out of `bun run build`.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 4 — The live e2e gate harness `e2e-gate.ts`

The charter's hard acceptance test. It (a) never flakes `bun run test` (not a
`*.test.ts`; default mode skips loud + exit 0 when the SFU/STT/sync preflight misses),
and (b) with `--strict` on the dev stack, drives the **compiled** binary end-to-end and
fails loud on any break. A harness-side self-check confirms the synthetic speaker's
**publish** path (first exercised under Bun here) before the scribe launches, so a
publish failure diagnoses as harness-side, not as the charter gate failing.

### Step 1 — Write the harness (complete, verbatim)

- [ ] **`transcriber/src/e2e-gate.ts`** (create it — TABS). Signatures verified against
  `@livekit/rtc-node` 0.13.30: `new AudioSource(sampleRate, numChannels)`;
  `LocalAudioTrack.createAudioTrack(name, source)`;
  `localParticipant.publishTrack(track, options)` with a **required**
  `TrackPublishOptions` (protobuf-es `Message`; `source?: TrackSource`);
  `source.captureFrame(new AudioFrame(data, sampleRate, channels, samplesPerChannel))`
  returns a `Promise` (backpressure — awaited); `room.connect(url, token, { autoSubscribe, dynacast })`
  (both fields required); `room.remoteParticipants: Map<string, RemoteParticipant>`;
  `participant.trackPublications: Map<string, TrackPublication>` with `pub.kind`.
  ```ts
  /**
   * Live e2e gate for the transcriber cutover (Phase 3, sub-project #6).
   *
   * Proves the charter's hard acceptance test (user decision 6): the COMPILED
   * binary dist/ensembleworks-transcriber completes a real room.connect() →
   * subscribe → segment → STT → POST /api/scribe/transcript against a live
   * LiveKit SFU, with NO Node fallback. Spike C proved import + compiled launch +
   * embedded addon; this harness is the first to drive room.connect() FROM the
   * binary, and the first to drive rtc-node's PUBLISH path under Bun.
   *
   * NOT a *.test.ts — scripts/run-tests.ts (glob **\/src\/**\/*.test.ts) never
   * discovers it, so `bun run test` stays offline and flake-free.
   *
   * Modes:
   *   bun src/e2e-gate.ts           default: SKIP loud + exit 0 if a prerequisite
   *                                 (sync / SFU / STT) is missing; run the pipeline
   *                                 when preflight passes.
   *   bun src/e2e-gate.ts --strict  a missing prerequisite is a FAILURE (exit 1),
   *                                 so an acceptance run cannot pass by skipping.
   *
   * Manual acceptance (see the plan / spec):
   *   bin/dev up
   *   bun --cwd transcriber run build:binary
   *   bun transcriber/src/e2e-gate.ts --strict
   */
  import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
  import { existsSync, readFileSync } from 'node:fs'
  import path from 'node:path'
  import { fileURLToPath } from 'node:url'
  import {
  	AudioFrame,
  	AudioSource,
  	LocalAudioTrack,
  	Room,
  	TrackKind,
  	TrackPublishOptions,
  	TrackSource,
  } from '@livekit/rtc-node'
  import { resolveScribeConnectUrl } from './livekit-url.ts'

  // ---- constants ----------------------------------------------------------
  const GATE_ROOM = 'gate-e2e' // throwaway; never `team`, so the dev scribe can't collide
  const SPEAKER_IDENTITY = 'gate-speaker'
  const CHECKER_IDENTITY = 'gate-checker'
  const SCRIBE_UNDER_TEST_IDENTITY = 'scribe-gate'
  const SAMPLE_RATE = 16_000
  const CHANNELS = 1
  const FRAME_MS = 20 // 20 ms publish frames (320 samples @ 16 kHz)
  const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000
  const GAP_MS = 500 // silence between fixture loops so the VAD sees discrete utterances
  const PUBLISH_VISIBLE_TIMEOUT_MS = 20_000
  const TRANSCRIPT_TIMEOUT_MS = 90_000
  const POLL_MS = 2_000

  const here = path.dirname(fileURLToPath(import.meta.url))
  const transcriberRoot = path.join(here, '..')
  const binaryPath = path.join(transcriberRoot, 'dist', 'ensembleworks-transcriber')
  const fixturePath = path.join(here, 'fixtures', 'gate-speech.wav')

  const strict = process.argv.includes('--strict')
  const SYNC_URL = process.env.ENSEMBLEWORKS_URL ?? 'http://localhost:8788'

  // ---- tiny helpers -------------------------------------------------------
  const now = () => Date.now()
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  const log = (...a: unknown[]) => console.log('[gate]', ...a)

  interface TranscriptEntry {
  	identity: string
  	name: string
  	text: string
  	t: number
  }

  /** Decode a mono 16-bit PCM WAV into its Int16 samples (skips non-`data` chunks). */
  function readWavPcm16(file: string): { samples: Int16Array; sampleRate: number; channels: number } {
  	const buf = readFileSync(file)
  	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  	const tag = (off: number) =>
  		String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3))
  	if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error(`${file}: not a RIFF/WAVE file`)
  	let channels = 0
  	let sampleRate = 0
  	let bitsPerSample = 0
  	let dataOff = -1
  	let dataLen = 0
  	let off = 12
  	while (off + 8 <= view.byteLength) {
  		const id = tag(off)
  		const size = view.getUint32(off + 4, true)
  		const body = off + 8
  		if (id === 'fmt ') {
  			channels = view.getUint16(body + 2, true)
  			sampleRate = view.getUint32(body + 4, true)
  			bitsPerSample = view.getUint16(body + 14, true)
  		} else if (id === 'data') {
  			dataOff = body
  			dataLen = size
  		}
  		off = body + size + (size % 2) // chunks are word-aligned
  	}
  	if (dataOff < 0) throw new Error(`${file}: no data chunk`)
  	if (bitsPerSample !== 16) throw new Error(`${file}: expected 16-bit PCM, got ${bitsPerSample}`)
  	const count = Math.floor(dataLen / 2)
  	const samples = new Int16Array(count)
  	for (let i = 0; i < count; i++) samples[i] = view.getInt16(dataOff + i * 2, true)
  	return { samples, sampleRate, channels }
  }

  /** Fetch a role token from the sync server for GATE_ROOM. */
  async function fetchToken(identity: string, role: 'member' | 'scribe'): Promise<{ url: string; token: string }> {
  	const params = new URLSearchParams({ room: GATE_ROOM, identity, name: identity, role })
  	const res = await fetch(`${SYNC_URL}/api/av/token?${params}`)
  	if (!res.ok) throw new Error(`token endpoint ${res.status}`)
  	const info = (await res.json()) as { enabled?: boolean; url?: string; token?: string }
  	if (!info.enabled || !info.url || !info.token) throw new Error('LiveKit not enabled on the sync server')
  	const url = resolveScribeConnectUrl(info.url, process.env.LIVEKIT_URL)
  	if (!url) throw new Error('could not resolve an SFU URL')
  	return { url, token: info.token }
  }

  // ---- preflight ----------------------------------------------------------
  interface Preflight {
  	missing: string[]
  	sfuUrl: string | null
  }

  async function preflight(): Promise<Preflight> {
  	const missing: string[] = []
  	let sfuUrl: string | null = null

  	// 1. Sync server health.
  	try {
  		const res = await fetch(`${SYNC_URL}/api/health`)
  		if (!res.ok) missing.push(`sync server /api/health returned ${res.status}`)
  	} catch (err) {
  		missing.push(`sync server unreachable at ${SYNC_URL} (${(err as Error).message})`)
  	}

  	// 2. LiveKit configured — a scribe-role token that carries an SFU url.
  	try {
  		const params = new URLSearchParams({ room: GATE_ROOM, identity: 'gate-preflight', role: 'scribe' })
  		const res = await fetch(`${SYNC_URL}/api/av/token?${params}`)
  		const info = (await res.json()) as { enabled?: boolean; url?: string; token?: string }
  		if (!res.ok || !info.enabled || !info.url || !info.token) {
  			missing.push('LiveKit is not configured on the sync server (token endpoint disabled)')
  		} else {
  			sfuUrl = resolveScribeConnectUrl(info.url, process.env.LIVEKIT_URL) ?? null
  			if (!sfuUrl) missing.push('could not resolve an SFU URL from the token endpoint / LIVEKIT_URL')
  		}
  	} catch (err) {
  		missing.push(`token endpoint failed (${(err as Error).message})`)
  	}

  	// 3. STT backend (the dev stack sets STT_URL=http://localhost:8091/v1).
  	if (!process.env.STT_URL && !process.env.STT_API_KEY) {
  		missing.push('neither STT_URL nor STT_API_KEY is set — the scribe has no STT backend')
  	}

  	return { missing, sfuUrl }
  }

  // ---- synthetic speaker (publish under Bun — first exercised here) --------
  /** Connect the synthetic speaker and loop the fixture until `signal` aborts. */
  async function startSpeaker(sfuUrl: string, signal: AbortSignal): Promise<Room> {
  	const { token } = await fetchToken(SPEAKER_IDENTITY, 'member')
  	const room = new Room()
  	await room.connect(sfuUrl, token, { autoSubscribe: false, dynacast: false })

  	const source = new AudioSource(SAMPLE_RATE, CHANNELS)
  	const track = LocalAudioTrack.createAudioTrack('gate-speech', source)
  	// publishTrack takes a REQUIRED TrackPublishOptions second arg.
  	await room.localParticipant!.publishTrack(
  		track,
  		new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
  	)

  	const { samples, sampleRate, channels } = readWavPcm16(fixturePath)
  	if (sampleRate !== SAMPLE_RATE || channels !== CHANNELS) {
  		throw new Error(`fixture must be ${SAMPLE_RATE} Hz mono; got ${sampleRate} Hz / ${channels}ch`)
  	}
  	const silence = new Int16Array((SAMPLE_RATE * GAP_MS) / 1000)

  	// Background pump: feed 20 ms frames, AWAITING captureFrame — its resolved
  	// promise is the backpressure that keeps the loop real-time. An un-awaited
  	// tight loop overruns the source's queue and mispaces the WAV, so the audio
  	// arrives as a garbled burst and the VAD never sees clean utterances.
  	void (async () => {
  		try {
  			while (!signal.aborted) {
  				for (let i = 0; i < samples.length && !signal.aborted; i += FRAME_SAMPLES) {
  					const chunk = samples.subarray(i, Math.min(i + FRAME_SAMPLES, samples.length))
  					await source.captureFrame(new AudioFrame(chunk, SAMPLE_RATE, CHANNELS, chunk.length))
  				}
  				for (let i = 0; i < silence.length && !signal.aborted; i += FRAME_SAMPLES) {
  					const chunk = silence.subarray(i, Math.min(i + FRAME_SAMPLES, silence.length))
  					await source.captureFrame(new AudioFrame(chunk, SAMPLE_RATE, CHANNELS, chunk.length))
  				}
  			}
  		} catch (err) {
  			if (!signal.aborted) log('speaker pump error:', err)
  		}
  	})()

  	return room
  }

  // ---- harness self-check: publish visible BEFORE the scribe launches ------
  /** Confirm the speaker's audio publication is visible to a subscribe-only peer. */
  async function confirmPublishVisible(sfuUrl: string): Promise<void> {
  	const { token } = await fetchToken(CHECKER_IDENTITY, 'scribe')
  	const checker = new Room()
  	await checker.connect(sfuUrl, token, { autoSubscribe: false, dynacast: false })
  	try {
  		const deadline = now() + PUBLISH_VISIBLE_TIMEOUT_MS
  		const seen = () =>
  			[...checker.remoteParticipants.values()].some(
  				(p) =>
  					p.identity === SPEAKER_IDENTITY &&
  					[...p.trackPublications.values()].some((pub) => pub.kind === TrackKind.KIND_AUDIO),
  			)
  		while (now() < deadline) {
  			if (seen()) return
  			await sleep(250)
  		}
  		throw new Error(
  			`harness-side: ${SPEAKER_IDENTITY}'s audio track never became visible within ` +
  				`${PUBLISH_VISIBLE_TIMEOUT_MS / 1000}s — publish path under Bun, NOT the scribe under test`,
  		)
  	} finally {
  		await checker.disconnect()
  	}
  }

  // ---- scribe under test = the COMPILED binary ----------------------------
  function launchScribe(): ChildProcess {
  	if (!existsSync(binaryPath)) {
  		log(`compiled binary missing at ${binaryPath} — building it (bun run build:binary)`)
  		const built = spawnSync(
  			'bun',
  			['build', '--compile', '--sourcemap', 'src/transcriber.ts', '--outfile', 'dist/ensembleworks-transcriber'],
  			{ cwd: transcriberRoot, stdio: 'inherit' },
  		)
  		if (built.status !== 0) throw new Error('build:binary failed')
  	}
  	const child = spawn(binaryPath, [], {
  		env: {
  			...process.env,
  			ENSEMBLEWORKS_URL: SYNC_URL,
  			ENSEMBLEWORKS_ROOM: GATE_ROOM,
  			SCRIBE_IDENTITY: SCRIBE_UNDER_TEST_IDENTITY,
  		},
  		stdio: ['ignore', 'pipe', 'pipe'],
  	})
  	child.stdout?.on('data', (b: Buffer) => process.stdout.write(`[scribe-under-test] ${b}`))
  	child.stderr?.on('data', (b: Buffer) => process.stderr.write(`[scribe-under-test] ${b}`))
  	return child
  }

  // ---- assert: a transcript line from the speaker lands --------------------
  async function waitForTranscript(sinceMs: number): Promise<TranscriptEntry> {
  	const deadline = now() + TRANSCRIPT_TIMEOUT_MS
  	while (now() < deadline) {
  		const params = new URLSearchParams({ room: GATE_ROOM, since: String(sinceMs) })
  		const res = await fetch(`${SYNC_URL}/api/scribe/transcript?${params}`)
  		if (res.ok) {
  			const body = (await res.json()) as { entries?: TranscriptEntry[] }
  			const hit = (body.entries ?? []).find((e) => e.identity === SPEAKER_IDENTITY && e.text.trim() !== '')
  			if (hit) return hit
  		}
  		await sleep(POLL_MS)
  	}
  	throw new Error(
  		`no transcript line from ${SPEAKER_IDENTITY} within ${TRANSCRIPT_TIMEOUT_MS / 1000}s — ` +
  			`the compiled scribe did not complete connect→subscribe→segment→STT→POST`,
  	)
  }

  // ---- main ---------------------------------------------------------------
  async function main(): Promise<number> {
  	const t0 = now()
  	log(`mode: ${strict ? 'STRICT (missing prereq ⇒ FAIL)' : 'default (missing prereq ⇒ SKIP + exit 0)'}`)
  	log(`sync ${SYNC_URL}; room ${GATE_ROOM}; binary ${binaryPath}`)

  	const pf = await preflight()
  	if (pf.missing.length > 0 || !pf.sfuUrl) {
  		const lines = pf.missing.length ? pf.missing : ['SFU URL unresolved']
  		if (strict) {
  			console.error('\n================ GATE FAIL (--strict) ================')
  			console.error('Prerequisites missing — a strict acceptance run must not skip:')
  			for (const m of lines) console.error(`  - ${m}`)
  			console.error('Bring the dev stack up first:  bin/dev up')
  			console.error('======================================================\n')
  			return 1
  		}
  		console.log('\n================ GATE SKIP (no --strict) ================')
  		console.log('Prerequisites absent — skipping the live gate (expected off the dev stack):')
  		for (const m of lines) console.log(`  - ${m}`)
  		console.log('To actually run the gate:  bin/dev up  &&  bun --cwd transcriber run build:binary')
  		console.log('  then:  bun transcriber/src/e2e-gate.ts --strict')
  		console.log('=========================================================\n')
  		return 0
  	}
  	const sfuUrl = pf.sfuUrl
  	const tPreflight = now()
  	log(`preflight OK (${tPreflight - t0} ms); SFU ${sfuUrl}`)

  	const abort = new AbortController()
  	let speaker: Room | null = null
  	let scribe: ChildProcess | null = null
  	let code = 1
  	try {
  		// 1. Synthetic speaker publishes the looped fixture.
  		speaker = await startSpeaker(sfuUrl, abort.signal)
  		log(`speaker connected + publishing '${path.basename(fixturePath)}' (looped)`)

  		// 1b. Harness self-check — publish visible BEFORE the scribe launches.
  		await confirmPublishVisible(sfuUrl)
  		const tVisible = now()
  		log(`self-check OK: ${SPEAKER_IDENTITY}'s track is visible (${tVisible - tPreflight} ms)`)

  		// 2. Scribe under test = the COMPILED binary.
  		const sinceMs = now()
  		scribe = launchScribe()
  		log(`scribe-under-test launched (pid ${scribe.pid}); polling transcript for room ${GATE_ROOM}`)

  		// 3. Assert a transcript line lands.
  		const hit = await waitForTranscript(sinceMs)
  		const tHit = now()

  		console.log('\n================ GATE PASS ================')
  		console.log(`transcript from ${SPEAKER_IDENTITY}: ${JSON.stringify(hit.text)}`)
  		console.log('timings (ms):')
  		console.log(`  preflight            ${tPreflight - t0}`)
  		console.log(`  publish-visible      ${tVisible - tPreflight}`)
  		console.log(`  connect→…→POST       ${tHit - sinceMs}`)
  		console.log(`  total                ${tHit - t0}`)
  		console.log('every hop proven: connect (binary joined the SFU), subscribe, segment')
  		console.log('(VAD), STT (non-empty), POST /api/scribe/transcript.')
  		console.log('==========================================\n')
  		code = 0
  	} catch (err) {
  		console.error('\n================ GATE FAIL ================')
  		console.error((err as Error).message)
  		console.error('==========================================\n')
  		code = 1
  	} finally {
  		abort.abort()
  		if (scribe) scribe.kill('SIGTERM')
  		if (speaker) await speaker.disconnect().catch(() => {})
  	}
  	return code
  }

  main().then(
  	(code) => process.exit(code),
  	(err) => {
  		console.error('gate harness crashed:', err)
  		process.exit(1)
  	},
  )
  ```

### Step 2 — Typecheck gate (offline; the live run is Task 5)

- [ ] **Confirm the harness typechecks under the transcriber tsconfig, and that it is
  NOT discovered by the test runner:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun run typecheck
  # e2e-gate.ts must NOT match the *.test.ts glob (must print nothing):
  bun -e "const g=new (require('bun').Glob)('**/src/**/*.test.ts'); for (const f of g.scanSync('.')) if (f.includes('e2e-gate')) console.log('LEAK:',f)" \
    || echo 'not a test file — good'
  ```
  Expected: `bun run typecheck` exits 0 (the harness compiles clean under
  `types: ["node"]` + `noUncheckedIndexedAccess`); the glob probe prints nothing about
  `e2e-gate` (it is not a `*.test.ts`, so `bun run test` never runs it).

  > **Do NOT run `bun src/e2e-gate.ts` here without the dev stack** unless you intend
  > the default SKIP path. Off the stack it prints the loud `GATE SKIP` banner and exits
  > 0 (that is correct behaviour); the real `--strict` run is Task 5 with `bin/dev up`.

- [ ] **Commit:**
  ```bash
  git add transcriber/src/e2e-gate.ts
  git commit -m "$(cat <<'EOF'
  test(transcriber): add the live e2e gate harness (slice #6)

  transcriber/src/e2e-gate.ts drives the COMPILED binary end-to-end against a real
  LiveKit SFU: preflight (sync/SFU/STT) with skip-loud-default vs --strict-fails
  semantics; a synthetic rtc-node speaker publishing the looped whisper-verified
  fixture (awaited captureFrame backpressure; required TrackPublishOptions); a
  harness self-check that a subscribe-only peer sees the speaker's track BEFORE the
  scribe launches (so a publish-under-Bun failure diagnoses as harness-side, not as
  the charter gate); Bun.spawn-equivalent (node:child_process) launch of
  dist/ensembleworks-transcriber; and a ~90s transcript poll asserting a non-empty
  gate-speaker line, with timings. Not a *.test.ts — offline `bun run test` never
  runs it. Dedicated throwaway room gate-e2e + identity scribe-gate avoid the dev
  scribe.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 5 — Full gate: typecheck + full suite + build + the live `--strict` acceptance (merge evidence)

- [ ] **Step 1 — Offline gate (no SFU):**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun install
  bun run typecheck
  bun run test    # spawns tmux; takes a few minutes — let it finish
  bun run build
  ```
  Expected: typecheck 0; `bun run test` ends **`all 53 suites passed`** (52 + the new
  `transcriber/src/config.test.ts`); `bun run build` 0. No existing suite changes (the
  rename is symbol-only inside `transcriber.ts`; no server route / wire shape / contract
  changed).

- [ ] **Step 2 — Live acceptance gate (REQUIRED; needs `bin/dev up`).** This is the
  charter's hard gate (user decision 6). Run it and **capture the full `--strict`
  output**:
  ```bash
  bin/dev up
  bun --cwd transcriber run build:binary
  bun transcriber/src/e2e-gate.ts --strict 2>&1 | tee /tmp/gate-strict.log
  ```
  Expected: a `GATE PASS` block naming the `gate-speaker` transcript text and the
  preflight / publish-visible / connect→…→POST / total timings — proving every hop
  through the **compiled** binary (connect, subscribe, segment, STT, POST). Exit 0.

  - **If it FAILs with a `harness-side: …publish path under Bun` message:** that is
    R1b (publish-under-Bun), a **harness** problem — escalate as an rtc-node/Bun FFI
    gap, **not** as the charter scribe gate failing.
  - **If it FAILs at the transcript timeout (`connect→…→POST`):** that is R1 — the
    compiled binary's `room.connect()` path. Per charter decision 6 there is **no Node
    fallback**: this **blocks the slice and escalates to the user**. Do not paper over it.

- [ ] **Step 3 — Record the merge evidence (Definition-of-Done).** The slice is **not
  done** until the `--strict` PASS transcript is recorded in the track-state doc. Paste
  the captured `GATE PASS` block + timings from `/tmp/gate-strict.log` into
  `docs/superpowers/plans/2026-07-06-plugin-architecture-track.md` (the #6 row's Notes,
  or a short "#6 merge evidence" block), then commit:
  ```bash
  git add docs/superpowers/plans/2026-07-06-plugin-architecture-track.md
  git commit -m "$(cat <<'EOF'
  docs(track): #6 transcriber cutover — strict gate PASS (merge evidence)

  Records the e2e-gate.ts --strict PASS transcript (connect→subscribe→segment→STT→
  POST timings + the gate-speaker line) proving the compiled binary completes a real
  room.connect() against a live SFU with no Node fallback (charter decision 6). A
  manual gate that leaves no artifact can be skipped by accident; the recorded
  transcript makes the acceptance run visible at review — no transcript ⇒ no merge.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```
  (No recorded PASS transcript ⇒ the gate did not run ⇒ the slice does not merge.)

---

## Execution notes

_(Executors: record the final `bun run test` suite count — it must read
`all 53 suites passed` — the captured `--strict` GATE PASS block, and any deviation
from the verbatim blocks above.)_

### Self-review — coverage of the spec (done while writing this plan)

- **Every spec component appears in a task, no placeholders.**
  - `transcriber/src/config.ts` (`readScribeEndpoint`) — Task 1 Step 2, verbatim from
    the spec's resolver block.
  - `transcriber/src/config.test.ts` — Task 1 Step 1, RED first (module missing). Pins
    defaults, new names, the clean break (old names ignored), and new-wins-when-both.
    Suite 52 → 53.
  - `transcriber/src/transcriber.ts` rename — Task 1 Step 3, five ordered edits (docblock,
    import, const→resolver, then two replace-alls) transcribed against the live source;
    a `grep` proves no `CANVAS_*` survives (the clean break). Local role names
    `SYNC_URL`/`SYNC_ROOM`, env-name strings live only in `config.ts`.
  - `build:binary` script — Task 2, verbatim (`--compile --sourcemap`, host-arch,
    `dist/ensembleworks-transcriber`), separate from `build`; a no-SFU boot probe
    confirms the artifact.
  - The WAV fixture — Task 3, espeak-ng | ffmpeg provenance + the **mandatory**
    whisper-server non-empty-transcription check before commit (spec R6), with the "no
    unverified commit" rule and the `bin/dev up` prerequisite.
  - `e2e-gate.ts` — Task 4, complete verbatim: preflight (health, scribe-token/SFU-URL,
    STT), skip-loud-default vs `--strict`-fails, synthetic speaker (awaited
    `captureFrame`, required `TrackPublishOptions`), the step-1b self-check before the
    scribe launches, compiled-binary launch (`node:child_process`), ~90s transcript
    poll asserting non-empty text, teardown, timings. Dedicated throwaway `gate-e2e`
    room + `scribe-gate` identity (R4).
  - Final gate + manual acceptance + merge-evidence capture — Task 5.
- **TDD ordering honoured.** config.test.ts written first and shown RED (module missing),
  then config.ts to green, then the rename (Task 1).
- **rtc-node 0.13.30 signatures verified against `node_modules/**/*.d.ts`:**
  `AudioSource(sampleRate, numChannels)`; `AudioFrame(data, sampleRate, channels, samplesPerChannel)`;
  `captureFrame(frame): Promise<void>` (awaited — backpressure);
  `LocalAudioTrack.createAudioTrack(name, source)`;
  `publishTrack(track, options: TrackPublishOptions)` (options **required**);
  `TrackPublishOptions` is a protobuf-es `Message` with `source?: TrackSource`, so
  `new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE })` typechecks;
  `TrackSource.SOURCE_MICROPHONE = 2`; `room.connect(url, token, { autoSubscribe, dynacast })`
  (both required); `TrackKind.KIND_AUDIO` on `TrackPublication.kind`;
  `remoteParticipants: Map<string, RemoteParticipant>`,
  `trackPublications: Map<string, TrackPublication>`.
- **Type consistency.** The harness uses `node:child_process` (not `Bun.spawn`) and
  `fileURLToPath(import.meta.url)` (not Bun's `import.meta.dir`) so it typechecks under
  `transcriber/tsconfig.json` (`types: ["node"]`) with **no tsconfig change**;
  `noUncheckedIndexedAccess` handled (write-indexing only; `.find(...)` results guarded;
  `?? []` on entries). `fetch` is a global (already used by `transcriber.ts`).
- **Offline suite stays flake-free.** `e2e-gate.ts` and `gate-speech.wav` are not
  `*.test.ts`, so `scripts/run-tests.ts`'s `**/src/**/*.test.ts` glob never discovers
  them (Task 4 Step 2 proves it); the default gate mode skips loud + exit 0 (R3). Only
  `config.test.ts` is added to the suite.
- **Scope boundary respected.** Every edit is inside `transcriber/` (config.ts,
  config.test.ts, transcriber.ts, package.json, fixtures/, e2e-gate.ts) plus the
  Task-5 merge-evidence note in the track-state doc. No server route, wire shape,
  systemd unit, deploy script, or `bin/dev` touched; no env var beyond the two named;
  no scribe service token; host-arch compile only.
```