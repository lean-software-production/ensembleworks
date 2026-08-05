# `ew auth` — gh-style login to a remote canvas

**Date:** 2026-07-21
**Status:** design (companion to
[`2026-07-21-ew-codespaces-design.md`](./2026-07-21-ew-codespaces-design.md);
not yet built)
**Supersedes:** the `GATEWAY_SECRET` registration-auth requirement carried in
[`distributed-terminals-design.md`](./distributed-terminals-design.md) — for
deployments behind Cloudflare Access, connector registration authenticates
via Access identity instead (§4). The shared secret remains only as the
escape hatch for non-Access deployments.

---

## Why

Everything in the Codespaces design that dials a remote canvas — `ew codespace
up --canvas <url>`, the injected connector's outbound WSS — needs credentials,
and today the story is "obtain a CF Access token / `GATEWAY_SECRET` somehow
and pass it as env." That's fine for a spike and hostile to everyone else.

The target UX is `gh auth`:

```
$ ew auth login
? Canvas URL: https://canvas.leansoftware.ai
Opening browser to authenticate…
✓ Logged in as sam@leansoftware.ai (via GitHub)
```

One input (the canvas URL), the **same browser SSO the user would do to open
the canvas normally**, and every later `ew` command resolves credentials
silently by origin.

## The enabling fact

The canvas's auth boundary is **Cloudflare Access** in front of the
deployment, GitHub as IdP (`server/src/access-identity.ts`). Access already
has a first-class CLI login flow — it is exactly what `cloudflared access
login` does. So `ew auth` is a **credential helper over Access**, not an auth
system:

- **No EW-issued tokens, no EW user database.** Identity stays wholly in
  Access + the GitHub IdP; the server keeps verifying `Cf-Access-Jwt-Assertion`
  exactly as it does today.
- **No mandatory `cloudflared` dependency.** The CLI-login dance is a couple
  of HTTP endpoints plus a loopback listener — implemented natively in `ew` so
  the one-binary host-prerequisite story holds. (Shelling out to `cloudflared`
  when present is an acceptable v0 shortcut.)

## 1. `ew auth login` — the flow

1. **Probe the URL.** Hit any canvas route unauthenticated. Three outcomes:
   - **302 to `<team>.cloudflareaccess.com`** → behind Access; do the browser
     leg. The team domain (and AUD) are **discovered from the redirect, never
     prompted for** — the URL is the only thing the user ever types.
   - **Plain 200** → no auth boundary (local dev / header-trust tunnel).
     Store `auth = "none"` and finish.
   - Anything else → clear error, nothing stored.
2. **Browser leg.** Start a loopback HTTP listener on a random port; open the
   browser at Access's CLI-login endpoint with the loopback as redirect
   target. The user completes the same GitHub SSO as for the canvas itself —
   with a live Access session it's a zero-click bounce. The redirect delivers
   the token to the loopback listener. No browser available → print the URL
   for the user to open elsewhere and paste the code back (§3).
3. **Store gh-style**, in `~/.ew/hosts.toml`, keyed by canvas **origin** — a
   laptop may talk to several canvases (staging + prod), and every command
   taking `--canvas <url>` resolves creds by origin with no extra flags:

```toml
["canvas.leansoftware.ai"]
user = "sam@leansoftware.ai"
auth = "access-browser"        # or "none" | "service-token"
```

4. **Companion verbs**, straight from gh:
   - `ew auth status` — per host: who, token expiry, canvas reachability.
   - `ew auth token [--canvas <url>]` — print a fresh app token for scripting.
   - `ew auth logout [--canvas <url>]` — drop stored creds.

## 2. Token lifetime vs. connector lifetime

Access **app tokens** expire on the Access session schedule (typically ~24 h);
a connector's WSS registration runs for weeks. Consequences:

- The connector must never hold the token as a static secret. The exec-time
  env var of the Codespaces design (§2.1.3 there) covers only the **initial**
  dial.
- **The host is the token refresher.** `ew auth login` stores the long-lived
  Access **org token**; from it the host can mint fresh app tokens silently,
  browser-free (the same mechanism cloudflared uses). This slots directly
  into "host owns the lifecycle": the same host process that supervises the
  connector hands it a fresh token on every (re)connect.
- Only a truly expired org session bounces the user back through
  `ew auth login`; `ew auth status` and the canvas's gateway list should
  surface "credential expired" as a distinct state, not a generic disconnect.

Open sub-decision: the refresh channel between host and connector — a tiny
local socket the connector queries, a host-driven re-exec with fresh env, or
the host proactively pushing before expiry. Interacts with reconciler
packaging (Codespaces design §5.5): whichever process the reconciler runs in
must also be able to mint tokens.

## 3. Headless hosts

- **Bot / CI / worker-VM sessions → CF Access service tokens**, which the
  server already recognises and maps to a bot identity + write scope
  (`server/src/service-tokens.ts`). `ew auth login --service-token` reads
  `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` from env and stores the
  host entry as `auth = "service-token"`. Access does not offer an OAuth
  device flow; for machine identities service tokens are the better fit
  anyway (per-token revocation, named identity, scoped).
- **Human on a browserless box** (SSH'd into a worker VM): fallback is the
  classic relay — print the login URL to open on the laptop, paste the
  resulting code back into the terminal. Worth having, low priority.

## 4. Retiring `GATEWAY_SECRET`

Once the connector dials in through Access — app token or service-token
headers on the WSS upgrade — the server receives a **verified per-user (or
per-bot) identity on every gateway registration**, instead of one shared
secret. Strictly better:

- **Ownership & attribution for free** — registrations bind to the
  authenticated identity (the `gateway-owner` machinery already exists).
- **Per-person revocation** via Access, instead of team-wide secret rotation.
- **One auth story** for browsers, the `ew` CLI, and connectors.

`GATEWAY_SECRET` survives only as the explicit escape hatch for deployments
not behind Access (e.g. bare local dev), and should be logged as such at
startup.

## Open decisions (tracked)

1. Host↔connector token-refresh channel (§2) — socket vs. re-exec vs. push.
2. v0 shortcut: shell out to `cloudflared` if installed, or go native
   immediately (§ "enabling fact").
3. Storage hardening for `~/.ew/hosts.toml` — plaintext-with-0600 (gh's
   posture) vs. OS keychain integration.
