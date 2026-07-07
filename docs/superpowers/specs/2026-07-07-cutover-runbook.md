# #8 Cutover runbook — ordered operator procedure

**The executable checklist for the production cutover.** Companion to the
readiness packet (`2026-07-07-cutover-readiness-packet.md`) — that explains
*why*, this is the *what, in order*. Every command is grounded in the actual
`deploy/` scripts. Run the phases top to bottom; do not skip a pre-flight.

**Big-bang posture:** this deploy breaks route shapes, the CLI, env names, and
live connections. Terminal agents restart; canvas users hard-refresh. The one
hard requirement is that production data loads under the new binaries — Phase B
step 1 proves it before anything swaps.

Placeholders: `<ssh-target>` = the prod box tailnet target (e.g.
`mrdavidlaing@ew-donkeyred-001-tailnet`, per the repo CLAUDE.md); `<version>` =
the release version you cut in Phase A (e.g. `0.11.0`).

---

## Phase A — Pre-flight (nothing touches prod yet)

**A1. Land the branch and cut the release.** The artifacts come from CI on a
tag push; you cannot cut over to a version whose GitHub release doesn't exist.

```bash
# from a clean main, merge the track branch
git checkout main && git pull
git merge --no-ff unified-architecture-migration
git push origin main
# cut the release — this is a BREAKING cutover, so major is defensible
deploy/release.sh major        # bumps package.json, tags vX.Y.Z, pushes --follow-tags
```

The tag push triggers `.github/workflows/release-cli.yml`. **Wait for it to go
green** and confirm the GitHub release has the CLI, server, and transcriber
binaries (the `ensembleworks-*` set built by its matrix) plus
`client-dist.tar.gz`, `ensembleworks-checksums.txt`, and `install.sh`. If the
`client-dist` job FAILED, the
`VITE_TLDRAW_LICENSE_KEY` repo secret is unset — fix it and re-run before
proceeding (a missing key = a blank canvas that no later gate catches).

**A2. Prove the machinery locally** (no box):

```bash
bash deploy/test/fake-release.sh     # must end "fake-release: ALL PASS"
deploy/deploy.sh <ssh-target> <version> --dry-run   # local verify half only
```

**A3. Seed the connector's service token on the prod box** — *before* any
terminal agent reconnects. On an authenticated (strict) instance,
`resolveGatewayOwner` rejects a gateway registration whose service-token
`common_name` is not mapped, with only a server-side `console.warn` — remote
terminals vanish silently. Add the connector's token to the prod map and verify:

```bash
ssh <ssh-target>
#  edit ~/.config/ensembleworks/service-tokens.toml — add:
#    [tokens."<common_name>.access"]      # the connector's CF Access common_name
#    identity   = "🤖 <label>"
#    scope      = "read-write"
#  then verify the token resolves:
curl -s -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>" \
     https://<prod-host>/api/whoami        # expect kind:"bot", the mapped identity
```

**A4. Confirm `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` are present in the prod
`sync.env`.** These two are the single switch behind the ENTIRE fail-closed
posture. `cutover-reseed.sh` only renames `CANVAS_*` — it does not touch (or
assert) `CF_ACCESS_*`. Check they're set now, and re-check the boot log in
Phase C:

```bash
ssh <ssh-target> 'sudo -u ensembleworks grep -c CF_ACCESS_ ~/.config/ensembleworks/sync.env'
#  expect >= 2 (TEAM_DOMAIN + AUD). If 0, production will boot header-trust.
```

**A5. Resolve the two #8-must-do items** (readiness packet):

- **Remote terminal boxes need the `ensembleworks-cli` devcontainer feature.**
  At cutover the Go termgw is retired; a remote box reconnects a terminal only
  by running `ensembleworks terminal connect`, which needs the CLI installed via
  a devcontainer feature that **does not exist yet** (`gateway-go/termgw-feature/`
  is the old one). If you use remote terminal boxes, **build that feature before
  cutover** (or keep those boxes on the Go termgw through a transition — but the
  big-bang retires it). If all terminals are local to the prod box, this is moot.
