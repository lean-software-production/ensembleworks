# EW Codespaces netguard — egress proxy design

**Date:** 2026-07-21
**Status:** approved design (brainstorming output; implementation not started)
**Builds on:** [`2026-07-21-ew-codespaces-coexistence-design.md`](2026-07-21-ew-codespaces-coexistence-design.md)
and the architecture docs it refines. **This spec assumes all five coexistence
sub-projects are complete:** `ew codespace up` boots devcontainers with the
connector injected via the `~/.ew/runtime/` overlay; the Codespace shape with
header and input ACL is live; the reconciler restores Codespaces on boot; and
`ew auth login` stores per-origin credentials in `hosts.toml` with host-side
token refresh.

---

## 1. Goal

Every Codespace gets **netguard**, a host-side egress proxy that:

- **(a) vaults credentials** — processes inside the devcontainer (coding
  agents above all) never see live API credentials. The container holds
  placeholders; netguard swaps in real values at egress.
- **(b) filters registry traffic** — npm installs are checked against a
  package-age quarantine and the OSV advisory feed before bytes reach the
  container.
- **(c) enforces an egress allowlist** — default-deny with full logging, so
  the team can see, control, and audit every endpoint a Codespace reaches.

Netguard is **on by default for every Codespace**. It is not the hardened
isolation tier (gVisor / OpenShell) — that remains a separate, stronger,
opt-in profile per the architecture doc's §3. Netguard is the everyday
defense: coding agents run in ordinary Codespaces, and credential
exfiltration is the everyday risk. The legacy `:8789` tmux terminal path is
untouched.

**Inspiration:** OpenShell and DevGuard. The placeholder-swap vault and the
single egress choke point are their playbook; netguard reimplements the
minimal slice as an `ew`-owned component rather than adopting either tool
(§9 records why).

## 2. Enforcement primitive: network topology

Configuration can be ignored; topology cannot. `ew codespace up` attaches
the devcontainer to a per-Codespace Docker network created with
`internal: true`. The only other endpoint on that network is netguard,
listening on the host side of the bridge. The container has **no route** to
the internet — bypass is topologically impossible, not merely discouraged.

- `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` are set inside the container so
  well-behaved tools cooperate, but they are convenience, never the
  enforcement.
- **Build time is unaffected.** Image and feature pulls run through the
  host's Docker daemon, outside the internal network.
  `postCreateCommand` / `postStartCommand` run inside the confined container
  and therefore hit the allowlist — which is correct: that is exactly where
  malicious installs execute. The built-in baseline allowlist (§5) must
  cover common bootstrap traffic from day one.
- **Escape hatch:** `ew codespace up --net=open` disables confinement for
  that Codespace. The choice is narrated at `up` time and stamped into the
  gateway registration metadata (`netPolicy: 'guarded' | 'open'`), so it is
  visible server-side and on the shape header.

## 3. The netguard proxy

One netguard process per Codespace, spawned and supervised by `ew` alongside
`devcontainer up` (restart-on-crash, same supervision as the connector's
host-side pieces). A dead proxy **fails closed**: the container loses
egress; terminals stay alive and the connector's relay WSS reconnects
through the restarted proxy.

Netguard treats destinations three ways:

### 3.1 Credential hosts — TLS terminated, credentials injected

Hosts: `api.anthropic.com` (and peer LLM APIs), `api.github.com`,
`github.com` (HTTPS git), and the canvas origin (for the connector's own
token — see below).

