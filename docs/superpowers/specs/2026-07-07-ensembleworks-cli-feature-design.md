# The `ensembleworks-cli` devcontainer feature — repackaging termgw onto the Bun CLI

**Phase 3, #8-must-do — the devcontainer feature that unblocks remote terminal
boxes at cutover.** At cutover the Go termgw retires wholesale
(`gateway-go/`, incl. `gateway-go/termgw-feature/`) and a remote box can
reconnect a canvas terminal in exactly one way: run `ensembleworks terminal
connect`. That needs a devcontainer feature that installs the `ensembleworks`
CLI (#7's release binary) and runs the connector under the same background
supervisor pattern the Go feature used. This spec is that feature — a faithful
repackaging of `gateway-go/termgw-feature/` onto the new CLI + env contracts,
with **no new behaviour**: same entrypoint-chained supervisor, same
restart-on-exit loop, same fail-loud-on-missing-URL guard, same tmux policy.

Conforms to the plugin-architecture track charter
(`2026-07-06-plugin-architecture-track-charter.md`) §"#5 — Connector / #6 —
Transcriber" (the clean-break env mapping, the shared `canvasTmuxSpawnSpec`
helper, single-binary packaging) and §"#7 — Distribution / #8 — Cutover"
(the devcontainer-feature rewrite is assigned to #8; #7 shipped `install.sh`
only). It is the readiness-packet **A5 / #8-must-do #1** prerequisite
(`2026-07-07-cutover-readiness-packet.md`,
`2026-07-07-cutover-runbook.md` §A5). House style follows the connector +
distribution design docs.

The thing under replacement is `gateway-go/termgw-feature/`
(`devcontainer-feature.json`, `install.sh`, `termgw-entrypoint.sh`,
`termgw-supervisor.sh`); the pieces it must consume instead are #7's
`deploy/install.sh` (arch-detect + checksum-verify), the `ensembleworks
terminal connect` slot (`cli/src/native/connect.ts`), the resolution chain
(`cli/src/resolve.ts` + `cli/src/hosts.ts`), and the shared tmux policy
(`contracts/src/session-manager.ts` `canvasTmuxSpawnSpec`, driven by
`TMUX_CONF`).

---

## 1. Scope boundary — what this slice is and is not

**IS:**

- A new, self-contained devcontainer feature at **`deploy/features/ensembleworks-cli/`**
  (§2): `devcontainer-feature.json`, `install.sh`, `entrypoint.sh`,
  `supervisor.sh`, and a committed copy of `tmux-ensembleworks.conf`.
- A build-time root installer that puts the `ensembleworks` binary in
  `/usr/local/bin`, ships the supervisor/entrypoint/conf under
  `/usr/local/share/ensembleworks-connect/`, and bakes the non-secret connector
  config into `/etc/ensembleworks-connect.env` (§5).
- A supervisor that runs `ensembleworks terminal connect` with resolved
  flags/env instead of `/usr/local/bin/termgw` (§6), consuming the CLI's own
  stable-per-box gateway-id default rather than reimplementing it (§4).
- **A connector-side token scrub in `contracts/src/session-manager.ts`** (§4.2):
  `canvasTmuxSpawnSpec` strips the credential env vars before merging
  `process.env` into the spawned tmux env, so a hosted canvas terminal can never
  read the machine's service-token. This closes a **net-new** exposure created
  by this slice (the feature is what makes the token exist) and hardens both the
  server gateway and the connector at once.
- The option → env/flag mapping table (§3) and the verification plan (§8).

**IS NOT:**

- **Not the deletion of `gateway-go/termgw-feature/`.** That retires with the
  rest of `gateway-go/` in the cutover's Phase-E must-delete
  (`2026-07-07-cutover-runbook.md` §E). This new feature stands alone and works
  now; leaving the old one in place until Phase E means a remote box can stay on
  the Go termgw through the transition if its cutover slips (§7).
- **Not a change to `cli/` or `deploy/install.sh`.** The feature consumes them
  verbatim. `terminal connect` flag/resolution code is unchanged; the CLI's
  `stableGatewayId` is the gateway-id default. **The one `contracts/` change** is
  the token scrub in `canvasTmuxSpawnSpec` (§4.2) — a hardening no-op wherever
  the credential vars are unset, so it changes no existing behaviour.
