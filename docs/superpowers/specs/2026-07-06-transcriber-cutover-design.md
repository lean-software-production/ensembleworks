# Transcriber cutover — env rename + a compiled binary that really `room.connect()`s

**Phase 3, sub-project #6 (transcriber cutover).** Two things land together:
a **clean-break env rename** (`CANVAS_URL`/`CANVAS_ROOM` →
`ENSEMBLEWORKS_URL`/`ENSEMBLEWORKS_ROOM`) inside `transcriber/`, and the
proof that closes Spike C's one deferred question — a **`bun build --compile`
transcriber binary, with the embedded `@livekit/rtc-node` `.node` addon, that
completes a real `room.connect()` → subscribe → segment → STT →
`POST /api/scribe/transcript` end-to-end against a live SFU, with NO Node
fallback.**

Conforms to the plugin-architecture track charter
(`2026-07-06-plugin-architecture-track-charter.md`) — user-arbitrated decision
6 (the transcriber gate) and §"#5 — Connector / #6 — Transcriber" (env mapping;
the scribe is a co-located localhost "none" worker) — which is the constitution
for this slice, and to `unified-architecture-design.md` §2.1 (Spike C:
`room.connect()` explicitly deferred to this cutover) and §2.2 (transcriber row:
"pass → compiled artifact like the rest; fail → contained Node exception"). The
charter overrides §2.2's fallback clause: **there is no Node fallback; a failing
gate blocks the slice and escalates to the user.** House style follows
`2026-07-06-attribution-design.md`.

## Scope boundary — what #6 is and is not

#6 **is**: (a) the clean-break rename of the two sync-connection env vars the
scribe reads, extracted into a network-free, unit-tested resolver; and (b) a
compile script plus a live e2e **gate harness** that exercises the compiled
binary against a real LiveKit SFU and asserts a transcript line lands.

It is **not**:

- **A behaviour change to the STT / VAD / transcript pipeline.** `segmenter.ts`,
  `stt.ts`, `wav.ts`, `livekit-url.ts` and the `pumpTrack` / `postTranscript`
  logic in `transcriber.ts` are untouched except where a symbol is renamed. The
  wire shape of `POST /api/scribe/transcript` (`{room, identity, name, text}`)
  and the `GET /api/av/token?…&role=scribe` fetch are unchanged — 3a already
  moved the POST to `/api/scribe/transcript`; this slice does not touch server
  routes.
