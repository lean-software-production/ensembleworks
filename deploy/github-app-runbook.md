# GitHub App runbook — `ensembleworks[bot]`

How to create and install the GitHub App that lets the EnsembleWorks agent commit
and push **as a bot**, with narrowly-scoped, short-lived credentials. This is the
push half of the commit-identity model:

- **Author/committer** of agent commits = this App's bot (`ensembleworks[bot]`),
  never a human and never a personal account.
- **Humans** are credited with `Co-authored-by:` trailers, sourced from the
  Cloudflare Access identity (see the server work, not this doc).

## Why a GitHub App (and not a PAT or the Access OAuth App)

> **Two box models.** On the **legacy ash box** the whole mob shares the single
> `ensemble` user's shell, so the reasoning below ("any credential on the box is
> mob-readable") holds and the App key itself is exposed — mitigated only by short
> tokens + rotation. On the **new prod boxes** terminals are dropped to a separate
> `ensembleworks-agent` sandbox user that *cannot* read the app user's home, so the
> App key is kept out of mob reach entirely and the mob mints tokens through a
> sudo wrapper — see "On segregated boxes" below. The token-scope reasoning here
> applies to both; only the *key's* exposure differs.

The legacy ash box is a **single `ensemble` user the whole mob has shell access to**
(see `../README.md` "Security model"). So **any credential on that box is readable
by everyone in the room.** The scope here is **deliberately broad** — the App is
installed on **all org repos** with **Contents + Pull requests + Workflows write**,
because the mob wants to drive any repo (and its CI) from inside EnsembleWorks. Since
breadth is intentional, the safety rests entirely on the *other* controls:

- **Short-lived tokens** — the App's private key mints installation tokens that
  expire in ~1 hour, so a leaked token has a 1-hour blast radius. Mint a per-repo
  token (`gh-app-token.bash --repos <repo>`) when a job only needs one repo.
- **PR-only via branch protection** — protect `main` on *every repo whose `main`
  matters* (not just `ensembleworks`): the bot can push branches and open PRs but a human
  merges with their own creds. This is the real safety valve, and because the token
  reaches all org repos it must be set repo-by-repo.
- **Workflows are reachable** — `workflows: write` + mob access means the room can
  edit `.github/workflows/` (which often run with elevated CI secrets). Treat CI
  changes as in-scope for the room; require review on workflow files where it matters.
- **Instant revocation** — rotate the private key or uninstall the App to cut all
  access immediately (see Revocation).

A PAT is long-lived (bad here) and a machine-user burns a seat. The existing
"EnsembleWorks Access" **OAuth App is reused for human identity only** — it acts
*as a user*, can't be a bot, and Cloudflare holds its token; it cannot push.

---

## 1. Create the App (org-owned)

GitHub → the **`lean-software-production`** org → **Settings → Developer settings
→ GitHub Apps → New GitHub App**. Org-owned so it isn't tied to a personal account.

- **GitHub App name:** `EnsembleWorks` if free (bot login becomes `ensembleworks[bot]`),
  otherwise e.g. `EnsembleWorks Bot` (login `ensembleworks-bot[bot]`). The name is
  globally unique on GitHub; **record the resulting slug** — it's part of the bot's
  commit email.
- **Homepage URL:** `https://canvas.leansoftware.ai`
- **Webhook:** **uncheck "Active".** We don't consume webhooks for commit/push, so
  there's no webhook URL or secret to manage.
- **Where can this App be installed?** "Only on this account".

## 2. Permissions

Under **Repository permissions** set:

| Permission     | Access         | Why                                         |
| -------------- | -------------- | ------------------------------------------- |
| Contents       | Read and write | push commits and branches                   |
| Pull requests  | Read and write | open PRs                                     |
| Workflows      | Read and write | edit `.github/workflows/` (CI) from the mob |
| Metadata       | Read-only      | mandatory, auto-selected                    |

Leave the rest at "No access" — Administration, Secrets, Members, Deployments,
Environments. Account permissions: none. Subscribe to events: none.

> **Note:** `Workflows: write` is granted intentionally so the mob can change CI
> from inside EnsembleWorks. It's a privilege escalation (workflow runs often hold
> elevated secrets), so lean on branch protection + workflow-file review rather than
> on withholding the permission.

## 3. Generate the private key + record IDs