- `ew` generates one CA per machine, once (private key 0600, never enters
  the container); netguard mints leaf certificates from it per destination
  host on demand. The CA **certificate** rides the existing `~/.ew/runtime/`
  read-only overlay into the container: system trust store,
  `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, `SSL_CERT_FILE`.
- Real credential values live host-side in
  `~/.config/ensembleworks/vault.toml` (0600). The container environment
  carries **placeholders**: `ANTHROPIC_API_KEY=ew-vault-anthropic-<nonce>`,
  `GITHUB_TOKEN=ew-vault-github-<nonce>`, and git credential-helper config
  pointing at the placeholder. Netguard replaces a placeholder with the real
  value only when it appears in a credential position (`Authorization`,
  `x-api-key`, basic-auth userinfo) **and** the request targets the
  placeholder's matching host. A placeholder exfiltrated by a compromised
  agent is worthless, and injection happens only on requests that would
  legitimately have used the credential.
- **The connector's CF Access token gets the same treatment.** Today the
  host passes it as exec-time env on every (re)connect (auth design §3).
  With netguard, the connector's env holds a placeholder and netguard
  injects the real service-token headers on the relay WSS CONNECT — finally
  satisfying the auth doc's "the connector must never hold the token as a
  static secret" in full.
- **SSH keys never enter the container.** Codespaces standardize on HTTPS
  git remotes; there is nothing to vault because the key does not exist
  inside. (`ew codespace up` warns when the checkout's `origin` is an SSH
  remote and offers to rewrite it.)

### 3.2 Registry hosts — TLS terminated, installs filtered

Hosts: `registry.npmjs.org` in v1; PyPI and crates.io pass through as plain
allowlisted tunnels (§3.3) until their enforcement lands as fast-followers.

Netguard inspects package metadata and tarball requests and rejects a
version when:

- **Age quarantine:** the version was published fewer than N days ago
  (default 5; per-repo override in `.ew/netguard.toml`). Malicious hijack
  and typosquat versions are usually reported and yanked within days;
  age-gating closes that window without any vendor dependency.
- **Advisory feed:** the version is flagged malicious in OSV. Netguard
  queries OSV in batch and caches verdicts host-side with a TTL.

A blocked install returns an HTTP error whose body names the package, the
policy that fired, and the copyable override
(`ew codespace net allow-pkg <name>@<version>`). Everything else passes
through byte-identical.

### 3.3 All other allowlisted hosts — opaque tunnel

Matched by SNI, passed through as a raw CONNECT tunnel: no TLS termination,
no CA involvement, no content inspection. Hosts not on the allowlist get the
connection refused — and logged.

## 4. Allowlist model

Three layers, merged (later layers extend, never shrink, the earlier ones —
except `--net=open`, which bypasses everything):

1. **Built-in baseline**, shipped with `ew`: package registries, github.com
   and `*.githubusercontent.com`, common LLM APIs, the canvas origin, OS
   package mirrors (apt/apk), and devcontainer-feature sources.
2. **Per-repo** `.ew/netguard.toml`, committed to the repository — extra
   hosts the project needs, reviewed like code because it arrives in the
   diff.
3. **Per-user host-side overrides** via
   `ew codespace net allow <host> [--once]`, persisted next to the
   Codespace's desired-state entry.

Wildcards are per-label (`*.example.com`). A host entry may carry
`mode = "tunnel-only"`, which forces §3.3 treatment even for a credential or
registry host — the escape for cert-pinning clients that break under TLS
termination. Tunnel-only trades inspection and injection away for that host,
so netguard logs the downgrade loudly at startup.

**Logging.** Every allow and deny decision is appended as JSONL under
`~/.local/share/ensembleworks/netguard/<gatewayId>/`. `ew codespace net log
[--blocked] [--follow]` tails it. The full log stays host-side; only blocked
events travel to the canvas (§6).

## 5. Configuration & data at rest

| Artifact | Location | Notes |
|---|---|---|
| CA key + cert | `~/.config/ensembleworks/netguard-ca/` | key 0600, cert copied into `~/.ew/runtime/` overlay |
| Credential vault | `~/.config/ensembleworks/vault.toml` | 0600; `ew vault set anthropic\|github\|…` to manage |
| Baseline allowlist | embedded in the `ew` binary | versioned with `ew` releases |
| Per-repo policy | `<repo>/.ew/netguard.toml` | allowlist additions, quarantine-days override, per-host `tunnel-only` |
| Per-user overrides | alongside `~/.ew/codespaces.json` | reconciler restores them with the Codespace |
| Egress log | `~/.local/share/ensembleworks/netguard/<gatewayId>/*.jsonl` | rotated by size |
| OSV verdict cache | `~/.local/share/ensembleworks/netguard/osv-cache/` | TTL-bound |

The reconciler treats netguard as part of a Codespace's desired state: on
boot it re-runs `clone-if-absent → up → inject → netguard → connect`, so a
rebooted host comes back guarded without user action.

## 6. Canvas surfacing (in v1)

Blocked egress must be visible where the team already looks — it explains
"why isn't my install working" and advertises that the guard exists.

- **Event path.** Netguard is a host process that already holds the owner's
  Access credentials, so it reports directly:
  `POST /api/gateway/:id/netguard-events` on the canvas origin, batched
  (flush every ~5 s when non-empty), carrying blocked events only —
  `{ts, host, verdict, rule}`. The endpoint reuses the gateway identity
  binding (`resolveGatewayOwner` pattern): only the registered owner's
  identity may post events for that gateway.
- **Server → shape.** The server keeps a rolling tail (last ~50 blocked
  events) in the gateway registry entry — not in the CRDT doc — and stamps a
  summary onto the Codespace shape via the existing server-side stamp-back
  pattern (screenshare `stillUrl` precedent): `blockedCount`,
  `lastBlockedAt`, plus the `netPolicy` badge state from §2. The tail is
  fetched on demand (`GET /api/gateway/:id/netguard-events`), never synced.
- **UI.** The Codespace shape header gains a shield badge: quiet at zero,
  "🛡 N" with a recency pulse after recent blocks, and a distinct "open"
  state when `netPolicy = 'open'`. Clicking opens a panel listing recent
  blocked events (`time — host — rule`) with the copyable fix command.
  Visible to everyone in the room; like the input-policy toggle, display is
  decoration and enforcement stays server/host-side.
- **Contracts.** Badge and panel are interaction-bearing surfaces →
  interaction contracts declared in `@ensembleworks/interaction-contracts`,
  run red-then-green, implemented in both adapters, per CLAUDE.md.
- **Best-effort telemetry.** If the events POST fails (canvas unreachable,
  token expired), netguard keeps logging locally and retries lazily.
  Enforcement never depends on canvas reachability.
- **Engine:** legacy tldraw first, same as the Codespace shape itself; the
  shared `contracts` props definition (`blockedCount`, `lastBlockedAt`,
  `netPolicy` added to `codespaceShapeProps`) is the canvas-v2 porting seam.

## 7. Build vs. embed — the spike gate

A dated spike (same discipline as the coexistence spec's Bun-compat spike)
answers: can a Bun/TS implementation comfortably do CONNECT proxying,
selective TLS termination with SNI-keyed certificates, streaming
passthrough, and WebSocket upgrade passthrough for the connector's relay
WSS? Suspects: `tls.createServer` SNI callbacks under Bun's node-compat,
HTTP/2 to upstreams, backpressure on large tarball streams.

- **Pass** → netguard is a TS component in `cli/`, embedded in the one `ew`
  binary next to the connector and the devcontainer CLI.
- **Fail** → fallback is a pinned single-binary Go proxy embedded as an
  asset and driven entirely by `ew`-written config; `ew` still owns
  lifecycle, vault, allowlist, and logging.

No embedding work proceeds before the spike verdict is recorded in this
spec's execution notes.

## 8. Failure modes

| Failure | Behavior |
|---|---|
| netguard crash | Fail closed: egress stops, terminals live, supervisor restarts it, connector WSS reconnects through it |
| Cert-pinning client breaks under MITM | Per-host `tunnel-only` mode (§4); logged loudly |
| Placeholder leaked (agent prints env) | Harmless by design — documents say so explicitly so nobody panics |
| Canvas unreachable for event POSTs | Local logging continues; lazy retry; enforcement unaffected |
| OSV feed unreachable | Age quarantine still enforced; OSV check skipped with a logged warning (availability over a hard registry outage) |
| Vault missing a credential | Placeholder passes through unreplaced; upstream rejects it with a 401 — same failure the user would see today, plus a netguard log line naming the missing vault key |

## 9. Why build, not adopt

OpenShell and DevGuard own their whole sandbox lifecycle. Adopting either
wholesale collides with what `ew codespace up` already owns — devcontainer
lifecycle, the runtime overlay, the connector — and makes a third-party
daemon a hard runtime dependency of every Codespace. Netguard reimplements
the minimal proxy slice under `ew`'s existing lifecycle instead. Both tools
remain candidates for the **hardened tier**, where owning the whole sandbox
is the point.

## 10. Testing posture

- **Unit:** placeholder-swap rewriting (credential-position matching, host
  matching, nonce handling); allowlist merge and wildcard matching;
  age/OSV policy evaluation against fixture registry metadata.
- **Loopback integration:** real netguard process against a fake upstream
  TLS server — assert injection on credential hosts, blocking off-allowlist,
  tunnel passthrough byte-fidelity, WSS upgrade passthrough (pattern:
  `server/src/connector-loopback.test.ts`).
- **Conformance smoke test grows a netguard leg:** boot a real devcontainer
  confined behind netguard; `npm install` a known-old package (passes);
  attempt a fresh-version install (blocked, correct error body); `curl` an
  off-list host (refused); assert the connector reached the canvas through
  the proxy and the blocked events arrived at the shape.
- **ACL/identity test:** a non-owner identity POSTing to
  `/api/gateway/:id/netguard-events` is rejected (mirrors the input-ACL
  matrix tests).
- **Spike verdict** (§7) recorded, dated, before implementation.

## 11. Explicitly out of scope (v1)

- SSH agent brokering or any SSH credential story (HTTPS remotes only).
- Per-process attribution of egress (unattributable/spoofable from outside
  the container).
- PyPI / crates.io enforcement (passthrough tunnels until fast-followers).
- DNS-level controls or DoH interception.
- The hardened isolation tier itself (gVisor / OpenShell profiles).
- Any change to the legacy `:8789` tmux gateway or shared-VM terminals.