- **SKILL.md on the prod agent sandbox.** `cutover-reseed.sh`'s comment claims
  the SKILL reseed rides the deploy.sh sandbox seed — it does not; deploy.sh
  installs only `AGENTS.md` + `.claude/CLAUDE.md`. The four `.claude/skills/*/SKILL.md`
  were rewritten in-repo (#4) but nothing ships them to the agent home. Confirm
  where prod canvas agents load skills: if from a repo checkout, they're current;
  if from the sandbox home, install the four skill dirs there by hand (or add
  them to the seed) so agents stop invoking the deleted `bin/canvas`.

---

## Phase B — The cutover (the one-shot)

**B1. Run the cutover script.** It is idempotent-safe up to the swap and aborts
before touching `current` if the data-load check fails:

```bash
deploy/cutover.sh <ssh-target> <version>
```

It performs, in order (all on the box):

1. **Data-load check** — boots the fetched server against a *copy* of the live
   `DATA_DIR` with `EW_WARM_ROOMS=1`, forcing every `rooms/<room>.sqlite`
   through the new `@tldraw` schema. **A room that fails to load aborts the
   cutover** ("ABORT: do NOT cut over") — nothing has changed on the box; the
   old release is still `current`. Investigate the failing room before retrying.
2. **DATA_DIR backup** → `~ensembleworks/backups/pre-cutover-<ts>` (reflink copy,
   exempt from the KEEP prune — your cross-era rollback point).
3. **Env reseed** — `CANVAS_*` → `ENSEMBLEWORKS_*` in `sync.env`/`scribe.env`/`term.env`.
4. **Era-cross deploy** — `EW_ALLOW_ERA_CROSS=1 deploy.sh` (the one sanctioned
   crossing): fetch + checksum + pre-swap boot-check + stamp `.ew-era` +
   install prod units/Caddyfile + **swap `current`** + restart units + prune.
5. Prints the manual canvas-render gate (Phase C).

---

## Phase C — Post-swap verification (do NOT declare success until all pass)

**C1. Canvas render (mandatory).** Open the prod canvas URL in a hard-refreshed
/ incognito window. The tldraw editor must **render** — toolbar + shapes
visible, not a blank white frame. A blank frame means the license key was
missing at CI build time; re-run `release-cli.yml` with the secret set and
redeploy. No automated layer catches this.

**C2. Auth posture.** Confirm production booted verified, not header-trust:

```bash
ssh <ssh-target> 'sudo journalctl -u ensembleworks-sync -n 30 | grep "auth posture"'
#  expect: "auth posture: verified (CF Access JWT signatures checked)"
#  if "header-trust" — CF_ACCESS_* did not survive the reseed (A4). Fix and redeploy.
```

**C3. Terminals reconnect.** The deploy already restarts the local `term` unit
(`systemctl restart ensembleworks-sync ensembleworks-term`), so the box-local
gateway comes back on its own. **Remote** connector boxes reconnect via their
own backoff once the server is up — but only if their `terminal connect` uses
the A3 service token and the A5 CLI is installed. Confirm the roster:

```bash
curl -s https://<prod-host>/api/terminal/list   # expect every gateway back
```

A missing box means its connector was refused — re-check A3 (its token's
`common_name` is in the prod map) and A5 (the CLI/devcontainer feature is
installed on that box). Restart that box's connector after fixing.

**C4. Users hard-refresh** the canvas (breaking route/asset changes).

---

## Phase D — Rollback

- **Within the new era** (a later post-cutover release misbehaves): re-run
  `deploy/deploy.sh <ssh-target> <older-version>` — its fetched dir is still
  present, so it's an instant symlink swap.
- **Across the era boundary** (back to the pre-cutover world): unsupported by
  design (a pre-cutover binary can't read post-cutover data). The mitigation is
  the Phase-B2 backup: restore `~/backups/pre-cutover-<ts>` over `DATA_DIR`, then
  deploy a pre-cutover release with `EW_ALLOW_ERA_CROSS=1`. Expect data written
  *after* the cutover to be lost — this is a last resort, not a routine rollback.

---

## Phase E — After the cutover is confirmed good (retirements + backlog)

Once Phase C is green and stable, on `main` (a follow-up commit + release):

**Must-delete** (superseded, verified present today, retire now):

```bash
git rm -r gateway-go/ sample-remote-terminal/connect.sh bin/canvas
#  (release-termgw.yml already deleted by #7; node-pty / Node pins already gone)
```

**Then:**
- Build the `ensembleworks-cli` devcontainer feature if not already done in A5;
  retire `gateway-go/termgw-feature/` with the rest of `gateway-go/`.
- Fold the SKILL.md-to-sandbox fix into the deploy seed (A5) if that's the
  topology.
- **Phase 4** (docStore generalisation + all-routes-become-tools + the `/mcp`
  server) is queued on the branch — a gated slice, independent of the cutover.

---

## Quick reference

| Step | Command | Gate |
|---|---|---|
| Cut release | `deploy/release.sh major` (from clean main) | release-cli.yml green + assets present |
| Local proof | `bash deploy/test/fake-release.sh` | ALL PASS |
| Dry run | `deploy/deploy.sh <target> <ver> --dry-run` | swap plan, no box touched |
| Service token | edit `service-tokens.toml` + `/api/whoami` | kind:bot resolves |
| CF Access env | `grep -c CF_ACCESS_ sync.env` | ≥ 2 |
| **Cutover** | `deploy/cutover.sh <target> <ver>` | data-load passes → swap |
| Canvas render | open prod URL | editor renders, not blank |
| Auth posture | `journalctl -u ensembleworks-sync \| grep "auth posture"` | `verified` |
| Terminals | `curl /api/terminal/list` | gateways present |
| Rollback (era) | restore `~/backups/pre-cutover-*` + era-cross deploy | last resort |