- **Not a local-dev dependency.** This repo's own `.devcontainer/` does not
  reference the feature (readiness packet §#8-must-do #1) — it is a deploy
  artifact remote boxes/Codespaces reference. Hence its home under `deploy/`,
  not `.devcontainer/` (§2).
- **No new bun-test *files*, but the suite grows by one case.** The devcontainer
  scripts are shell + JSON (unit-tested only by shellcheck/`bash -n`), but the
  §4.2 scrub is TypeScript in `contracts/` and ships with a TDD unit test —
  **the suite moves 59 → 60** (§8 states the gate).

---

## 2. Where the feature lives — `deploy/features/ensembleworks-cli/`

**Decision: `deploy/features/ensembleworks-cli/`.** Justification:

1. **`gateway-go/` retires wholesale**, so the new feature must not live under
   it (or it dies with the directory it is meant to replace).
2. **It is a deploy/release artifact, not this repo's local devcontainer
   config.** `.devcontainer/features/` is the idiom for a feature *this* repo's
   own devcontainer consumes; the readiness packet is explicit that local
   `.devcontainer/` does **not** depend on this feature. `deploy/` already owns
   the sibling artifacts a remote box needs — `deploy/install.sh` (the CLI
   bootstrap), `deploy/tmux-ensembleworks.conf` (the canonical conf),
   `deploy/systemd/`, `deploy/deploy.sh`/`cutover.sh`. The feature belongs with
   them.
3. **Remote boxes reference it from the repo.** A consumer's `devcontainer.json`
   names it by a path the devcontainer CLI resolves — a git/OCI ref
   (`ghcr.io/lean-software-production/ensembleworks/ensembleworks-cli:1`) or a
   subtree path. Either way the *source of truth* is one directory in-repo;
   publishing to a registry is a follow-up packaging concern, not a
   spec-blocking one.

Layout:

```
deploy/features/ensembleworks-cli/
├── devcontainer-feature.json     # §3 manifest
├── install.sh                    # §5 root, image-build installer
├── entrypoint.sh                 # §6 entrypoint-chained supervisor launcher
├── supervisor.sh                 # §6 restart-on-exit loop → `terminal connect`
├── tmux-ensembleworks.conf       # committed copy of deploy/tmux-ensembleworks.conf (§5.1)
└── README.md                     # consumer usage + the token-secret guidance (§4)
```

**Self-containment constraint (§5.1):** a devcontainer feature ships as a
self-contained directory — when a remote box references it by OCI/git ref, only
the feature dir's contents travel. The feature therefore cannot reach
`../../deploy/tmux-ensembleworks.conf` at install time; it ships its **own
committed copy**, kept byte-identical by a diff check in the gate (§8).

---

## 3. The option → env/flag mapping (the clean break)

The old feature had three options (`canvasUrl`, `gatewayLabel`, `gatewayId`)
and no auth — it was built for the anonymous spike. The strict prod instance
now requires a CF Access service token (readiness packet operator-prereq #1).
The charter's §"#5" env mapping is the clean break:

| Feature option | Old name | Delivered as | Consumed by |
|---|---|---|---|
| `url` | `canvasUrl` | env `ENSEMBLEWORKS_URL` in `/etc/ensembleworks-connect.env` | `resolveConn` (flag→env→hosts.toml) |
| `gatewayLabel` | `gatewayLabel` | shell var `EW_LABEL` → supervisor passes `--label` **only when non-empty** | `parseConnectFlags`; **omitted ⇒ CLI defaults to hostname** |
| `gatewayId` | `gatewayId` | shell var `EW_GATEWAY_ID` → supervisor passes `--gateway-id` (only if set) | `parseConnectFlags`; **empty ⇒ CLI's `stableGatewayId`** |
| `tokenId` | *(none)* | env `ENSEMBLEWORKS_TOKEN_ID` (**not baked unless set** — §4) | `resolveConn` → `authHeaders` (`CF-Access-Client-Id`) |
| `tokenSecret` | *(none)* | env `ENSEMBLEWORKS_TOKEN_SECRET` (**not baked unless set** — §4) | `resolveConn` → `authHeaders` (`CF-Access-Client-Secret`) |
| `version` | *(none; Go binary vendored)* | build arg → which `ensembleworks-<arch>` release to fetch | `install.sh` |
| *(fixed)* `TMUX_CONF` | `TMUX_CONF` | `containerEnv` (manifest) + redundant in env file | connector `tmuxConfPath` → `canvasTmuxSpawnSpec` |

Two deliberate shape choices:

- **`url`/`token*` are env** because `resolveConn` reads them from env (or a
  lone `--url` flag). **`label`/`gatewayId` are flags** because
  `parseConnectFlags` only accepts `--label`/`--gateway-id` — there is no env
  form. So the env file carries `EW_LABEL`/`EW_GATEWAY_ID` as plain shell vars
  that the supervisor turns into flags (§6). This mirrors the old feature, which
  likewise baked `GATEWAY_LABEL`/`GATEWAY_ID` for the supervisor to pass to
  termgw's flags.
- **Nothing is baked when the option is empty** (the `emit` guard, §5) — so an
  unset `url` produces no `ENSEMBLEWORKS_URL` line and the supervisor's
  fail-loud guard fires (§6), rather than a silent misconfigure.
- **`--label` must be conditional, not always-passed.** `resolveConnectConfig`
  computes `label = flags.label ?? hostname()` (nullish coalescing), so passing
  `--label ""` sets an **empty** label — it does **not** fall back to hostname.
  The supervisor therefore guards `[ -n "$EW_LABEL" ] && args+=(--label …)` (§6.2)
  and only appends the flag for a non-empty option; an unset `gatewayLabel` omits
  the flag entirely and the CLI's hostname default applies. Do not "simplify"
  this to an unconditional `--label "$EW_LABEL"`.

### 3.1 The manifest — `devcontainer-feature.json`

```json
{
	"id": "ensembleworks-cli",
	"version": "1.0.0",
	"name": "EnsembleWorks CLI + terminal connector",
	"description": "Installs the `ensembleworks` CLI and runs `ensembleworks terminal connect`, so this container hosts canvas terminal shapes via the EnsembleWorks relay. Replaces the retired Go termgw feature.",
	"options": {
		"version": {
			"type": "string",
			"default": "latest",
			"description": "Which ensembleworks release to install (e.g. 0.11.0), or 'latest'."
		},
		"url": {
			"type": "string",
			"default": "",
			"description": "EnsembleWorks instance base URL the connector dials -> ENSEMBLEWORKS_URL, e.g. https://canvas.example.com. Required unless supplied at runtime."
		},
		"gatewayLabel": {
			"type": "string",
			"default": "",
			"description": "Human label shown in the New-terminal picker -> --label (defaults to the container hostname)."
		},
		"gatewayId": {
			"type": "string",
			"default": "",
			"description": "Stable gateway id -> --gateway-id. Leave empty to let the CLI derive a stable per-box id (hostname + machine-id); set only to pin a friendly id."
		},
		"tokenId": {
			"type": "string",
			"default": "",
			"description": "CF Access service-token id -> ENSEMBLEWORKS_TOKEN_ID. SECURITY: a value here is BAKED INTO THE IMAGE LAYER (readable by anyone with the image). Only for trusted or throwaway images; prefer runtime injection (see README)."
		},
		"tokenSecret": {
			"type": "string",
			"default": "",
			"description": "CF Access service-token secret -> ENSEMBLEWORKS_TOKEN_SECRET. SECURITY: same image-layer warning as tokenId. Prefer runtime injection."
		}
	},
	"entrypoint": "/usr/local/share/ensembleworks-connect/entrypoint.sh",
	"containerEnv": {
		"TMUX_CONF": "/usr/local/share/ensembleworks-connect/tmux-ensembleworks.conf"
	}
}
```

`version` bumps to `1.0.0` (semver, clean-break from the old `termgw@0.2.0`).
`containerEnv.TMUX_CONF` matches the old feature exactly and reaches the
backgrounded supervisor (containerEnv is baked into the container's process env;
§4 explains why that matters).

---

## 4. The token secret — the one real design decision

A CF Access service-token secret baked into an image layer is readable by anyone
who can pull the image. The old feature dodged this only by predating auth. Two
constraints frame the choice:

1. **`resolveConn` reads the token from env `ENSEMBLEWORKS_TOKEN_ID/_SECRET`, or
   from `~/.config/ensembleworks/hosts.toml`** (the per-variable overlay). So
   the connector needs *no* build-baked secret if the token reaches it another
   way.
2. **The supervisor is backgrounded from the feature entrypoint at container
   init** (§6). It inherits `containerEnv` and any `docker run -e` /
   `--env-file` / Codespaces-`secrets` value (those set the container's process
   env), but **not** `remoteEnv` — `remoteEnv` is applied by the devcontainer
   CLI only to interactive/exec sessions and lifecycle hooks, not to the
   container's init-chained entrypoint. The old `install.sh` says exactly this
   ("remoteEnv … does not reliably reach a backgrounded daemon") and that is why
   it baked config at build.

Given that, the token story:

- **Default (recommended): do NOT bake the secret.** Leave `tokenId`/
  `tokenSecret` empty. Deliver the token at **runtime as container process env**
  — a Codespaces `secrets` entry, a `--env-file`, or `docker run -e
  ENSEMBLEWORKS_TOKEN_ID=… -e ENSEMBLEWORKS_TOKEN_SECRET=…`. These reach the
  entrypoint→supervisor (constraint 2), and `resolveConn` picks them up. No
  secret in the image. This is the strict-prod path and the README's headline.
- **Alternative (also no image secret): a mounted/written `hosts.toml`.** Run
  `ensembleworks auth login` in the container (or mount a `hosts.toml`);
  `resolveConn` overlays the file's creds. Caveat: the supervisor's `$HOME`
  decides which `hosts.toml` is read — so this path requires the supervisor to
  run as the user who owns that file (the entrypoint runs as the container's
  default user; if that is root, the file must be `/root/.config/…`). The env
  path (above) sidesteps `$HOME` entirely, which is why it is preferred.
- **Escape hatch (baked, warned): the `tokenId`/`tokenSecret` options exist**
  for trusted/throwaway images (a private registry, a short-lived CI box). When
  set, `install.sh` writes them into `/etc/ensembleworks-connect.env` and the
  manifest description + README shout the image-layer exposure. This preserves
  the old feature's build-bake ergonomics for whoever knowingly wants them,
  without making it the default.

**`url` is baked freely** — it is not a secret. Baking it (not runtime-injecting
it) is what lets the supervisor fail loud on a genuinely-unconfigured feature
rather than boot-looping (§6).

### 4.1 The gateway-id default — rely on the CLI, don't reimplement

The charter requires a **stable per-box id, not bare hostname** (hostname
collisions trip the server's `resolveGatewayOwner` binding). `connect.ts`
already implements this: `stableGatewayId(env)` = `hostname + machine-id`, or
`hostname + persisted-random-suffix` when `/etc/machine-id` is absent. **The
feature does not duplicate this.** When the `gatewayId` option is empty the
supervisor passes no `--gateway-id`, and the CLI derives the stable id itself.

Container caveat (state it, don't fight it): a plain devcontainer image usually
ships no `/etc/machine-id`, so `readMachineId()` returns null and the CLI falls
to the persisted `~/.config/ensembleworks/gateway-id` random suffix. That file
lives in the container's config volume, so the id is **stable for the box's
lifetime** — which is exactly what reconnect needs. Set the `gatewayId` option
only to pin a human-friendly id across container rebuilds.

### 4.2 Connector-side token scrub — closing the net-new exposure (the crux)

**The hole.** `canvasTmuxSpawnSpec` (`contracts/src/session-manager.ts`) builds
the tmux spawn env by spreading the whole parent process env:

```ts
const env: Record<string, string> = {
	...(process.env as Record<string, string>),
	TERM: 'xterm-256color',
	COLORFGBG: '0;15',
}
```

The connector runs `terminal connect` with `ENSEMBLEWORKS_TOKEN_ID` /
`ENSEMBLEWORKS_TOKEN_SECRET` in its process env (that is how `resolveConn`
authenticates). So **every hosted canvas terminal inherits the connector's full
env**, and any teammate granted a terminal on that box can run `env | grep
ENSEMBLEWORKS_TOKEN_SECRET` and walk off with the machine's service-token —
a credential that authenticates *write* access to the instance. The old Go
termgw had **no** auth, so no such token existed on the box; this exposure is
**net-new at cutover, and this feature is precisely what creates the token**.
It must therefore be closed in this slice, not deferred.

**The fix — strip the credential vars before the spread.** A shared constant
list of sensitive keys, removed from the copied env inside `canvasTmuxSpawnSpec`
so a hosted terminal never sees them:

```ts
/** Credential env vars the connector/gateway hold to authenticate, that a
 *  hosted canvas terminal must never inherit (it would let any terminal user
 *  exfiltrate the machine's service-token). Stripped in canvasTmuxSpawnSpec. */
export const SPAWN_ENV_SCRUB = [
	'ENSEMBLEWORKS_TOKEN_ID',
	'ENSEMBLEWORKS_TOKEN_SECRET',
	'CF_ACCESS_CLIENT_ID', // belt-and-suspenders: the pre-clean-break spelling
	'CF_ACCESS_CLIENT_SECRET',
] as const

// inside canvasTmuxSpawnSpec, replacing the bare spread:
const parentEnv = { ...(process.env as Record<string, string>) }
for (const k of SPAWN_ENV_SCRUB) delete parentEnv[k]
const env: Record<string, string> = {
	...parentEnv,
	TERM: 'xterm-256color',
	COLORFGBG: '0;15',
}
```

Properties that make this safe and in-scope:

- **`canvasTmuxSpawnSpec` is the single shared spawn helper** used by BOTH the
  server gateway (`terminal-gateway.ts`) and the connector
  (`cli/src/connector/`). One edit hardens both planes.
- **It is a no-op wherever those vars are unset** — the anonymous/dev gateway,
  relay-loopback, and connector-loopback paths never set them, so every existing
  test stays green. It only ever removes a key that is present.
- **It does not touch `TMUX_CONF`, `ENSEMBLEWORKS_URL`, `ENSEMBLEWORKS_ROOM`,**
  `TERM`, or `COLORFGBG` — a hosted terminal keeps everything it legitimately
  needs; only the write-credential is withheld.

**This is what makes the runtime-token default (§4) genuinely safe:** injecting
the token as container process env is only sound because the scrub guarantees it
stops at the connector and never reaches a terminal the token itself grants.

**TDD unit test** (ships with the change; the suite moves 59 → 60):

```ts
// contracts/src/session-manager.test.ts  (new case)
// RED first: with the bare spread, the secret leaks into the spawn env.
import { canvasTmuxSpawnSpec } from './session-manager.ts'

process.env.ENSEMBLEWORKS_TOKEN_SECRET = 'shhh-machine-cred'
const spec = canvasTmuxSpawnSpec({ sessionId: 't1' })
if ('ENSEMBLEWORKS_TOKEN_SECRET' in spec.env) throw new Error('token leaked into spawn env')
if (spec.env.TERM !== 'xterm-256color') throw new Error('scrub clobbered TERM')
delete process.env.ENSEMBLEWORKS_TOKEN_SECRET
console.log('ok: canvasTmuxSpawnSpec scrubs the service-token from the spawned terminal env')
```

Discovered by `scripts/run-tests.ts` (the self-running `bun src/x.test.ts`
convention). Write the assertion first against the unmodified helper to see it
fail (proving the leak is real), then add `SPAWN_ENV_SCRUB` to make it pass.

### 4.3 Documented defaults & footguns

- **Room is hard-pinned to `'team'`.** `resolveConn` defaults `room` to `'team'`
  (no env/flag reaches it through the supervisor's invocation), and the feature
  exposes **no room option** — matching the old termgw, which was also
  single-room. A multi-room operator injects `ENSEMBLEWORKS_ROOM` as container
  runtime env (it flows through `readEnv` → `resolveConn`); the feature does not
  bake it.
- **Runtime env wins over the baked file (no stale-token footgun).** A naive
  `. /etc/ensembleworks-connect.env` would let a *stale build-baked* token
  silently override a *rotated runtime* one. The supervisor instead sources the
  baked file **key-by-key, skipping any key already present in the environment**
  (§6.2), so a runtime-injected value always wins and the baked file acts only as
  a fallback. The escape-hatch baked token is thus overridable without a rebuild.
- **`version: "latest"` bakes a non-reproducible layer.** With the default,
  two builds days apart can install different binaries and the image layer is not
  content-addressable to a known version. The README's consumer example **pins an
  explicit `version`** (e.g. `"0.11.0"`); `latest` is documented as convenience
  for throwaway boxes only.

---

## 5. `install.sh` — root, image-build (adapts `deploy/install.sh`)

Runs at image build as root, with the feature dir as cwd; option values arrive
as uppercased env vars (`url` → `URL`, `gatewayLabel` → `GATEWAYLABEL`, …). It
adapts `deploy/install.sh`'s arch-detect + checksum logic (that installs to
`~/.local/bin` as the user; here we install **system-wide to `/usr/local/bin` as
root at build**), and folds in the old feature's tmux-install + env-bake.

```bash
#!/usr/bin/env bash
# ensembleworks-cli devcontainer feature installer. Runs at image build as root,
# feature dir as cwd. Option values arrive as uppercased env vars
# (url->URL, gatewayLabel->GATEWAYLABEL, gatewayId->GATEWAYID,
#  tokenId->TOKENID, tokenSecret->TOKENSECRET, version->VERSION).
set -euo pipefail

REPO="lean-software-production/ensembleworks"
VER="${VERSION:-latest}"
SHARE="/usr/local/share/ensembleworks-connect"

# 1. tmux (the connector spawns tmux sessions; same as the old feature).
if ! command -v tmux >/dev/null; then
	apt-get update && apt-get install -y --no-install-recommends tmux ca-certificates curl
	rm -rf /var/lib/apt/lists/*
fi

# 2. Fetch + checksum-verify the ensembleworks binary for THIS container's arch
#    (Linux only inside a container). Adapted from deploy/install.sh; installs
#    system-wide as root instead of ~/.local/bin as the user.
case "$(uname -s)-$(uname -m)" in
Linux-x86_64) A=linux-x64 ;;
Linux-aarch64) A=linux-arm64 ;;
*) echo "ensembleworks-cli: unsupported container platform $(uname -sm)" >&2; exit 1 ;;
esac
base="https://github.com/$REPO/releases/latest/download"
[ "$VER" = latest ] || base="https://github.com/$REPO/releases/download/v$VER"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$base/ensembleworks-$A" -o "$tmp/ew"
curl -fsSL "$base/ensembleworks-checksums.txt" -o "$tmp/sums"
(cd "$tmp" && grep " ensembleworks-$A\$" sums | sed "s/ensembleworks-$A/ew/" | sha256sum -c -)
install -D -m 0755 "$tmp/ew" /usr/local/bin/ensembleworks
ln -f /usr/local/bin/ensembleworks /usr/local/bin/ew

# 3. Ship the supervisor, entrypoint, and tmux conf (self-contained: the conf is
#    a committed copy of deploy/tmux-ensembleworks.conf — §5.1).
install -D -m 0755 ./supervisor.sh "$SHARE/supervisor.sh"
install -D -m 0755 ./entrypoint.sh "$SHARE/entrypoint.sh"
install -D -m 0644 ./tmux-ensembleworks.conf "$SHARE/tmux-ensembleworks.conf"

# 4. Bake the NON-SECRET connector config into an env file the supervisor
#    sources at runtime. Options are baked at BUILD time (no reliance on
#    remoteEnv reaching a backgrounded daemon — §4).
#    emit KEY='value', single-quoting so labels with spaces survive `.` sourcing
#    (the old feature's lesson: an unquoted space ran the tail as a command).
emit() {
	[ -n "$2" ] || return 0
	printf "%s='%s'\n" "$1" "$(printf '%s' "$2" | sed "s/'/'\\\\''/g")"
}
{
	echo "# generated by ensembleworks-cli feature install.sh"
	emit ENSEMBLEWORKS_URL "${URL:-}"
	emit EW_LABEL "${GATEWAYLABEL:-}"
	emit EW_GATEWAY_ID "${GATEWAYID:-}"
	# SECURITY (§4): only baked when the operator set the option. Prefer runtime
	# env injection — a baked secret is readable in the image layer.
	emit ENSEMBLEWORKS_TOKEN_ID "${TOKENID:-}"
	emit ENSEMBLEWORKS_TOKEN_SECRET "${TOKENSECRET:-}"
	emit TMUX_CONF "$SHARE/tmux-ensembleworks.conf"
} >/etc/ensembleworks-connect.env
# 0600, root-owned: unlike the old /etc/termgw.env (which never held a secret),
# this file CAN carry a baked token (§4 escape hatch) on a box that hosts
# arbitrary canvas terminals. 0600 keeps a terminal user from reading it. The
# URL isn't sensitive, but always-0600 is harmless and removes a mode-branch.
# The supervisor runs as root (entrypoint is root at container init), so root
# ownership is the correct run-as owner; adjust if a feature consumer relocates
# the supervisor to a non-root user.
chmod 0600 /etc/ensembleworks-connect.env

echo "ensembleworks-cli feature installed (version=${VER}, arch=${A}, url=${URL:-<runtime>})"
```

Notes:

- **Checksum-verify is preserved verbatim** from `deploy/install.sh` — the
  `grep … | sed … | sha256sum -c -` guards a tampered/partial download. `curl`
  and `ca-certificates` are ensured in step 1 (a slim base image may lack them).
- **`/etc/ensembleworks-connect.env` is `0600`, root-owned** — tightened from the
  old `/etc/termgw.env`'s `0644`. The old file never held a secret; this one can
  (the §4 baked-token escape hatch) on a box that hosts arbitrary canvas
  terminals, and `0644` would let any terminal user read the credential. `0600`
  closes that. The supervisor runs as root (the entrypoint is root at container
  init), so root is the correct owner and can still source it; the URL isn't
  sensitive, but always-`0600` is harmless and avoids a token-vs-no-token mode
  branch. This is defence-in-depth alongside the §4.2 scrub (which stops the
  token reaching a terminal's *process env*) and the recommended runtime-token
  default (which bakes nothing into this file at all).

### 5.1 tmux.conf — a committed copy

The connector's `canvasTmuxSpawnSpec` applies `-f "$TMUX_CONF"` when the file
exists (missing conf degrades clipboard/status-bar, never crashes). The
canonical conf is `deploy/tmux-ensembleworks.conf` (also what
`server/src/terminal-gateway.ts` points at). Because a feature must be
self-contained (§2), the feature ships a **committed copy**
`deploy/features/ensembleworks-cli/tmux-ensembleworks.conf`, kept byte-identical
by the §8 diff check. `containerEnv.TMUX_CONF` (manifest) points the connector
at the installed copy; the env file carries it redundantly for the backgrounded
supervisor.

---

## 6. `entrypoint.sh` + `supervisor.sh` — same pattern, new command

Identical structure to the Go feature: the entrypoint (chained ahead of the
container's main command, so it runs as persistent init — not a
postStartCommand daemon the CLI reaps) launches the supervisor once in the
background via `setsid`, then `exec "$@"`. The supervisor is a restart-on-exit
loop that sources the env file, guards on missing URL, and runs the connector.
Only the paths, the process name, and the command-under-supervision change.

### 6.1 `entrypoint.sh`

```bash
#!/usr/bin/env bash
# ensembleworks-cli feature entrypoint. The devcontainer CLI chains feature
# entrypoints ahead of the container's main command, so this runs as part of the
# container's persistent init (unlike a postStartCommand daemon, which the CLI
# reaps when its exec returns). Launch the connector supervisor in the
# background, then exec the original command so the container behaves normally.
set -u

# Liveness check (not a flag file): /tmp survives `docker stop`/`start` but the
# processes do not, so a flag would leave the connector dead after a restart.
# Idempotent if the entrypoint is re-invoked live.
if ! pgrep -f ensembleworks-connect/supervisor.sh >/dev/null 2>&1; then
	setsid /usr/local/share/ensembleworks-connect/supervisor.sh \
		>>/tmp/ensembleworks-connect.log 2>&1 </dev/null &
fi

exec "$@"
```

### 6.2 `supervisor.sh`

```bash
#!/usr/bin/env bash
# Restart-on-exit supervisor for the ensembleworks connector (spike-grade;
# systemd is not available inside devcontainers). Config is baked into
# /etc/ensembleworks-connect.env at feature-install time from the feature
# options (URL/label/id, and optionally a token) — no reliance on remoteEnv
# reaching this backgrounded process. A token may instead arrive via the
# container's runtime env (§4); either way it is in this process's environment.
set -u

# Source the baked file KEY-BY-KEY, setting only keys NOT already in the
# environment — so a token rotated at container runtime (§4) always wins over a
# stale build-baked value. A plain `. file` would clobber runtime env with the
# baked value; this makes the baked file a fallback, not an override.
if [ -f /etc/ensembleworks-connect.env ]; then
	while IFS='=' read -r key val; do
		case "$key" in ''|'#'*) continue ;; esac   # skip blanks + the header comment
		[ -n "${!key:-}" ] && continue             # runtime value present — keep it
		val=${val#\'}; val=${val%\'}               # strip the single-quotes emit() added
		export "$key=$val"
	done < /etc/ensembleworks-connect.env
fi

# Fail loudly once instead of an infinite 2s crash loop when unconfigured.
if [ -z "${ENSEMBLEWORKS_URL:-}" ]; then
	echo "[ensembleworks-connect] ENSEMBLEWORKS_URL unset — set the 'url' feature option or inject it at runtime" >&2
	exit 1
fi

# label/gateway-id are FLAGS (no env form). Pass --label ONLY when non-empty:
# resolveConnectConfig uses `label = flags.label ?? hostname()`, so --label ""
# would set an EMPTY label, NOT fall back to hostname. Omitting the flag is what
# gives the hostname default. Likewise pass --gateway-id ONLY when pinned — an
# empty id lets the CLI derive its stable per-box id (§4.1).
args=(terminal connect)
[ -n "${EW_LABEL:-}" ] && args+=(--label "$EW_LABEL")
[ -n "${EW_GATEWAY_ID:-}" ] && args+=(--gateway-id "$EW_GATEWAY_ID")

while true; do
	ensembleworks "${args[@]}"
	echo "[ensembleworks-connect] connector exited ($?), restarting in 2s" >&2
	sleep 2
done
```

Notes:

- **`ensembleworks terminal connect`** replaces `/usr/local/bin/termgw`. The URL
  and token come from env (the key-by-key source above → `readEnv`/`resolveConn`);
  the label and gateway-id come from flags (`parseConnectFlags`). This is the
  exact invocation surface `connect.ts` accepts — verified against its flag
  parser in §8.
- **Runtime env beats the baked file.** The key-by-key source (not `. file`)
  means a `-e ENSEMBLEWORKS_TOKEN_SECRET=…` rotated at `docker run` overrides a
  stale baked token without an image rebuild (§4.3). The baked file is a
  fallback for keys the runtime did not set.
- **Bash arrays** (`args=(…)`) require a `bash` shebang, which both scripts have.
  The connector already reconnects internally with the pinned jittered backoff,
  so the 2s outer loop only covers a hard process exit (a crash or an
  unrecoverable dial), matching the Go supervisor's role.
- **The fail-loud guard** is preserved: an unconfigured feature exits once with a
  clear message rather than boot-looping, and the entrypoint's liveness check
  won't relaunch a cleanly-configured process it already started.

---

## 7. Retirement — leave the delete to Phase E

**This slice does NOT delete `gateway-go/termgw-feature/`.** It retires with the
rest of `gateway-go/` in the cutover runbook's Phase-E must-delete
(`git rm -r gateway-go/ …`, `2026-07-07-cutover-runbook.md` §E). Rationale:

- The must-delete boundary is verified as one unit at cutover ("all verified
  still present, boundary held" — readiness packet §#8-must-delete). Splitting
  the termgw-feature deletion out early breaks that single, checked boundary for
  no gain.
- The new feature is **additive and standalone**: it lives in a different
  directory, installs a different binary, and works the moment a release exists.
  A remote box can cut to it independently of when `gateway-go/` is deleted —
  and can even stay on the Go termgw through a slipped transition (runbook §A5
  offers exactly that fallback) precisely because both features coexist until
  Phase E.

So the deliverable is the new feature dir; the old dir's removal is a Phase-E
line, unchanged.

---

## 8. Verification plan + the gate

The devcontainer scripts are shell + JSON (not bun-tested); the §4.2 scrub is
TypeScript in `contracts/` and ships with a TDD unit test. **The suite moves
59 → 60** — the one new case is the scrub test (V5). The gate is a scripted,
evidence-producing check:

| # | Check | Command | Pass |
|---|---|---|---|
| V1 | Manifest is valid JSON | `jq . deploy/features/ensembleworks-cli/devcontainer-feature.json >/dev/null` | exit 0 |
| V2 | Shell scripts lint clean | `nix run nixpkgs#shellcheck -- deploy/features/ensembleworks-cli/{install,entrypoint,supervisor}.sh` | exit 0, no findings (the key-by-key source loop uses no `.`/`source`, so no SC1091 to suppress) |
| V3 | Shell scripts parse | `for f in install entrypoint supervisor; do bash -n deploy/features/ensembleworks-cli/$f.sh; done` | exit 0 |
| V4 | tmux conf is in sync | `diff deploy/tmux-ensembleworks.conf deploy/features/ensembleworks-cli/tmux-ensembleworks.conf` | no diff |
| V5 | **Token scrub (TDD, §4.2)** | `bun contracts/src/session-manager.test.ts` (set `ENSEMBLEWORKS_TOKEN_SECRET`, assert absent from `canvasTmuxSpawnSpec().env`, `TERM` still present) | `ok: …`, exit 0 |
| V6 | Connect invocation matches real flags | `ensembleworks --url https://x.test terminal connect --label demo --gateway-id demo-1 --dry-run` (built CLI) | prints `ConnectConfig` JSON, exit 0 |
| V7 | Feature builds + installs (smoke) | `devcontainer build` a throwaway container referencing the feature with a pinned `version`, then exec `ensembleworks --version` | binary present, version prints |

- **V1–V5 are the hard gate** — cheap, deterministic, no network. They must pass
  for the slice to land. V5 is written RED-first (see the leak before the scrub).
- **V6 is the contract check.** It proves the supervisor's invocation
  (`terminal connect --label … [--gateway-id …]`, URL via `--url`/env) is
  exactly what `parseConnectFlags`/`resolveConnectConfig` accept, using the CLI's
  own `--dry-run` (which prints the resolved config and exits 0 without dialing).
  Run against the CLI built on this branch. This is the check that would catch a
  flag rename between the feature and `connect.ts`.
- **V7 is the realistic integration proof and is gated on a real release
  existing.** The `@devcontainers/cli` is available (CLAUDE.md). `version`
  defaults to `latest`, which needs a published `ensembleworks-<arch>` asset —
  present after #7's `release-cli.yml` has run for any tag. When a release
  exists, build a throwaway container that references the feature (a minimal
  `devcontainer.json` with `features: { "./deploy/features/ensembleworks-cli": { "url": "https://x.test" } }`),
  and confirm `ensembleworks --version` runs and
  `/tmp/ensembleworks-connect.log` shows the supervisor started (it will loop
  trying to dial `https://x.test`, which is the expected "configured but no
  server" behaviour; point `url` at a real instance to see it register). If no
  release exists yet at spec-execution time, V6 is deferred to the first
  post-#7 tag and the slice lands on V1–V5 with V6 documented as the
  release-gated follow-up.
- **`devcontainer features test`** (the official harness) is the heavier
  alternative to V7; it needs a `test/<feature>/` scenario dir and still a real
  release binary. V7's `devcontainer build` is the lighter equivalent and is the
  recommended proof; the `features test` harness is optional polish, not a gate
  requirement.

**Gate summary:** V1–V6 green is the merge gate; V7 green when a release exists
(else documented as the release-gated follow-up). Suite moves 59 → 60 (the §4.2
scrub test is the one added case; the devcontainer scripts add no bun tests).

---

## 9. Consumer usage (for the feature README)

A remote box's `devcontainer.json`, strict-prod path (no baked secret):

```jsonc
{
  "features": {
    "ghcr.io/lean-software-production/ensembleworks/ensembleworks-cli:1": {
      "url": "https://canvas.example.com",
      "gatewayLabel": "workshops box",
      "version": "0.11.0"
    }
  },
  // token via a runtime secret (Codespaces secret / --env-file / -e), NOT remoteEnv:
  "containerEnv": {
    "ENSEMBLEWORKS_TOKEN_ID": "${localEnv:ENSEMBLEWORKS_TOKEN_ID}",
    "ENSEMBLEWORKS_TOKEN_SECRET": "${localEnv:ENSEMBLEWORKS_TOKEN_SECRET}"
  }
}
```

`containerEnv` (not `remoteEnv`) is used for the token so it reaches the
init-chained supervisor (§4). On an anonymous/dev instance, omit the token
entirely. The README leads with this pattern and states the image-layer warning
for the baked `tokenId`/`tokenSecret` escape hatch.

Three defaults the README calls out (§4.3): (a) **`version` is pinned** in the
example (`"0.11.0"`), not left at `latest` — `latest` bakes a non-reproducible
layer, fine only for throwaway boxes; (b) **the connector is single-room
(`'team'`)** — the feature has no room option, so a multi-room operator adds
`ENSEMBLEWORKS_ROOM` to the same `containerEnv` block; (c) **a runtime token
overrides a baked one** (the supervisor sources the baked file only for unset
keys), so rotating `-e ENSEMBLEWORKS_TOKEN_SECRET=…` needs no rebuild.