- On the App's **General** page, note the **App ID** (a number).
- Click **Generate a private key** → downloads a `.pem`. **This is the root
  secret** — treat it like the LiveKit/Groq keys.

## 4. Install on the repo

App page → **Install App** → the `lean-software-production` org → **All
repositories** → Install. (Org-wide is intentional — see the controls above; the
bot can then drive any org repo, and protection is enforced per-repo on `main`.)

After install, the browser URL ends in `.../installations/<INSTALLATION_ID>` —
record that **installation ID**. (Or list installations via the API in step 7.)

## 5. Record the bot's user ID (for the commit email)

The bot's commit author email is `<BOT_USER_ID>+<slug>[bot]@users.noreply.github.com`.
Fetch the numeric ID (URL-encode the `[`/`]`):

```sh
curl -s "https://api.github.com/users/ensembleworks-lsp%5Bbot%5D" | jq '.id, .login'
# -> 293658866   "ensembleworks-lsp[bot]"
# email: 293658866+ensembleworks-lsp[bot]@users.noreply.github.com
```

(The actual slug for this App is `ensembleworks-lsp`.)

## 6. Place the credentials on the box

The box runs all services as a single **app user** — generically `ensemble` in
`bootstrap-debian-ash.sh`, but the actual dogfooding box runs as
`ensembleworks-leansoftware-ai`. Put the config in **that user's**
`~/.config/ensembleworks/` (mode **0600**) alongside the existing
`sync.env` / `scribe.env` — that is the path `gh-app-token.bash` reads by default
(`${XDG_CONFIG_HOME:-$HOME/.config}/ensembleworks/github-app.env`), so the tool
then needs no arguments.

```sh
# $HOME/.config/ensembleworks/github-app.env   (chmod 600)
GITHUB_APP_ID=4053458
GITHUB_APP_INSTALLATION_ID=140297178
GITHUB_APP_PRIVATE_KEY_FILE=$HOME/.config/ensembleworks/ensembleworks-lsp.2026-06-14.private-key.pem
GITHUB_BOT_USER_ID=293658866
GITHUB_BOT_LOGIN=ensembleworks-lsp[bot]
```

Copy the `.pem` to `GITHUB_APP_PRIVATE_KEY_FILE` and `chmod 600` it (use the real
absolute path, not `$HOME`, inside the file). `bootstrap-debian-ash.sh` writes a
placeholder `github-app.env` (like it does for `sync.env`/`scribe.env`) so a
fresh box prompts for these — fill in the values it leaves empty.

## 6b. On segregated (prod) boxes — keep the key out of the mob's shell

The prod boxes (e.g. `ew-lsp-001`) drop canvas terminals to a separate
`ensembleworks-agent` sandbox user that can't read the **app** user's `700`
`~/.config`. So, unlike the ash box, the App PEM + `github-app.env` are **not**
mob-readable — keep them in the **app user's** `~/.config/ensembleworks/` exactly
as in step 6, and let the sandbox user mint tokens (never touch the key) through a
narrow wrapper run as the app user:

- `deploy.sh` installs `bin/gh-app-token.bash` and the `deploy/ensembleworks-gh-token`
  wrapper to `/usr/local/bin` when the sandbox user exists.
- The host (laingville) adds the reverse sudoers rule:

  ```
  ensembleworks-agent ALL=(ensembleworks) NOPASSWD: /usr/local/bin/ensembleworks-gh-token
  ```

  > This lands in the same host file (`/etc/sudoers.d/ensembleworks-agent`) as the
  > *forward* terminal-launcher rule
  > (`ensembleworks ALL=(ensembleworks-agent) NOPASSWD: /usr/local/bin/ensembleworks-term-launch *, /usr/bin/true`).
  > The `/usr/bin/true` there is required for the terminal gateway's startup probe
  > (`sudo -n -u ensembleworks-agent true`) — without it the gateway logs a false
  > "sessions will NOT start" warning even though sessions work. The laingville
  > bootstrap provisions both rules.

- A canvas agent then mints + pushes:

  ```sh
  TOKEN=$(sudo -u ensembleworks ensembleworks-gh-token)        # or: … ensembleworks-gh-token myrepo
  git push "https://x-access-token:${TOKEN}@github.com/lean-software-production/<repo>.git" HEAD:my-branch
  ```

