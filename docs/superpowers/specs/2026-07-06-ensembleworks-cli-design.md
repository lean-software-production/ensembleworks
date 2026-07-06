# The `ensembleworks` CLI — one binary, a generic manifest renderer, auth, and the `terminal connect` slot

**Phase 3, sub-project #4 — the `ensembleworks` CLI.** One Bun program that
absorbs `bin/canvas` (canvas/roadmap/scribe/terminal-status verbs), owns the
`auth` credential store, and reserves the native `terminal connect` slot that
sub-project #5 fills. The CLI is a **generic renderer of `GET /api/tools`** (the
3b manifest) plus a small set of native commands that cannot be data-driven
(credential storage, a PTY daemon, and the two client-side compositions that
have no backing route). It rewrites all four `SKILL.md` files atomically so the
agent surface moves from `canvas …` to `ensembleworks …` in the same merge.

Conforms to the plugin-architecture track charter
(`2026-07-06-plugin-architecture-track-charter.md`) §"#4 — The `ensembleworks`
CLI" (the constitution for this slice) and its §"Ratified extensions" (the
`/api/tools` envelope the renderer consumes), and to
`unified-architecture-design.md` §6 (6.1 command surface, 6.2 code layout, 6.3
three extensibility layers, 6.4 auth & attribution, 6.5 distribution). House
style follows `2026-07-06-attribution-design.md`.

**This is a GATED slice.** §12 collects the handful of UX consequences that the
pinned architecture *entails* (verb renames forced by faithful manifest
rendering, one dropped bin/canvas nicety) and flags them for the user's review.
None are new product choices — they fall out of two already-pinned decisions
(generic renderer + the frozen 15-verb manifest) — so they are recommended here
rather than escalated, but they are the things worth a human eye before code.

---

## 1. Scope boundary — what #4 is and is not

**#4 IS:**

- A new `cli/` Bun workspace (`@ensembleworks/cli`) that builds one program,
  installed as `ensembleworks` with an `ew` hardlink (charter decision 3:
  `ensembleworks` is canonical; `ew` is mentioned once at install).
- The **command framework**: argv dispatch (native → manifest group → trusted
  extension → error), the connection-resolution chain, and the generic
  manifest renderer (argv → typed request → HTTP → output).
- The **canvas/roadmap/scribe/terminal-status verbs**, rendered from the 15-def
  manifest — no verb knowledge baked into the binary.
- The **`auth` command group** (`login`/`status`/`logout`) and its `hosts.toml`
  store, plus request authentication (the CF Access service-token header pair).
- **`version`** and the **`tools` cache commands** (`tools` list, `tools
  refresh`).
- The two **native client-side canvas compositions** that have no backing
  route: `canvas pull-images` (fetch a frame, download its `/uploads/*`).
- The **`terminal connect` command slot**: registered as a native command, with
  full flag parsing and `--dry-run` config resolution — the empty shell #5
  fills with the relay engine.
- The **atomic `SKILL.md` reseed** of all four skill files (§11).
- A **dev run wrapper** (`bin/ensembleworks` → `bun cli/src/main.ts`) + `bin/ew`
  so the reseeded skills are live in the devcontainer immediately, before #7
  produces compiled artifacts.

**#4 is NOT:**