- **A rename of any env var other than the two named.** `STT_URL`, `STT_MODEL`,
  `STT_LANGUAGE`, `STT_API_KEY`, `SCRIBE_IDENTITY`, `SCRIBE_NAME` and
  `LIVEKIT_URL` keep their names (charter: "Env rename ONLY
  (CANVAS_URL/CANVAS_ROOM → ENSEMBLEWORKS_URL/_ROOM)"). In particular the scribe
  does **not** gain `ENSEMBLEWORKS_TOKEN_ID/_TOKEN_SECRET`: it is a co-located
  localhost "none" worker with **no service token**, not in `hosts.toml`, and
  the transcriber code reads no `CF_ACCESS_*` today (verified). Anonymous
  write-scope covers its transcript POSTs.
- **A systemd-unit or deploy-script edit.** `deploy/systemd/ensembleworks-scribe.service`,
  `deploy/systemd/prod/…`, `deploy/deploy.sh`, `deploy/bootstrap-debian-ash.sh`
  and `deploy/agent-home/AGENTS.md` still spell `CANVAS_*`. Charter #7/#8 own
  the unit/env rename ("systemd … only swap ExecStart … and `CANVAS_*` →
  `ENSEMBLEWORKS_*`"). Touching them here would violate "touch ONLY
  transcriber/". See **Handoff to #7/#8** for why the clean break is safe
  without them.
- **A `bin/dev` edit.** Verified: `bin/dev`'s engine (`bin/dev-lib.mjs`, the
  `scribe` service block) sets `LIVEKIT_URL`, `STT_URL`, `STT_MODEL` for the
  scribe window — **none of the two renamed vars.** It never sets `CANVAS_URL`
  or `CANVAS_ROOM`; the transcriber falls through to its defaults. So the rename
  needs no `bin/dev` change, and this slice stays inside `transcriber/`.
- **The cross-arch release matrix.** #7 wires
  `ensembleworks-transcriber-linux-{x64,arm64}` into CI
  (`unified-architecture-design.md` §6.5). This slice compiles for the **host
  arch only**, purely to run the gate.

## Background

`transcriber/src/transcriber.ts` (the scribe) is the one file that reads the
two renamed vars — a docblock, two module-level consts, a log prefix and two
`fetch` bodies:

```ts
// transcriber/src/transcriber.ts (today)
const CANVAS_URL = process.env.CANVAS_URL ?? 'http://localhost:8788'
const CANVAS_ROOM = process.env.CANVAS_ROOM ?? 'team'
const log = (...a) => console.log(`[scribe ${CANVAS_ROOM}]`, ...a)
// … fetchToken(): GET `${CANVAS_URL}/api/av/token?room=${CANVAS_ROOM}&…&role=scribe`
// … postTranscript(): POST `${CANVAS_URL}/api/scribe/transcript` { room: CANVAS_ROOM, … }
```

A `grep CANVAS_URL|CANVAS_ROOM transcriber/` returns hits in **only** this file
(the docblock lines 17–18, consts 38–39, log 49, and the fetch bodies). The
rest of the workspace (`segmenter.ts`, `stt.ts`, `wav.ts`, `livekit-url.ts` and
their tests) is env-free.

Spike C (§2.1) proved the hard native-module questions in isolation:
`@livekit/rtc-node` **imports** under Bun, the transcriber **runs** under Bun,
and a `bun build --compile` binary **with the embedded `.node` addon** builds
and launches. What it explicitly did **not** exercise is
`room.connect()` — the WebRTC/UDP path that actually joins an SFU — "deferred to
the Phase-3 transcriber cutover checklist". That deferred check is the whole
point of this slice's gate. The addon on this box is
`node_modules/@livekit/rtc-ffi-bindings-linux-x64-gnu/rtc-node.linux-x64-gnu.node`;
`bun build --compile` embeds it (Spike C), and the gate is the first time it is
driven against a real SFU from a compiled binary.

The dev stack already provides everything the gate needs. `bin/dev up` (inside
the devcontainer, which installs `livekit-server`, `whisper-server` + a
`ggml-base` model, and Bun 1.3.14 — see `.devcontainer/Dockerfile`) runs:

| service | port | how (`bin/dev-lib.mjs`) |
|---|---|---|
| sync server | 8788 | `bun … @ensembleworks/server` — mints tokens, takes transcript POSTs |
| livekit SFU | 7880 | `livekit-server --dev --bind 0.0.0.0` (keys `devkey`/`secret`) |
| whisper STT | 8091 | `whisper-server … --inference-path /v1/audio/transcriptions` (OpenAI-compatible) |
| scribe | — | source-under-Bun, env `LIVEKIT_URL=ws://localhost:7880`, `STT_URL=http://localhost:8091/v1` |

`GET /api/av/token?role=member` grants `canPublish:true`; `role=scribe` is
subscribe-only (`server/src/features/av.ts`). `GET /api/scribe/transcript?room=&since=&limit=`
returns `{ ok, now, entries }` where each entry carries `{ identity, name,
text, t }` (`server/src/features/transcript.ts`). Those two endpoints are all
the gate needs from the server.

## Goal

- The two renamed vars are read through a network-free
  `transcriber/src/config.ts` resolver (`readScribeEndpoint(env)`), tested for
  the rename **and the clean break** (old names ignored).
- `transcriber/src/transcriber.ts` reads `ENSEMBLEWORKS_URL` /
  `ENSEMBLEWORKS_ROOM` (via the resolver) and nowhere reads `CANVAS_*`. Docblock,
  log prefix and startup banner updated to the new names.
- `transcriber/package.json` gains a `build:binary` script that produces a
  compiled, host-arch binary `transcriber/dist/ensembleworks-transcriber` with
  the embedded rtc-node addon.
- `transcriber/src/e2e-gate.ts` — a live gate harness that (default) **skips
  loudly** when the SFU/STT/sync prerequisites are absent so the ambient test
  run never flakes, and (`--strict`) **fails** if a prerequisite is missing or
  the pipeline breaks. When it runs, it launches the compiled binary against a
  real SFU with a synthetic speaker and asserts a transcript line lands.
- The gate is documented as the **slice's manual acceptance step**, run by the
  orchestrator with `bin/dev up` before merge, its **PASS transcript recorded
  in the track-state doc as merge evidence** (Definition-of-Done); a failing
  strict gate **blocks the slice and escalates to the user** (charter decision
  6 — no Node fallback).
- `bun run typecheck`, `bun run build`, `bun run test` green. **Suite count:
  52 → 53** (one new network-free suite, `transcriber/src/config.test.ts`; the
  gate harness is not a `*.test.ts` and is not discovered by
  `scripts/run-tests.ts`).

## The env rename (clean break)

### `transcriber/src/config.ts` (new — the tested resolver)

Mirrors the existing `livekit-url.ts` pattern: a pure function over an env
record, so the rename has a network-free regression guard. Reads **only** the
new names; the old names are not consulted — that is the clean break, and the
test pins it.

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

### `transcriber/src/transcriber.ts` (consume the resolver, rename symbols)

The two module-level consts are replaced with one resolver call; every
`CANVAS_URL` / `CANVAS_ROOM` reference becomes the resolved field. No control
flow changes.

```ts
import { readScribeEndpoint } from './config.ts'
// …
const { url: SYNC_URL, room: SYNC_ROOM } = readScribeEndpoint(process.env)
// was: const CANVAS_URL = …; const CANVAS_ROOM = …

const log = (...args: unknown[]) => console.log(`[scribe ${SYNC_ROOM}]`, ...args)
// fetchToken(): new URLSearchParams({ room: SYNC_ROOM, … }); fetch(`${SYNC_URL}/api/av/token?…`)
// postTranscript(): fetch(`${SYNC_URL}/api/scribe/transcript`, … body { room: SYNC_ROOM, … })
// startup banner: log(`connected to ${info.url} as ${SCRIBE_NAME}; posting to ${SYNC_URL}`)
```

The docblock `Environment:` block is updated:

```
 *   ENSEMBLEWORKS_URL    sync server (default http://localhost:8788)
 *   ENSEMBLEWORKS_ROOM   room to scribe (default team)
```

(`STT_*`, `SCRIBE_*`, `LIVEKIT_URL` lines stay verbatim.)

Naming note: the local symbols are `SYNC_URL` / `SYNC_ROOM` (what they are —
the sync server) rather than a literal `ENSEMBLEWORKS_URL` const, so the code
reads by role and the env-name string lives in exactly one place
(`config.ts`). This is a naming detail inside the slice, not a product choice.

## The compiled binary

### `transcriber/package.json` — the `build:binary` script

```json
"scripts": {
  "build:binary": "bun build --compile --sourcemap src/transcriber.ts --outfile dist/ensembleworks-transcriber"
}
```

- **Host-arch only.** No `--target` flag → Bun compiles for the current
  platform; the embedded runtime and the resolved
  `rtc-node.linux-<arch>-gnu.node` addon match the box. Cross-compiling to the
  `linux-{x64,arm64}` release names is #7's job (§6.5); this slice needs one
  local binary to gate.
- **`--sourcemap`** per §6.5 ("binaries embed sourcemaps so stack traces stay
  readable") — cheap to set now, and the gate's failure output benefits from it.
- **Artifact path:** `transcriber/dist/ensembleworks-transcriber`. Add
  `transcriber/dist/` to `.gitignore` if not already covered (build output, not
  source).
- The existing `build` script (`bunx tsc --noEmit`, run by the root
  `bun run build`) is **unchanged** — `build:binary` is separate and is **not**
  wired into the root `build`/`test`, so `bun run build` stays fast and
  hermetic (no SFU, no addon-embed step in the default build). The gate script
  invokes `build:binary` on demand.

Spike C already proved this exact `--compile`-with-embedded-addon build
succeeds and the binary launches. The novel thing the gate proves is that
`room.connect()` works **from that binary**.

## The e2e gate

The gate is the charter's hard acceptance test. It must (a) never flake the
ambient `bun run test` when no SFU is present, and (b) when run as the slice's
acceptance step with `bin/dev up`, prove the full pipeline through the
**compiled** binary, failing loud on any break.

### `transcriber/src/e2e-gate.ts` (new — the live harness)

Run as `bun src/e2e-gate.ts` (source-under-Bun is fine for the *harness*; only
the scribe *under test* must be the compiled binary). Not a `*.test.ts`, so
`scripts/run-tests.ts` (glob `**/src/**/*.test.ts`) never discovers it — the
default suite stays flake-free and offline.

**Two modes:**

- **Default (ambient / skip-on-missing):** preflight the prerequisites; if any
  is absent, print a **loud** `SKIP` banner explaining what was missing and how
  to get it (`bin/dev up`), and **exit 0**. This is what makes it safe to run
  anywhere.
- **`--strict` (acceptance):** a missing prerequisite is a **FAILURE** (exit
  non-zero), not a skip — so the orchestrator's acceptance run cannot silently
  pass by skipping. This is the mode that gates the slice.

**Preflight** (both modes probe; strict vs. skip differ only in the verdict on
a miss):

1. Sync server: `GET ${SYNC_URL}/api/health` returns OK.
2. LiveKit configured: `GET ${SYNC_URL}/api/av/token?room=${GATE_ROOM}&identity=gate-preflight&role=scribe`
   returns `{ enabled: true, url, token }`. Resolve the SFU URL the same way the
   scribe does — `resolveScribeConnectUrl(info.url, process.env.LIVEKIT_URL)`
   (reuse `livekit-url.ts`; in the dev stack `LIVEKIT_URL=ws://localhost:7880`
   wins).
3. STT backend: `STT_URL` or `STT_API_KEY` present in env (the dev stack sets
   `STT_URL=http://localhost:8091/v1`). Optionally probe the STT URL for
   reachability.

**Isolation.** The gate uses a dedicated throwaway room `GATE_ROOM` (e.g.
`gate-e2e`), **not** `team`, so it never collides with the dev-stack scribe
(which transcribes `team`) and never pollutes `team`'s transcript file. The
scribe-under-test is launched with `SCRIBE_IDENTITY=scribe-gate` for the same
reason.

**The run** (strict, or default when preflight passed):

1. **Synthetic speaker.** Fetch a publish-capable token
   (`GET /api/av/token?room=${GATE_ROOM}&identity=gate-speaker&role=member` →
   `canPublish:true`), `new Room()`, `room.connect(sfuUrl, token,
   { autoSubscribe: false })`, then publish a looped speech fixture:

   ```ts
   import { AudioSource, AudioFrame, LocalAudioTrack, Room, TrackPublishOptions, TrackSource } from '@livekit/rtc-node'
   const source = new AudioSource(16_000, 1)
   const track = LocalAudioTrack.createAudioTrack('gate-speech', source)
   // publishTrack takes a REQUIRED TrackPublishOptions second arg.
   await room.localParticipant.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }))
   // loop — captureFrame returns a Promise and MUST be awaited: it is the
   // backpressure mechanism. An un-awaited tight loop overruns the source's
   // internal queue and mispaces the WAV loop (audio arrives as a garbled burst
   // instead of real-time speech, and the VAD never sees clean utterances).
   //   await source.captureFrame(new AudioFrame(pcm16, 16_000, 1, samplesPerChannel))
   ```

   The fixture is `transcriber/src/fixtures/gate-speech.wav` — a short (~2–4 s)
   **clear mono 16 kHz PCM16 spoken-word** clip (e.g. "testing testing one two
   three"). **Provenance (concrete):** generated with a named TTS — e.g.
   `espeak-ng -v en -s 140 -w` piped through
   `ffmpeg -i - -ar 16000 -ac 1 -c:a pcm_s16le gate-speech.wav` (or `say` +
   ffmpeg on macOS, or a clean human recording downsampled the same way).
   **Required pre-commit verification:** before the fixture is committed, run it
   through the dev whisper-server
   (`curl -F file=@gate-speech.wav -F model=whisper-1 http://localhost:8091/v1/audio/transcriptions`)
   and confirm a **non-empty transcription** — a fixture whisper can't hear is a
   gate that can never pass. It must be real speech, not a tone: the segmenter's
   energy VAD trips on the speech, and `whisper-base` must transcribe it to
   **non-empty** text (the scribe drops empty STT results — `if (!text) return`).
   Looping the fixture gives the scribe several utterances → several STT
   chances, so a single flaky-empty transcription doesn't fail the gate.
   (Signatures above are the rtc-node 0.13.29 shape — confirmed present:
   `AudioSource`/`AudioFrame`/`LocalAudioTrack.createAudioTrack`/`captureFrame`/`publishTrack`;
   the implementer confirms exact constructor/options arguments against the
   installed types.)

1b. **Harness self-check — publish visibility (before launching the scribe).**
   No spike exercised rtc-node's **publish** path under Bun: Spike C proved
   import, the subscribe-side transcriber runtime, and compiled launch —
   `AudioSource` → `captureFrame` → `publishTrack` is a **distinct FFI path**,
   first exercised by this harness. So before the compiled scribe launches, the
   harness confirms its own speaker actually landed in the room: connect a
   second, subscribe-only rtc-node participant (`role=scribe` token,
   `identity=gate-checker`) and wait for it to observe `gate-speaker`'s audio
   track (`ParticipantConnected` / `TrackPublished` for `gate-speaker`), or —
   equivalent and simpler if available — poll the sync server's participant
   view for `gate-speaker`'s presence in `GATE_ROOM`. Only when the published
   track is confirmed visible does the harness proceed to step 2. **Why:** if
   publish-under-Bun is broken, the gate would otherwise time out at step 3 and
   read as a charter-gate failure of the *compiled scribe* — a false
   escalation. The self-check phase makes that failure diagnose loudly as
   **harness-side** ("speaker publish never became visible — publish path under
   Bun, not the scribe under test") and distinct from a genuine gate failure.

2. **Scribe under test.** `Bun.spawn` the **compiled binary**
   `dist/ensembleworks-transcriber` (running `build:binary` first if the
   artifact is missing/stale), with env:
   `ENSEMBLEWORKS_URL=${SYNC_URL}`, `ENSEMBLEWORKS_ROOM=${GATE_ROOM}`,
   `SCRIBE_IDENTITY=scribe-gate`, plus the inherited `LIVEKIT_URL`, `STT_URL` /
   `STT_API_KEY` / `STT_MODEL`. This is the load-bearing line: the binary now
   does the real `room.connect()` → `TrackSubscribed` → `AudioStream` →
   segmenter → `transcribeWav` → `POST /api/scribe/transcript`.

3. **Assert.** Poll `GET ${SYNC_URL}/api/scribe/transcript?room=${GATE_ROOM}&since=<startMs>`
   until an entry with `identity === 'gate-speaker'` and non-empty `text`
   appears, or a timeout (~90 s). **Assert non-empty `text`, not exact words**
   (whisper-base output on the fixture is non-deterministic in wording but
   reliably non-empty). A landed line proves every hop: connect (binary joined),
   subscribe (it heard the track), segment (VAD produced an utterance), STT (a
   non-empty transcription), POST (it reached `/api/scribe/transcript`).

4. **Teardown.** Kill the binary subprocess (SIGTERM), `room.disconnect()` the
   speaker, print `PASS`/`FAIL` with timings. The throwaway room's transcript
   file is left as-is (a throwaway room; no cleanup burden).

### Data flow (the gate)

```
gate harness (bun src/e2e-gate.ts)              dev stack (bin/dev up)
────────────────────────────────                ──────────────────────
preflight  ──── GET /api/health ───────────────► sync :8788  (ok?)
           ──── GET /api/av/token?role=scribe ─► sync :8788  (enabled? url,token)

synthetic speaker (rtc-node, source-under-Bun)
  GET /api/av/token?role=member ──────────────► sync :8788   → publish token
  room.connect(ws://localhost:7880) ──────────► livekit :7880
  publishTrack(gate-speech.wav loop) ─────────► livekit :7880  (audio in)

self-check (gate-checker, subscribe-only)
  sees gate-speaker's track published? ───────► livekit :7880
  no ⇒ FAIL "harness-side: publish under Bun"  (scribe never launched)

scribe under test = COMPILED BINARY
  dist/ensembleworks-transcriber
  ENSEMBLEWORKS_URL/_ROOM, LIVEKIT_URL, STT_URL
  room.connect(ws://localhost:7880) ──────────► livekit :7880  (subscribe)
  AudioStream → segmenter → transcribeWav ────► whisper :8091  (STT)
  POST /api/scribe/transcript ────────────────► sync :8788     (transcript in)

assert   ──── GET /api/scribe/transcript ──────► sync :8788
              entries[].identity==='gate-speaker' && text!=='' ⇒ PASS
```

The dev-stack `scribe` window (room `team`) and the gate's `scribe-gate` (room
`gate-e2e`) coexist without collision.

## Testing

**Suite count: 52 → 53.** One new network-free suite; the gate harness and its
audio fixture are not discovered by `scripts/run-tests.ts`.

### `transcriber/src/config.test.ts` — the rename guard (network-free)

Self-running `bun src/config.test.ts`, `node:assert/strict`, ending
`console.log('ok: …')` (house convention, mirroring `livekit-url.test.ts`).
Pure `readScribeEndpoint`, no server boot:

- **Defaults:** `readScribeEndpoint({})` →
  `{ url: 'http://localhost:8788', room: 'team' }` (regression guard — the
  pre-cutover defaults are unchanged).
- **New names honoured:**
  `readScribeEndpoint({ ENSEMBLEWORKS_URL: 'http://sync.test:9', ENSEMBLEWORKS_ROOM: 'demo' })`
  → `{ url: 'http://sync.test:9', room: 'demo' }`.
- **Clean break (the load-bearing case):**
  `readScribeEndpoint({ CANVAS_URL: 'http://old:1', CANVAS_ROOM: 'old' })` →
  `{ url: 'http://localhost:8788', room: 'team' }` — the **old names are
  ignored**, proving no alias survives.
- **New wins when both set:**
  `readScribeEndpoint({ ENSEMBLEWORKS_ROOM: 'demo', CANVAS_ROOM: 'old' })`
  → `room: 'demo'`.

### The gate as manual acceptance (not in the default suite)

The gate is the slice's **acceptance step**, run by the orchestrator, not by
`bun run test`:

```
bin/dev up
bun --cwd transcriber run build:binary
bun transcriber/src/e2e-gate.ts --strict
```

Expected: `PASS` — a `gate-speaker` transcript line landed via the compiled
binary. `bun run test` (the 53 suites) stays green and offline; a laptop or CI
box with no SFU that runs the gate ambiently (without `--strict`) sees the loud
`SKIP` and exit 0.

**Merge evidence (Definition-of-Done — the manual gate is not silently
omittable).** The slice is not done until the orchestrator has run the strict
gate — after `bin/dev up`, **before merge** — and **captured the
`e2e-gate.ts --strict` PASS transcript** (the harness's printed
connect / subscribe / segment / STT / POST timings and the final `PASS` line),
**recording it in the track-state doc as merge evidence**. A manual gate that
leaves no artifact can be skipped by accident; requiring the transcript in the
track state makes any omission visible at review. No recorded transcript ⇒ the
gate did not run ⇒ the slice does not merge.

### Existing suites

Unchanged and green: the rename is symbol-only inside `transcriber.ts`, and no
server route, wire shape, or contract changes — so `scribe-api.test.ts`,
`transcript`-related server suites, `livekit-url.test.ts`, `segmenter.test.ts`,
`wav.test.ts` are untouched. `bun run typecheck` / `bun run build` cover the new
`config.ts` import.

## Handoff to #7/#8 (why the clean break is safe now)

The code reads `ENSEMBLEWORKS_*` after this slice, but the scribe systemd unit
and deploy scripts still set `CANVAS_*` — deliberately, because the charter
assigns unit/env renames to #7/#8 and this slice may touch only `transcriber/`.
This is safe under the **big-bang cutover posture** (§7): #6 does not deploy
independently — it rides the cutover release, where **#8 reseeds the
`ENSEMBLEWORKS_*` env** (`unified-architecture-design.md` §7.2: "Env names change
at Phase 3"). There is no window in which new code runs against an un-renamed
prod env.

In **dev** it is already behaviour-neutral: `bin/dev` never sets `CANVAS_*`, so
the scribe used its defaults before and uses the same defaults now. Two concrete
follow-ups for #7/#8, recorded so nothing is dropped:

- `deploy/systemd/ensembleworks-scribe.service` (and `…/prod/…`): rename
  `Environment=CANVAS_URL=…` / `Environment=CANVAS_ROOM=…` →
  `ENSEMBLEWORKS_URL` / `ENSEMBLEWORKS_ROOM`, and swap `ExecStart` to the
  absolute compiled binary path (`…/ensembleworks-transcriber`) in place of
  `npm run dev`. **Both the unit's `ExecStartPre` curl guard and the
  `EnvironmentFile` scribe.env must use the new names** — if a prod `scribe.env`
  sets a non-default `CANVAS_ROOM`, the reseed must carry it across as
  `ENSEMBLEWORKS_ROOM` or the scribe silently falls back to `team`.
- `deploy/deploy.sh`, `deploy/bootstrap-debian-ash.sh`,
  `deploy/agent-home/AGENTS.md`: any `CANVAS_URL`/`CANVAS_ROOM` references
  rename with the rest of the `ENSEMBLEWORKS_*` cutover.
- For track-wide completeness: `bin/canvas`'s own `CANVAS_URL`/`CANVAS_ROOM`
  reads are owned by the **#4/#8 surface** — `bin/canvas` retires at cutover
  (replaced by the `ensembleworks` CLI reading `ENSEMBLEWORKS_*`), so those
  hits are not a rename target for any slice; they disappear with the file.

## Risks

- **R1 — `room.connect()` fails from the compiled binary (the charter gate).**
  Spike C proved import + compiled launch + embedded addon, but never drove
  `room.connect()`; the WebRTC/UDP path from a `bun --compile` binary with an
  embedded napi addon is genuinely first-exercised here. If it fails (addon
  can't open UDP, can't negotiate ICE against `livekit-server --dev`, etc.), the
  strict gate fails — and per charter decision 6 that **blocks the slice and
  escalates to the user**; there is **no Node fallback** to fall back to. This
  is the accepted, designed-for failure mode, not a bug to paper over.
- **R1b — the publish path under Bun is itself unproven.** Spike C never
  exercised rtc-node's **publish** side (`AudioSource` → `captureFrame` →
  `publishTrack`) under Bun — it proved import, the subscribe-side runtime, and
  compiled launch. The gate's synthetic speaker is the first publish-under-Bun
  exercise, and a failure there is a **harness** problem, not a charter-gate
  verdict on the compiled scribe. Mitigated by the step-1b self-check: a
  second subscribe-only participant (or a server-side participant check)
  confirms `gate-speaker`'s track is visible **before** the compiled scribe
  launches, so a publish failure fails fast with a "harness-side: publish under
  Bun" diagnosis instead of masquerading as a step-3 timeout. If the self-check
  itself fails, that is escalation-worthy news too (a Bun/rtc-node FFI gap) —
  but it is reported as what it is, not misread as the charter gate failing.
- **R2 — STT returns empty and the gate false-fails.** whisper-base on a short
  clip can occasionally transcribe to `''`, which the scribe drops (no POST).
  Mitigated by a real spoken-word fixture, **looping** it (multiple utterances →
  multiple STT chances) and a ~90 s poll window; the assertion is non-empty
  text, not exact words. If it still flakes, lengthen the fixture / window — a
  gate-harness tuning knob, not a pipeline change.
- **R3 — the gate flakes an offline CI run.** Prevented structurally: the gate
  is not a `*.test.ts` (never discovered by `run-tests.ts`), and its default
  mode **skips loud + exit 0** when the SFU/STT/sync preflight misses. Only
  `--strict`, run deliberately with `bin/dev up`, can fail on a missing
  prerequisite.
- **R4 — two scribes / transcript pollution.** The dev-stack scribe transcribes
  `team`; the gate could collide or dirty `team`. Prevented by the dedicated
  throwaway `GATE_ROOM` (`gate-e2e`) and `SCRIBE_IDENTITY=scribe-gate`.
- **R5 — env rename silently reverts a prod room.** A prod `scribe.env` setting
  a non-default `CANVAS_ROOM` would be ignored by the renamed code. Not a bug in
  this slice (dev is neutral; prod env is reseeded at #8), but flagged in
  **Handoff** so #8's reseed carries the value across rather than dropping it.
- **R6 — the audio fixture is a committed binary.** `gate-speech.wav` is a small
  binary asset in `transcriber/src/fixtures/`. Accepted (a few KB); it is test
  scaffolding, kept out of the compiled binary and out of `bun run build`. Its
  provenance (named TTS or recording, 16 kHz mono PCM16) and the **required**
  whisper-server non-empty-transcription check before committing it are pinned
  in the gate design — an unverified fixture is the one way to bake a
  never-passing gate into the repo.

## Known issue discovered by the gate (2026-07-06)

**rtc-node `AudioSource.captureFrame` silently captures SILENCE from
`Int16Array` subarray views (non-zero byteOffset) under Bun.** Always pass a
copied `Int16Array` (`new Int16Array(chunk)`), never a `.subarray()` view.
Found driving this slice's `--strict` gate (frames flowed at peak=1 until the
copy fix); the subscribe side (`AudioStream`) is unaffected. Any future code
that PUBLISHES audio via rtc-node under Bun (e.g. a connector TTS/playback
path) must heed this. Fix + inline comment: `transcriber/src/e2e-gate.ts`.