The wrapper hardcodes `--env` to the app user's own `github-app.env` and accepts
only a validated comma-separated repo allowlist — it never forwards arbitrary
`gh-app-token.bash` flags, so the sandbox user can't redirect `--env` to read files
as the app user. Net effect on a prod box: a leaked *token* still has a ~1h blast
radius, but the *key* can no longer be exfiltrated by the mob at all. Revocation
(step "Revocation") is unchanged.

## 7. Branch protection on `main` (the real control)

Repo → **Settings → Branches → Add branch ruleset / protection rule** for `main`:

- ✅ **Require a pull request before merging** (≥ 1 approval).
- ✅ **Do not allow bypassing the above settings** — and **do not** add the App
  to any bypass list.
- (Optional) Require status checks; restrict who can push.

Net effect: `ensembleworks[bot]` can create branches and open PRs but **cannot
push to `main`** — a human must review and merge.

## 8. Remote over HTTPS (so a token can push)

The repo remote is currently SSH
(`git@github.com:lean-software-production/ensembleworks.git`). Installation tokens
push over HTTPS. Don't bake a token into `.git/config`; inject it at push time:

```sh
git remote set-url origin https://github.com/lean-software-production/ensembleworks.git
# push with a freshly-minted token (see step 9):
git push "https://x-access-token:${TOKEN}@github.com/lean-software-production/ensembleworks.git" HEAD:my-feature-branch
```

## 9. Mint an installation token (what `bin/gh-app-token.bash` will automate)

A JWT signed with the PEM (RS256, ≤10 min) is exchanged for a ~1h installation
token:

```sh
set -euo pipefail
app_id="$GITHUB_APP_ID"; install_id="$GITHUB_APP_INSTALLATION_ID"
pem="$GITHUB_APP_PRIVATE_KEY_FILE"
b64() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
now=$(date +%s)
header=$(printf '{"alg":"RS256","typ":"JWT"}' | b64)
payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$((now-60))" "$((now+540))" "$app_id" | b64)
sig=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$pem" -binary | b64)
jwt="$header.$payload.$sig"
TOKEN=$(curl -s -X POST \
  -H "Authorization: Bearer $jwt" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app/installations/$install_id/access_tokens" | jq -r .token)
```

The `iat` is backdated 60s for clock skew; `exp` is +9 min (GitHub caps JWTs at
10 min). The returned `$TOKEN` is what you push with and what the
`/api/participants` flow uses for any GitHub API calls.

## 10. Verify

```sh
# the token can write to the repo:
curl -s -H "Authorization: token $TOKEN" \
  https://api.github.com/repos/lean-software-production/ensembleworks | jq .permissions
# expect: { "pull": true, "push": true, ... }

# and it CANNOT push to main (should be rejected by branch protection):
git push "https://x-access-token:${TOKEN}@github.com/lean-software-production/ensembleworks.git" HEAD:main   # expect rejection
```

A bot commit, for reference, is made with:

```sh
GIT_AUTHOR_NAME='ensembleworks[bot]'    GIT_AUTHOR_EMAIL="${GITHUB_BOT_USER_ID}+ensembleworks[bot]@users.noreply.github.com" \
GIT_COMMITTER_NAME='ensembleworks[bot]' GIT_COMMITTER_EMAIL="${GITHUB_BOT_USER_ID}+ensembleworks[bot]@users.noreply.github.com" \
git commit -m "…

Co-authored-by: Alice <alice@…>"
```

---

## Revocation

Because the PEM is mob-readable, treat instant revocation as a feature, not an
incident response you hope never to run:

- **Rotate the key:** App → General → Private keys → delete the old one, generate
  a new one, replace the `.pem` on the box. Old key stops minting tokens immediately.
- **Cut all access:** uninstall the App from the repo (Install App → Uninstall),
  or remove the repo from the installation. Existing ~1h tokens still work until
  they expire; rotate the key too if you need an immediate cutoff.

## What plugs in where (build plan)

- Step 6 secrets file → created as a placeholder by `bootstrap-debian-ash.sh`.
- Step 9 token minting → `bin/gh-app-token.bash`.
- Steps 8–9 push + PR → the `bin/` commit tool, which reads co-authors from the
  sync server's `/api/participants?room=&page=` (Cloudflare Access identity).