- **The connector engine (slice #5).** #4 builds the `terminal connect` *slot*
  (dispatch entry, flags, `--dry-run`, connection resolution, gateway-id/label
  defaulting). The relay WS client, the exponential backoff / ping loop, the
  `session-manager.ts` PTY wiring, and the gateway-id identity binding are #5.
  The exact seam is §10. In #4, `terminal connect` without `--dry-run` prints a
  clear "connector lands in sub-project #5" notice and exits non-zero.
- **Compiled-binary distribution (slice #7).** #4 runs dev-style under
  `bun cli/src/main.ts`. `bun build --compile`, `install.sh`, the
  `release-cli.yml` workflow, the `ensembleworks-cli` devcontainer feature, and
  the `ensembleworks upgrade` self-update are #7. #4 only owes **compile
  compatibility** (§9.3): static imports, real-FS config paths, no dynamic verb
  loading — so #7's compile is a no-op.
- **Retiring `bin/canvas`.** The charter retires `bin/canvas`, `gateway-go/`,
  and `connect.sh` at the **cutover (#8)**, not here. `bin/canvas` stays in the
  tree, untouched and working, until #8 deletes it (§9.4 reasons this out).
- **A contracts/tools change.** The 15 tool defs and the `/api/tools` envelope
  are frozen by 3b/3c. #4 consumes them read-only. If a verb needs a new field,
  that is a contracts slice, not this one.
- **A server-route or attribution change.** All routes, the write-scope guard,
  and the attribution stamp (3c) are done. `--author` is just a manifest field
  the generic renderer forwards; the server decides its fate (credential wins).
- **MCP (`/mcp`).** Phase 4. The manifest envelope is shaped to match a future
  `tools/list`, but #4 renders it for a CLI only.

---

## 2. Background — why a generic renderer, not a ported bash script

`bin/canvas` is 400 lines of bash: hand-rolled JSON escaping, per-verb argument
parsing, and a fixed idea of every route. Every new plugin tool means editing
it. The charter's thesis (design §6.3, §2.2 Agent CLI row) is the opposite: the
CLI is a **generic renderer of `GET /api/tools`**. The verbs it can run are
whatever the connected server's manifest declares. A new server plugin's tools
appear in an already-installed CLI with no CLI release; the binary holds no verb
knowledge of its own to drift.

The 3b manifest makes this concrete. `GET /api/tools` returns
(`contracts/src/tools/types.ts`):

```ts
interface ManifestEnvelope { version: number; server: string; tools: ManifestEntry[] }
interface ManifestEntry { plugin, id, method, path, help, input, output }  // input/output = JSON Schema
```

15 entries today: `kernel.{whoami,participants}`, `av.{token,kick,pulse}`,
`terminal.{status,list}`, `canvas.{sticky,shape,frames,frame}`,
`scribe.{say,transcript}`, `roadmap.{write,read}`. The renderer turns one
`ManifestEntry` into a subcommand: `ensembleworks <plugin> <id> …`, with flags
from `input.properties`, `--help` from `help`, and the HTTP call from
`{method, path}`. Two things must not be baked in: the verb list (it comes from
the manifest) and the wire encoding (the server validates — the CLI must not
over-reject, §7).

Three bin/canvas verbs have **no backing route** and so cannot be
manifest-rendered — they are compositions bin/canvas does client-side:

- `pull-images` = `GET /api/canvas/frame` → grep `/uploads/*` → download each.
- `roadmap push <file>` = wrap a roadmap doc in a `replace` op → `POST`.
- `roadmap list` = `GET /api/roadmap/doc` with no `name`.

`pull-images` stays a **native** command (it genuinely composes two calls).
`push`/`list` collapse into the manifest verbs `roadmap write` / `roadmap read`
(§12 — these are the forced renames flagged for the gate).

---

## 3. Decisions settled in this spec

| # | Decision | §  |
|---|---|---|
| D1 | New `cli/` Bun workspace `@ensembleworks/cli`; only third-party runtime dep is `smol-toml` (parse+stringify for `hosts.toml`). | 4 |
| D2 | Three dispatch layers: **native** (`auth`, `version`, `tools`, `terminal connect`, `canvas pull-images`) → **manifest-rendered** (every `/api/tools` verb, incl. `kernel`) → **extension** (`ensembleworks-<group>`, trusted `~/.config/ensembleworks/extensions/` dir **only** — never bare PATH, it inherits live credentials) → error. | 6 |
| D3 | Generic renderer arg model: kebab-cased `--flag` per input field; required non-`room` scalars fillable positionally in schema order; a lone JSON-object positional is spread as the raw body (carries `canvas shape '<json>'`); `--field @file` loads a field from a file; `room` is injected from the resolved connection, never argv. | 6.2 |
| D4 | Validation posture: **validate-structure-and-block, validate-values-and-warn**. Block on unknown flag / missing required / wrong JSON type; *warn only* (still send) on enum/min/max/regex — the server handler is looser than `zodInput` and is the authority. | 7 |
| D5 | Auth = the CF Access **service-token header pair** `CF-Access-Client-Id` / `CF-Access-Client-Secret` (exactly what `gateway-go` sends). Consumed by Cloudflare Access at the edge, which injects `Cf-Access-Jwt-Assertion`; the origin's `resolveCaller` reads the JWT. The CLI never mints/signs JWTs and needs no team-domain/AUD. `method="none"` instances send no headers. | 8 |
| D6 | `hosts.toml` schema: top-level `default_instance` + `[instances."<url>"]` records (`method`, `token_id`, `token_secret`, `default_room`, cached `identity`). Auth-only (no gateway identity). Mode `0600`. Resolution chain = flags → env → file, merged **per variable** (a lone `ENSEMBLEWORKS_URL` keeps the file's creds). | 5 |
| D7 | Manifest cache at `~/.cache/ensembleworks/manifest-<instance-key>.json`; fetch-on-miss + explicit `--refresh`/`tools refresh`, never auto-refetch on hit; version-mismatch or offline → fall back to the **embedded snapshot** (the compiled-in `allTools` from `@ensembleworks/contracts`). | 6.3 |
| D8 | Output: data verbs print the server's JSON response **verbatim to stdout** (agent-first, matches bin/canvas); operator verbs (`auth status`, `tools`, `version`) print a human table but honour `--json`. All narration/errors on **stderr**; stdout is always clean. Non-2xx bodies that matter (roadmap 409) print to stdout + non-zero exit (bin/canvas `post_json_body` parity). | 7 |
| D9 | `terminal connect` is a native **slot**: #4 ships full flag parsing + `--dry-run` resolution; the engine is #5. gateway-id defaults to a **stable per-box id** (not bare hostname); label defaults to hostname. | 10 |
| D10 | `bin/canvas` stays until #8; #4 adds a `bin/ensembleworks` dev wrapper (`bun cli/src/main.ts`) + `ew` so reseeded skills work in dev before #7's compiled artifact. | 9.4 |
| D11 | SKILL.md reseed (all four files) lands in this slice's merge, atomic with the CLI (§11). | 11 |

---

## 4. Workspace layout

A fourth Bun workspace, added to the root `workspaces` array
(`["contracts", "client", "server", "transcriber", "cli"]`):

```
cli/
  package.json          # @ensembleworks/cli; bin: { ensembleworks, ew };
                        #   deps: @ensembleworks/contracts (workspace), smol-toml
  tsconfig.json         # extends the repo base; module nodenext
  src/
    main.ts             # entry — parse argv[0..1], dispatch (§6), map CliError → stderr + exit code
    dispatch.ts         # native → manifest group → trusted-dir extension → error
    resolve.ts          # the connection-resolution chain (§5) + authHeaders()
    hosts.ts            # hosts.toml read/write (smol-toml), default_instance, 0600
    http.ts             # fetch wrapper: base url + auth headers + query/body + non-2xx
                        #   handling; rejects non-same-origin/absolute manifest paths (§6.3)
    auth/
      login.ts          # interactive URL → method → paste pair → verify via /api/whoami → store
      status.ts         # per-instance reachability + resolved identity (GET /api/whoami)
      logout.ts         # remove instance; reassign default_instance
    render/
      manifest.ts       # cache load/store, fetch-on-miss, --refresh, embedded snapshot fallback
      args.ts           # ManifestEntry.input (JSON Schema) + argv → typed request payload
      validate.ts       # D4 posture: structure blocks, value constraints warn
      run.ts            # render a verb: build request → http.ts → output (§7)
    native/
      version.ts        # own build + connected server version
      tools.ts          # `tools` (list) / `tools refresh`
      pull-images.ts    # canvas pull-images: GET frame → download /uploads/*
      connect.ts        # terminal connect SLOT (§10): flags + --dry-run; engine = #5
    output.ts           # stdout-clean JSON | human table; --json; stderr narration
```

`cli/src/**/*.test.ts` is auto-discovered by the existing
`scripts/run-tests.ts` glob (`**/src/**/*.test.ts`) — **no runner change**.

`smol-toml` is the only new third-party runtime dependency. Rationale: the
`hosts.toml` table keys are quoted URLs (`[instances."https://…"]`) and must
round-trip losslessly on `login`/`logout`; a vetted pure-TS parse+stringify is
safer than hand-rolling TOML escaping, and it compiles cleanly under
`bun build --compile`. (Bun can *import* `.toml`, but there is no native
stringify for the write path.)

The dev wrapper (`bin/ensembleworks`, `chmod +x`):

```bash
#!/usr/bin/env bash
exec bun "$(dirname "$0")/../cli/src/main.ts" "$@"
```

`bin/ew` is a hardlink to it. `bin/` is where `bin/canvas` already lives and is
already on the agents' PATH, so the reseeded skills resolve `ensembleworks`
immediately in the devcontainer.

---

## 5. Connection resolution — `hosts.toml`, env, and the per-variable merge

### 5.1 `hosts.toml` (auth-only, mode 0600)

Location `~/.config/ensembleworks/hosts.toml`. Example (two instances, one
service-token prod and one "none" localhost):

```toml
default_instance = "https://canvas.example.com"

[instances."https://canvas.example.com"]
method       = "service-token"      # or "none"
token_id     = "1a2b3c….access"     # → CF-Access-Client-Id
token_secret = "s3cr3t…"            # → CF-Access-Client-Secret
default_room = "team"
identity     = "🤖 codespace-3"      # cached from the last verify; informational only

[instances."http://localhost:8788"]
method       = "none"
default_room = "team"
```

- `default_instance` is a **top-level** key, set by the last successful `auth
  login` (charter). It is the URL used when neither `--url` nor
  `ENSEMBLEWORKS_URL` is given.
- The file is **auth-only** — no gateway identity, no connector state (charter).
  `identity` is a cached whoami echo for a friendly `auth status`, never trusted
  for anything.
- Written `0600`; `login` `chmod`s it (headless boxes have no keychain — design
  §6.4).
- **Checked on read, too** (the gh/ssh habit): every load of `hosts.toml`
  stats it and, if it is group- or world-readable, prints
  `warning: ~/.config/ensembleworks/hosts.toml has permissions 0644 — should be
  0600 (chmod 600 …)` to stderr and continues. Warn-don't-block: an agent on a
  misconfigured box must still work, but the operator hears about it on every
  invocation. Pinned by `hosts.test.ts` (§13).

### 5.2 The resolution chain (flags → env → file, per variable)

The charter pins the **GH_TOKEN pattern**: env vars merge *per variable* over
the resolved instance; a lone `ENSEMBLEWORKS_URL` does **not** discard file
credentials. So the chain resolves the URL first, looks up that URL's file
record, then overlays each env var individually:

```ts
// cli/src/resolve.ts
export interface Conn {
  url: string
  room: string
  auth:
    | { method: 'service-token'; tokenId: string; tokenSecret: string }
    | { method: 'none' }
}

export function resolveConn(flags: Flags, env: Env, hosts: HostsFile): Conn {
  // 1. URL: flag → env → default_instance → error.
  const url = flags.url ?? env.ENSEMBLEWORKS_URL ?? hosts.default_instance
  if (!url) {
    throw new CliError(
      'no instance configured — pass --url, set ENSEMBLEWORKS_URL, or run `ensembleworks auth login`',
    )
  }

  // 2. The file record for THIS url (may be undefined for an env-only instance).
  const rec = hosts.instances[url]

  // 3. Per-variable overlay (GH_TOKEN pattern): a lone ENSEMBLEWORKS_URL keeps rec's creds/room.
  const room = flags.room ?? env.ENSEMBLEWORKS_ROOM ?? rec?.default_room ?? 'team'

  const tokenId = env.ENSEMBLEWORKS_TOKEN_ID ?? rec?.token_id
  const tokenSecret = env.ENSEMBLEWORKS_TOKEN_SECRET ?? rec?.token_secret

  // A service-token pair (from either source) wins; else "none".
  const auth =
    tokenId && tokenSecret
      ? ({ method: 'service-token', tokenId, tokenSecret } as const)
      : ({ method: 'none' } as const)

  return { url, room, auth }
}
```

Key properties this encodes (each pinned by a `resolve.test.ts` case, §13):

- `ENSEMBLEWORKS_URL=https://prod` alone, with `prod` in `hosts.toml` → uses
  prod's file `token_id`/`token_secret`/`default_room` (the lone-URL case).
- `ENSEMBLEWORKS_TOKEN_ID`+`_SECRET` set → override the file pair for whichever
  URL resolved (agent seed case — design §6.1 "resident agents bypass the file").
- `ENSEMBLEWORKS_URL` pointing at an instance **absent** from the file → creds
  come only from env; `method:'none'` if the pair is absent. No file fallback,
  no error (a fully env-driven agent needs no file at all).
- `--room`/`ENSEMBLEWORKS_ROOM`/file `default_room`/`"team"` precedence.

`--url` and `--room` are **global flags** stripped before the verb's argv is
parsed; likewise the global `--refresh`, `--json`, `--dry-run`, and `-h/--help`.

---

## 6. Command architecture & the full command table

### 6.1 Dispatch (D2)

`main.ts` reads `argv[0]` (group) and `argv[1]` (verb), strips global flags,
then `dispatch.ts` resolves in this order:

1. **Native group** — `auth`, `version`, `tools`, `help`/`--help`. Handled by
   `native/` (or `auth/`). `version` and `help` take no verb.
2. **Native (group, verb) pair** — `terminal connect`, `canvas pull-images`.
   Checked *before* the manifest so `connect`/`pull-images` win over any
   like-named future manifest verb.
3. **Manifest-rendered** — `<group>` matches a manifest `plugin` and `<verb>`
   matches a tool `id` in that plugin → `render/run.ts`. Covers all 15 defs,
   `kernel` included (`ensembleworks kernel whoami`).
4. **Extension (Layer 2)** — `ensembleworks <group>` with no manifest match →
   exec `ensembleworks-<group>` **only if it resolves inside the trusted
   `~/.config/ensembleworks/extensions/` directory** — deliberately *not* bare
   `PATH`, a hardening of design §6.3's gh-style sketch. Because this exec
   hands the child the resolved connection env **including
   `ENSEMBLEWORKS_TOKEN_ID`/`_TOKEN_SECRET` (live credentials — §9.3)**, a
   typo'd group (`ensembleworks statsu`) must never hand secrets to whatever
   arbitrary `ensembleworks-statsu` happens to sit on `PATH`; an extension only
   runs because the user placed it in the trusted dir. Symlinks are followed
   but the *entry* must live in the dir; no install/registry machinery in v1.
5. **Error** — unknown group/verb → stderr message with did-you-mean from the
   manifest's verb list, exit 2.

Loading the manifest (for steps 3/5 and `--help`) uses the cache/embedded
snapshot (§6.3) — dispatch never *requires* the network.

### 6.2 The generic renderer arg model (D3)

One `ManifestEntry` → one subcommand. `input` is a JSON Schema object
(`{type:'object', properties, required}`, from zod's `z.toJSONSchema`).

- **Flags.** Every property is `--<kebab>` (`ifRev`→`--if-rev`,
  `sessionId`→`--session-id`, `fromId`→`--from-id`); the exact camelCase is also
  accepted. Booleans are bare `--flag`. Object/array properties take a JSON
  string value, or `--<field> @path` to load it from a file (this is the generic
  replacement for `roadmap push <file>`).
- **Positionals.** Required non-`room` **scalar** fields, in schema property
  order, may be given positionally: `canvas sticky "hi"`,
  `terminal status crew-a working`, `roadmap read "Product Roadmap"`.
- **Raw-body spread.** If argv is exactly one positional token, it parses as a
  JSON object, and no flags are present, it is spread as the request body. This
  carries `canvas shape '{"type":"geo",…}'` and `roadmap write '{"name":…,"ops":…}'`
  1:1. (A sticky whose text is literally a JSON object must use `--text`;
  documented edge.)
- **`room` injection.** Any verb whose schema has a `room` property gets the
  resolved `conn.room` injected (unless the body already set it). Never
  positional, never a flag prompt — mirrors bin/canvas injecting `CANVAS_ROOM`.
- **Method decides location.** `GET`/`DELETE` → the payload is the query string;
  `POST`/`PUT` → JSON body (per `types.ts`).

```ts
// cli/src/render/args.ts (sketch)
export function buildRequest(entry: ManifestEntry, argv: string[], conn: Conn): Req {
  const schema = entry.input as JsonSchema
  const props = schema.properties ?? {}
  // Positional slots: required, non-room, SCALAR-typed only — an array/object
  // required field (e.g. roadmap.write's `ops`) must never occupy a positional
  // slot; it is reachable only via --ops / --ops @file / the raw-body spread.
  const positional = (schema.required ?? []).filter(
    (k) => k !== 'room' && isScalar(props[k]), // string|number|integer|boolean
  )
  const { positionals, flags } = parseArgv(argv, props) // kebab→camel; @file; JSON for obj/array

  let body: Record<string, unknown>
  if (positionals.length === 1 && !Object.keys(flags).length && isJsonObject(positionals[0])) {
    body = JSON.parse(positionals[0]) // raw-body spread (shape, roadmap write)
  } else {
    body = {}
    positional.forEach((k, i) => { if (positionals[i] !== undefined) body[k] = positionals[i] })
    for (const [k, v] of Object.entries(flags)) body[k] = coerce(props[k], v)
  }
  if ('room' in props && body.room === undefined) body.room = conn.room

  validate(schema, body) // D4: structure blocks, value constraints warn
  return entry.method === 'GET' || entry.method === 'DELETE'
    ? { method: entry.method, path: entry.path, query: body }
    : { method: entry.method, path: entry.path, json: body }
}
```

Note that the `required` array's order — which zod's `z.toJSONSchema` emits in
**declaration order** of the `z.object` — is load-bearing for positional
ergonomics: `scribe.say` reads `say <identity> <text>` only because `identity`
is declared before `text` in `contracts/src/tools/scribe.ts`. `args.test.ts`
pins the positional mapping for every multi-positional verb, so a contracts
reorder that would silently change a CLI arg order fails the suite.

### 6.3 Manifest cache & the embedded snapshot (D7)

```
resolve manifest for <instance>:
  1. cache hit  ~/.cache/ensembleworks/manifest-<key>.json  (key = fs-safe slug of url)
     AND envelope.version === MANIFEST_VERSION  → USE IT (never auto-refetch — charter)
  2. cache miss (or --refresh / `tools refresh` / version mismatch):
       try GET <url>/api/tools → write cache → USE IT
  3. fetch failed (offline) OR still mismatched:
       USE the EMBEDDED SNAPSHOT — buildManifest(allTools, CLI_BUILD) from
       @ensembleworks/contracts, compiled into the binary (design §6.3 Layer 1)
```

**Cache-poisoning guard:** the cache file is plain user-writable JSON, so its
contents are *data, not trust*. `http.ts` treats every manifest entry's `path`
as a same-origin **relative** path (`/`-rooted, no scheme, no `//host`) joined
onto the resolved instance URL; anything else — an absolute `https://evil.
example` URL, a protocol-relative `//host/…`, a non-rooted path — is rejected
before any request is built, so a poisoned cache entry can never receive the
`CF-Access-Client-Id/Secret` headers (§8). Pinned by `manifest.test.ts` (§13).

Per-instance keying: different instances may run different server versions /
plugin sets. `envelope.version` is the format version the CLI keys on
(`MANIFEST_VERSION = 1` today); a bump the CLI doesn't understand → ignore
cache, prefer embedded. The embedded snapshot is not a separate artifact — the
CLI depends on `@ensembleworks/contracts`, so `allTools` is compiled in and is
the same source of truth the server serves. This is what lets a long-lived agent
shell render brand-new server verbs (cache refresh) while still working offline
(embedded).

### 6.4 The command table

`room` is injected everywhere it appears (omitted from the Args column).
"rendered" = generic manifest renderer; "native" = hardcoded.

| Command | Positional args | Flags | Kind | Backing route / tool | Output |
|---|---|---|---|---|---|
| `ensembleworks canvas sticky` | `<text>` | `--frame --color --author` | rendered | `POST /api/canvas/sticky` · `canvas.sticky` | `{ok,id}` JSON |
| `ensembleworks canvas shape` | `<json>` (spread) | (or per-field flags) | rendered | `POST /api/canvas/shape` · `canvas.shape` | `{ok,id}` / `{ok,deleted}` JSON |
| `ensembleworks canvas frames` | — | — | rendered | `GET /api/canvas/frames` · `canvas.frames` | frames JSON |
| `ensembleworks canvas frame` | `<name>` | — | rendered | `GET /api/canvas/frame` · `canvas.frame` | frame JSON (was `canvas read`) |
| `ensembleworks canvas pull-images` | `<name> [dir]` | — | **native** | composes `GET /api/canvas/frame` + `/uploads/*` | local paths, one per line |
| `ensembleworks roadmap read` | `[name]` | — | rendered | `GET /api/roadmap/doc` · `roadmap.read` | list (no name) / doc (name) JSON |
| `ensembleworks roadmap write` | `<name>` or `<json>` | `--ops --if-rev` | rendered | `POST /api/roadmap/doc` · `roadmap.write` | `{ok,id,rev,shapesUpdated}` JSON (was `push`/`ops`) |
| `ensembleworks scribe transcript` | — | `--since --limit` | rendered | `GET /api/scribe/transcript` · `scribe.transcript` | transcript JSON |
| `ensembleworks scribe say` | `<identity> <text>` | `--name` | rendered | `POST /api/scribe/transcript` · `scribe.say` | `{ok,entry}` JSON |
| `ensembleworks terminal status` | `<session-id> <status>` | — | rendered | `POST /api/terminal/status` · `terminal.status` | `{ok,updated}` JSON |
| `ensembleworks terminal list` | — | — | rendered | `GET /api/terminal/list` · `terminal.list` | gateways JSON |
| `ensembleworks terminal connect` | — | `--label --gateway-id --dry-run` | **native slot** | WS `/api/terminal/connect` (engine = **#5**) | `--dry-run`: resolved config; else #5 notice |
| `ensembleworks av token` | `<identity>` | `--name --role` | rendered | `GET /api/av/token` · `av.token` | token JSON |
| `ensembleworks av kick` | `<userId>` | — | rendered | `POST /api/av/kick` · `av.kick` | `{ok,disconnected}` JSON |
| `ensembleworks av pulse` | — | `--user-id --rtt-ms` | rendered | `POST /api/av/pulse` · `av.pulse` | pulse JSON |
| `ensembleworks kernel whoami` | — | — | rendered | `GET /api/whoami` · `kernel.whoami` | whoami JSON |
| `ensembleworks kernel participants` | — | `--page` | rendered | `GET /api/participants` · `kernel.participants` | participants JSON |
| `ensembleworks auth login` | — | `--url --method --token-id --token-secret --room` | **native** | verifies via `GET /api/whoami` | human; writes `hosts.toml` |
| `ensembleworks auth status` | — | `--url --json` | **native** | `GET /api/whoami` per instance | human table / `--json` |
| `ensembleworks auth logout` | — | `--url` | **native** | — | human; edits `hosts.toml` |
| `ensembleworks tools` | — | `--json` | **native** | reads cache/embedded | verb table / `--json` |
| `ensembleworks tools refresh` | `[--url]` | — | **native** | `GET /api/tools` | rewrites cache |
| `ensembleworks version` | — | `--json` | **native** | reads manifest `.server` | CLI build + server version |

`--author` is a plain manifest field on `sticky`/`shape`/`write`; the renderer
forwards it with no special-casing. The server (3c) ignores it for credentialed
callers and treats it as a cosmetic badge on `"none"` instances. (The one
bin/canvas nicety not carried: the sticky-only auto `--color light-blue` when
`--author` is set — that is baked verb knowledge; SKILL.md now tells agents to
pass `--color light-blue` explicitly. §12.)

---

## 7. Output & validation posture

### 7.1 Output (D8)

- **Data verbs** (every rendered verb + `pull-images`): print the server's JSON
  response **verbatim to stdout**, nothing else. This preserves the bin/canvas
  agent contract — pipe into `jq`, parse in a skill loop. `pull-images` prints
  one local path per line (its bin/canvas contract).
- **Operator verbs** (`auth status`, `tools`, `version`): human-readable table
  by default; `--json` for machine output. `auth login`/`logout` are
  interactive/human only.
- **Streams.** stdout is *always* clean (data or the requested human view);
  every diagnostic, prompt, and progress line goes to **stderr**. (Mirrors the
  `bin/dev … --json` convention in CLAUDE.md.)
- **Errors.** A non-2xx whose body matters (roadmap `409` carries the current
  `rev`) prints the body to stdout and exits non-zero — the `post_json_body`
  behaviour bin/canvas already relies on. Other transport errors print a
  one-line reason to stderr and exit non-zero. A read-only-token `403` surfaces
  the server's `{error}` verbatim.

### 7.2 Validation posture (D4)

The charter warns: some `zodInput`s are **stricter than the handler's runtime
coercion**, so the CLI must not over-reject (e.g. the handler `trim()`s and
`Number()`-coerces before its own checks). Posture:

- **Block (exit 2, local):** unknown flag; a required field missing after
  positionals+flags; a value that cannot be coerced to the JSON-Schema *type*
  (non-numeric for a `number`, malformed JSON for an object/array field). These
  are structural — the request could not be well-formed.
- **Warn (stderr, still send):** value-constraint failures — `enum`,
  `minLength`/`maxLength`, `minimum`/`maximum`, `pattern`. The server handler is
  the authority and is frequently looser than `zodInput`; the CLI prints
  `warning: <field> <constraint> — sending anyway; server will validate` and
  proceeds. This is what stops the CLI over-rejecting an input the server would
  in fact accept.

Net: the CLI is a helpful *type* front-end, never a stricter gatekeeper than the
route it calls.

---

## 8. Auth — how a request authenticates (D5)

**The CLI authenticates by sending the CF Access service-token header pair, not
a JWT.** On every HTTP request (and the #5 terminal WS handshake) for a
`service-token` instance it sets:

```
CF-Access-Client-Id:     <token_id>
CF-Access-Client-Secret: <token_secret>
```

This is exactly what `gateway-go` sends (`relay/relay.go` lines 143–144). The
flow, end to end:

```
ensembleworks ──(CF-Access-Client-Id/Secret)──►  Cloudflare Access (edge)
                                                    validates the service-token pair,
                                                    injects Cf-Access-Jwt-Assertion (common_name)
                                                        │
                                                        ▼
                                                  origin server (:8788)
                                                    resolveCaller(headers) reads the JWT's
                                                    common_name → service-tokens.toml →
                                                    { kind:'bot', identity:'🤖 …', via:'service-token' }
```

Consequences that shape the CLI (verified against `server/src/whoami.ts` +
`access-identity.ts`):

- **The origin never sees the client-id/secret.** They are consumed at the
  Cloudflare edge, which is why `resolveCaller` only ever looks at
  `Cf-Access-Jwt-Assertion` / `Cf-Access-Authenticated-User-Email`. The CLI
  therefore does **not** construct or sign JWTs and needs no
  `CF_ACCESS_TEAM_DOMAIN`/`AUD` — it holds only the opaque token pair.
- **`method="none"` instances send no auth headers.** A localhost/tailnet
  instance has no Cloudflare Access in front; the origin resolves the caller as
  `{ identity:null, kind:'anonymous', via:'none' }`. (Sending the pair to a
  none-instance is harmless: no edge consumes it, and the origin ignores unknown
  headers.) This is why the CLI stores `method` per instance — to decide whether
  to attach the pair at all.
- **`hosts.toml` stores only `token_id`/`token_secret`** — the raw pair. Nothing
  JWT-shaped, matching the "auth-only file" charter clause.
- **Two other things receive the credentials, and both are guarded.**
  (1) Extension dispatch (§6.1 step 4) execs `ensembleworks-<group>` with
  `ENSEMBLEWORKS_TOKEN_ID`/`_TOKEN_SECRET` in its env — which is exactly why it
  resolves only from the trusted extensions dir, never bare `PATH`. (2) Every
  manifest-rendered request attaches the header pair — which is why `http.ts`
  **only ever requests same-origin relative paths**: a manifest entry's `path`
  is validated to be a relative `/api/…` path and joined onto the resolved
  instance URL; an absolute URL (or protocol-relative / non-`/`-rooted path) in
  a manifest entry is rejected with an error naming the poisoned cache file. A
  tampered `~/.cache/ensembleworks/manifest-*.json` must never be able to
  exfiltrate the auth headers to a third-party host.

### 8.1 `auth login`

Interactive (`--url` skips the URL prompt; the `--method`/`--token-id`/
`--token-secret`/`--room` flags make it fully scriptable for CI):

1. **URL** — prompt (or `--url`).
2. **Method** — `service-token` or `none`.
3. **Credentials** — for `service-token`, paste `token_id` and `token_secret`
   (created in the Cloudflare dashboard — charter: "paste-from-CF-dashboard
   now"). Secret prompt reads without echo.
4. **Verify** — `GET <url>/api/whoami` with the pair as headers. Expect a
   non-null `identity` (`kind:'bot'` for a token, `human` for SSO). A `null`
   identity means the pair was rejected or the URL is a none-instance — the CLI
   says so and offers to store as `method:"none"` or retry. The resolved
   `identity` is cached into the record.
5. **Default room** — prompt (default `"team"`).
6. **Store** — write the `[instances."<url>"]` record and set top-level
   `default_instance = "<url>"` (charter: last login sets the default), `0600`.

**Mint-flow seam (documented, not built — charter):** a future
`auth login --mint` could ask a canvas-side admin route to create+return a
service-token pair, replacing the dashboard paste. The
`common_name → identity` mapping stays server-side in `service-tokens.toml`.
`login.ts` isolates credential *acquisition* behind one function so the mint
path slots in without touching verify/store.

### 8.2 `auth status` / `auth logout`

- `status` — for the resolved instance (or every instance with `--url`
  omitted... i.e. all, when no `--url`), `GET /api/whoami` and print a table:
  URL · reachable? · identity · kind · via. `--json` emits the raw whoami array.
  (Write-scope is deliberately not shown — it is not in the whoami envelope;
  §11-era read-surface concern.)
- `logout` — remove `[instances."<url>"]`; if it was `default_instance`,
  reassign to the first remaining instance or clear the key. Never touches other
  records.

---

## 9. Distribution boundary vs #7, and the `bin/canvas` fate

### 9.1 What #4 does not do

No `bun build --compile`, no `install.sh`, no `release-cli.yml`, no
`ensembleworks-cli` devcontainer feature, no `ensembleworks upgrade`. Those are
sub-project #7. #4 runs the CLI **dev-style** under `bun cli/src/main.ts` via
the `bin/ensembleworks` wrapper.

### 9.2 What #4 owes #7 — compile compatibility

So #7's `--compile` is a no-op, #4 code obeys three rules (the Phase-0
`CLIENT_DIST` lesson, design §2.1):

1. **Static imports only** for anything compiled in — notably `allTools`/
   `buildManifest` from `@ensembleworks/contracts` (the embedded snapshot). No
   dynamic `import()` of verb modules; the manifest is data, not code (design
   §6.3 "no runtime loading of JS plugin code").
2. **Config/cache paths resolve against the real filesystem** (`$HOME/.config`,
   `$HOME/.cache`), never `import.meta`-relative bundle paths (which resolve into
   the compiled binary's virtual FS).
3. **The build version is injected**, not read from a sibling `package.json` at
   runtime (a compiled binary has no sibling). #4 reads it from a
   `CLI_BUILD`-style constant that #7 stamps; in dev it falls back to
   `cli/package.json`'s version (soft, like `SERVER_VERSION`'s `'0.0.0'`).

### 9.3 Extension env contract

Layer-2 extensions receive the resolved connection as `ENSEMBLEWORKS_URL`,
`_ROOM`, `_TOKEN_ID`, `_TOKEN_SECRET` — the same names agents are seeded with
and the same the CLI reads. An extension is thus a first-class agent with no
extra config, in any language. This contract is stable from #4 even though the
distribution of extensions is #7+'s concern. **Because the exec hands live
credentials to the child**, extensions resolve only from the trusted
`~/.config/ensembleworks/extensions/` directory, never bare `PATH` (§6.1
step 4) — placing a file there is the user's explicit trust grant.

### 9.4 `bin/canvas` stays until #8 (D10) — reasoned

The charter retires `bin/canvas` at the **cutover (#8)**, while the SKILL.md
reseed is **atomic with the CLI in #4**. These reconcile cleanly:

- The reseed's atomicity is **within the branch/slice**: after #4 merges to
  `unified-architecture-migration`, the skills say `ensembleworks` *and* the CLI
  builds — never a half-state. The `bin/ensembleworks` dev wrapper (D10) makes
  `ensembleworks` real on the devcontainer PATH from the moment #4 lands, so the
  reseeded skills work in dev **before** #7's compiled artifact exists.
- `bin/canvas` is *not deleted* in #4 because the **production** system still
  runs the old server + `bin/canvas` until the cutover flips env names, paths,
  and installs the binary (#8). Deleting it in #4 would strand nothing on the
  branch but buys nothing either — and keeping it costs nothing (it still works
  against the 3c server; the 3c slice already edited its `cmd_sticky` to send
  `body.author`). #8 deletes `bin/canvas`, `gateway-go/`, `connect.sh` together
  as the charter pins.

Recommendation, stated for the gate: **#4 adds `ensembleworks` (dev wrapper) +
reseeds SKILL.md; #8 deletes `bin/canvas`.** This is not a product decision (the
charter already pins both timings); the only thing #4 *chooses* is the dev
wrapper as the bridge, which is an implementation detail.

---

## 10. The `terminal connect` slot vs #5 (D9)

#4 builds the **slot**; #5 builds the **engine**.

**#4 delivers:**

- `terminal connect` as a native (group, verb) pair (dispatch step 2), winning
  over the manifest `terminal` group.
- Full flag parsing: `--label` (default: `hostname`), `--gateway-id` (default: a
  **stable per-box id**, not bare hostname — a bare hostname would collide and
  trip `resolveGatewayOwner`'s identity binding; charter #5), `--dry-run`,
  plus the global `--url`/`--room`.
- **Connection resolution** through the same chain (§5): url, room, and the auth
  pair the WS handshake will carry as `CF-Access-Client-Id/Secret`.
- **`--dry-run`**: resolve and print the config the connector *would* use
  (url → `wss://…/api/terminal/connect?gatewayId=…&label=…`, room, auth method,
  resolved gateway-id/label) to stdout, exit 0. This fully exercises the
  resolution chain and is unit-tested (§13) — the observable #4 deliverable.
- **Non-`--dry-run`**: print `terminal connect: the connector engine ships in
  sub-project #5` to stderr, exit non-zero. No partial relay code.

**#5 fills** `cli/src/connector/` behind this slot: the relay WS client, the
1s/30s jittered backoff + 20s ping + 1 MiB read-limit + 64-deep shed queues
(charter #5, validated against `relay-loopback.test.ts`), the
`@ensembleworks/contracts/session-manager` PTY wiring, and the gateway-id →
identity binding. The slot's resolved-config object is the exact input #5's
engine consumes, so #5 changes no dispatch or flag code — it implements one
function the slot already calls.

This boundary means #4's `terminal connect` is *observable and tested*
(`--dry-run`) without shipping any of #5's networked machinery — the cleanest
seam that still lets #4 stand alone.

---

## 11. SKILL.md reseed (D11) — concrete

All four files move from the `canvas` CLI to `ensembleworks`, from
`CANVAS_URL`/`CANVAS_ROOM` to `ENSEMBLEWORKS_URL`/`ENSEMBLEWORKS_ROOM`, and adopt
the manifest verb spellings. The reseed lands in **this slice's merge**. `ew` is
mentioned once, in the canvas skill's intro, as the shorthand.

### 11.1 The command rewrite map (applies across all four files)

| Old (`bin/canvas`) | New (`ensembleworks`) | Note |
|---|---|---|
| `canvas frames` | `ensembleworks canvas frames` | — |
| `canvas read <frame>` | `ensembleworks canvas frame <frame>` | **verb rename** read→frame (manifest id) |
| `canvas pull-images <f> [dir]` | `ensembleworks canvas pull-images <f> [dir]` | native (unchanged shape) |
| `canvas status <id> <st>` | `ensembleworks terminal status <id> <st>` | moved to `terminal` group |
| `canvas sticky <t> --frame --color --author` | `ensembleworks canvas sticky <t> --frame --color --author` | pass `--color light-blue` explicitly for agent stickies |
| `canvas shape '<json>'` | `ensembleworks canvas shape '<json>'` | JSON-body spread unchanged |
| `canvas transcript --since --limit` | `ensembleworks scribe transcript --since --limit` | moved to `scribe` group |
| `canvas say <text> --name <n>` | `ensembleworks scribe say <identity> <text> --name <n>` | `identity` now required+positional |
| `canvas roadmap list` | `ensembleworks roadmap read` | list = read with no name |
| `canvas roadmap read <name>` | `ensembleworks roadmap read <name>` | — |
| `canvas roadmap push <name> <file>` | `ensembleworks roadmap write <name> --ops '[{"op":"replace","data":<doc>}]'` (or `--ops @wrap.json`) | push = a replace-op write |
| `canvas roadmap ops <name> '<ops>'` | `ensembleworks roadmap write <name> --ops '<ops>'` | ops = a write |
| env `CANVAS_URL` / `CANVAS_ROOM` | `ENSEMBLEWORKS_URL` / `ENSEMBLEWORKS_ROOM` | every file's env line |

### 11.2 Per-file specifics

- **`canvas/SKILL.md`** — intro paragraph: "The `ensembleworks` CLI (`ew` for
  short) is your whole interface" and the env-var line. Reading block →
  `ensembleworks canvas frames` / `ensembleworks canvas frame <frame>` /
  `ensembleworks canvas pull-images <frame> [dir]`. Writing block →
  `ensembleworks terminal status <session-id> <status>` and
  `ensembleworks canvas sticky <text> --frame <name> --author <crew> --color light-blue`.
  The roadmap block → `ensembleworks roadmap read` (list),
  `ensembleworks roadmap read <name>`, and the `roadmap write --ops …` forms
  (with the `push`→replace-op and `ops` examples). The loop's step-2/4/5 command
  lines updated per the map.
- **`conversation-map/SKILL.md`** — the shape examples (`canvas shape '…'`) →
  `ensembleworks canvas shape '…'`; the poll line `canvas transcript --since` →
  `ensembleworks scribe transcript --since`; the decision-sticky
  `canvas sticky … --frame map --author mapper` →
  `ensembleworks canvas sticky … --frame map --author mapper --color light-blue`;
  the "`canvas read <frame>`" jargon-decode tip → `ensembleworks canvas frame`.
- **`minutes/SKILL.md`** — the two `canvas transcript` lines →
  `ensembleworks scribe transcript`; the setup + closing stickies →
  `ensembleworks canvas sticky … --author scribe --color light-blue`; the
  maintain-one-text-shape block's `canvas shape '…'` create/update →
  `ensembleworks canvas shape '…'`; the `canvas read <frame>` context tip →
  `ensembleworks canvas frame`; `canvas frames` → `ensembleworks canvas frames`.
- **`debugging-roadmap-control/SKILL.md`** — the env block:
  `export ENSEMBLEWORKS_URL=http://localhost:5173` /
  `export ENSEMBLEWORKS_ROOM=debug-roadmap`; the data-plane line
  `bin/canvas roadmap list|read|push|ops …` →
  `ensembleworks roadmap read|write …` (with a one-line note that `push`/`ops`
  are now `write --ops`). `probe.mjs` is unaffected (it drives the browser, not
  the CLI); its `POST` targets are already the `/api/roadmap/doc` route.

The reseed is verified in the manual smoke (§13): after `bin/dev up`, each
reseeded command line runs against the local none-instance and returns the
expected JSON.

---

## 12. Gate-review callouts (consequences of the pinned architecture)

Items 1–6 are not new product decisions — each is *entailed* by decisions the
charter already pinned: (a) the CLI is a faithful generic renderer with no
baked verb knowledge, (b) the 3b manifest is frozen at 15 verbs, and (c) the
ratified 3a route table assigns each route its plugin group. They are surfaced
because they change the muscle-memory spellings agents/humans use, and the user
is reviewing this slice personally. Item 7 is the one genuine scope question.

1. **`canvas read` → `canvas frame`.** The manifest tool id is `frame`
   (`GET /api/canvas/frame`); bin/canvas called it `read`. A faithful renderer
   uses the manifest id. *Recommendation: accept `frame`; the reseeded SKILL.md
   carries agents across.* (Alternative would be a `read`→`frame` native alias =
   baked verb knowledge, which the charter's Layer-1 decision rules out.)
2. **`roadmap list|push|ops` → `roadmap read|write`.** The manifest exposes only
   `roadmap.read` and `roadmap.write`; `list`/`push`/`ops` were bin/canvas sugar
   over those two routes. Ergonomic parity is preserved generically: name-omitted
   `read` = list; `--ops`/`@file`/JSON-body-spread = push/ops. *Recommendation:
   accept; SKILL.md shows the exact `write --ops …` incantations.*
3. **`scribe say` arg order.** `scribe.say` *requires* `identity` (bin/canvas
   defaulted it to `name`). Faithful positional order is
   `say <identity> <text> [--name]`. `say` is a demo/testing verb only.
   *Recommendation: accept.*
4. **Dropped sticky auto-`light-blue`.** bin/canvas defaulted `--color
   light-blue` when `--author` was set — sticky-specific logic a generic renderer
   won't carry. *Recommendation: drop it; SKILL.md instructs `--color
   light-blue` explicitly (already reflected in §11).*
5. **`kernel` verbs are reachable as `ensembleworks kernel whoami|participants`.**
   Faithful rendering exposes the `kernel` group; the friendly identity command
   is `auth status`. *Recommendation: accept — it costs nothing and drifts
   nothing.*
6. **Plugin-group relocations: `canvas status` → `terminal status`, and
   `canvas transcript`/`canvas say` → `scribe transcript`/`scribe say`.**
   Forced by the **ratified 3a route table**: `POST /api/terminal/status`
   belongs to the `terminal` plugin and `GET/POST /api/scribe/transcript` to
   `scribe` (charter 3a: "prefix = plugin id …; the noun survives only as
   leaf/CLI verb"), and a faithful renderer groups verbs by manifest `plugin`.
   These are at least as muscle-memory-breaking as `read`→`frame` —
   `canvas status <id> working|done` is the single most-typed line in the agent
   loop, and every skill's poll loop types `canvas transcript`. Listed here so
   the reviewer sees every spelling change in one table; the complete old→new
   map is §11.1, and the reseeded SKILL.md files carry agents across.
   *Recommendation: accept — the relocation itself was pinned by 3a; the only
   alternative (cross-plugin aliases in the binary) is the baked verb knowledge
   the Layer-1 decision rules out.*
7. **Layer-2 extension dispatch: in or out of #4's scope?** The charter's MVP
   list (all bin/canvas verbs 1:1 + `auth login/status/logout` + native
   `terminal connect`) does not enumerate it; design §6.3 sanctions it as a v1
   layer. It is small (~10 lines of dispatch: resolve `ensembleworks-<group>`
   inside the trusted `~/.config/ensembleworks/extensions/` dir, exec with the
   resolved-connection env per §9.3) and has **no consumer today**. *Case for
   in:* the dispatch fallthrough order (native → manifest → extension → error)
   is cheapest to pin now, and the hardened trusted-dir-only rule (§6.1 step 4)
   ships with it from day one rather than being retrofitted. *Case for out:*
   zero extensions exist, and an exec-that-inherits-secrets path is surface
   shipped ahead of any need — deferring it to a later slice loses nothing but
   the pinned fallthrough. *Recommendation: **in**, with the trusted-dir-only
   hardening — but this is the one line of #4 scope the user can strike with no
   knock-on effects (dispatch then falls straight through to the "unknown
   group" error).*

If the user prefers a familiar-spelling layer (e.g. keep `read`/`push`/`ops`),
that is a **one-place native-alias table** — a small, contained addition — but
it reintroduces exactly the "verb knowledge in the binary" the Layer-1 decision
was chosen to avoid. Flagged, not chosen.

---

## 13. Testing

Seven new self-running `*.test.ts` suites under `cli/src/**` (house convention:
`bun src/<x>.test.ts`, ending `console.log('ok: …')`), **auto-discovered by the
existing `scripts/run-tests.ts` glob** — no runner edit. **Suite count: 45 → 52.**

### Unit (network-free)

1. **`cli/src/resolve.test.ts`** — the resolution chain (§5.2): flag>env>file
   precedence for url/room; the **per-variable merge** (lone `ENSEMBLEWORKS_URL`
   keeps a known instance's file creds; env token pair overrides file;
   `ENSEMBLEWORKS_URL` to an *unknown* instance → env-only, no error, `none` when
   the pair is absent); `default_instance` fallback; the no-instance error.
   `authHeaders` emits the pair only for `service-token`.
2. **`cli/src/hosts.test.ts`** — `hosts.toml` read/write round-trip through
   `smol-toml` (quoted-URL table keys survive); `login` sets `default_instance`;
   `logout` removes the record and reassigns/clears the default; `0600` asserted
   on write; the **read-side perm check** warns on a `0644` file (stderr
   captured) and stays silent on `0600`.
3. **`cli/src/render/args.test.ts`** — argv→request: positional primary args
   (`sticky "hi"`, `terminal status a working`, `say <identity> <text>` — pins
   the declaration-order positional mapping per multi-positional verb); the
   scalar-slot rule (roadmap.write's required `ops` array claims **no**
   positional slot — `write <name> --ops '…'` parses with `name` as the only
   positional); JSON-body spread (`shape '{…}'`, `roadmap write '{…}'`);
   kebab→camel flags (`--if-rev`→`ifRev`, `--session-id`→`sessionId`);
   `--field @file` loader; `room` injection; GET→query vs POST→body by method.
4. **`cli/src/render/validate.test.ts`** — D4 posture: **blocks** on unknown
   flag / missing required / non-numeric for a `number`; **warns-and-sends** on
   enum/min/max violations (asserts the request is still built).
5. **`cli/src/render/manifest.test.ts`** — cache lifecycle: on-miss fetch+write;
   on-hit no refetch; `--refresh` forces; `version` mismatch ignores cache;
   offline (fetch throws) falls back to the embedded `allTools` snapshot; keying
   is per-instance; the **poisoned-path guard** — a cache entry whose `path` is
   `https://evil.example/x`, `//evil.example/x`, or `api/x` (non-rooted) errors
   before any request is built (no fetch observed, no auth headers formed).
6. **`cli/src/native/connect.test.ts`** — `terminal connect --dry-run` resolves
   and prints url/room/gateway-id(default = stable per-box id, not bare
   hostname)/label(default = hostname)/auth-method; non-`--dry-run` prints the #5
   notice and exits non-zero.

### Booted e2e

7. **`cli/src/cli-api.test.ts`** — reuses the `write-scope-api` /
   `attribution-api` pattern: `createSyncApp({ dataDir })` on an ephemeral port,
   temp `hosts.toml`, run `main()` in-process. Cases: `auth login` (method
   `none`) writes the record + verifies via `/api/whoami`; `kernel whoami`;
   `canvas sticky` → `canvas frames` → `canvas frame` round-trip (the note
   appears); anonymous `--author dave` → badged text, no `meta.author` (the 3c
   pass-through, exercised through the CLI's exact wire shape); `roadmap write`
   (a `replace` batch) → `roadmap read`; `tools` fetch populates the cache and a
   second call does not refetch; `version` prints the server string. Output
   discipline asserted: stdout is clean JSON; a roadmap `409` prints the body +
   exits non-zero.

(The `output.ts` human-table paths for `auth status`/`tools`/`version` are
covered inside suites 2/5/7 via `--json` vs default assertions rather than a
separate suite, keeping the count at seven.)

### Manual smoke

`bin/dev up`; then, against the local none-instance:
`ensembleworks auth login --url http://localhost:8788 --method none`;
`ensembleworks canvas sticky "hello" --frame Advice --author crew-a --color light-blue`;
`ensembleworks canvas frame Advice | jq '.notes'` shows the note;
`ensembleworks roadmap read`; `ensembleworks tools` lists 15 verbs;
`ensembleworks terminal connect --dry-run` prints the resolved config. Then run
one command line from each reseeded SKILL.md to confirm the reseed.

---

## 14. Risks

- **R1 — verb-rename churn (§12).** `read`→`frame`, `list/push/ops`→`read/write`
  change agent muscle memory. Mitigated by the atomic SKILL.md reseed (agents
  read the skill, not their memory) and flagged for the gate. The alternative
  (native aliases) is a contained fallback if the user rejects the renames.
- **R2 — over-rejection.** If the CLI enforced `zodInput` strictly it would
  reject inputs the looser handler accepts. Mitigated by D4 (value constraints
  warn, never block). Pinned by `validate.test.ts`.
- **R3 — manifest staleness.** A cached manifest never auto-refreshes (charter),
  so a long-lived shell can render a stale verb set. Mitigated by `--refresh` /
  `tools refresh` and the SKILL.md note; the embedded snapshot guarantees a
  working floor offline. Accepted per the charter's "on-miss + `--refresh`,
  tune" posture.
- **R4 — none-instance credential no-op.** Sending the token pair to a
  none-instance does nothing (no edge to consume it) — an operator could think
  they are authenticated when they are anonymous. Mitigated by `auth login`'s
  verify step surfacing `identity: null` and by `auth status`. Documented in §8.
- **R5 — `smol-toml` dependency.** A third-party runtime dep in a
  soon-to-be-compiled binary. Mitigated: pure-TS, no native code, compiles under
  `--compile`; scope is only `hosts.toml` parse/stringify. Hand-rolling was
  rejected as more error-prone for quoted-URL table keys. Flagged for the #7
  compile check.
- **R6 — `terminal connect` half-slot.** #4 ships a `connect` that only
  `--dry-run`s. A user running plain `connect` gets a non-zero "ships in #5"
  notice, not a hang. Deliberate; the seam is #5's single-function fill (§10).
