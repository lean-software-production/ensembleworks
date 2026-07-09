# Discord bot — operator runbook

End-to-end steps to create the Discord bot, run it locally for testing, and deploy
it to production. No secrets live in the repo — every token/secret below is
operator-provided and lives only in untracked env files / the Discord portal.

Companions: [design](discord-bot-design.md) · [plan](plans/2026-07-08-discord-bot.md)
· [verification](discord-bot-verification.md). Assumption: **single-org per
deployment** (one bot, trusted room participants).

---

## 1. Create the Discord application & bot (once)

1. https://discord.com/developers/applications → **New Application** → name it (e.g.
   "EnsembleWorks").
2. **Bot** tab → the bot user is created with the app. **Reset Token** → copy it →
   this is `DISCORD_BOT_TOKEN`. Store it only in an env file (below); never commit it.
3. **Privileged Gateway Intents** → enable **MESSAGE CONTENT INTENT**. Without it the
   bot receives empty message text and inbound stickies are blank. (This is a
   dashboard toggle; the code already requests the intent.)
4. Leave "Public Bot" on or off per preference; single-org deployments typically
   turn it **off** so only you can invite it.

## 2. Invite the bot to your server (once)

Build an OAuth2 invite URL with **least privilege**:

- **Installation / OAuth2 → URL Generator**: scope **`bot`** only.
- Bot **permissions**: **View Channels** + **Send Messages**. Nothing else — the bot
  reads messages in channels you bind and posts embeds; it needs no admin, no manage,
  no mentions-everyone.
- Open the generated URL, pick your server, authorize.

Enable **Developer Mode** in Discord (User Settings → Advanced) so you can
right-click a channel → **Copy Channel ID** — you'll need the channel snowflake id
when creating bindings.

## 3. Generate the internal shared secret (once)

```
openssl rand -hex 32
```
This is `DISCORD_INTERNAL_SECRET`. It guards the bot's loopback `/post` endpoint. It
must be set to the **same value** in both the **bot's** environment and the **sync
server's** environment (the sync server forwards outbound posts to the bot with this
secret). A mismatch → every outbound post is rejected 401.

---

## 4. Local / testing (bin/dev)

1. Put both secrets in `~/.config/ensembleworks/dev.env`:
   ```
   DISCORD_BOT_TOKEN=<your bot token>
   DISCORD_INTERNAL_SECRET=<the openssl value>
   ```
   In dev, `bin/dev` sources this into the tmux-server environment, so **both** the
   discord service and the sync server inherit `DISCORD_INTERNAL_SECRET` from the one
   entry — exactly what the outbound path needs. (Dev is loopback-only, so no
   Cloudflare Access token is needed for the bot→server sticky calls.)
2. `bin/dev up`. Confirm the bot: `bin/dev status --json 2>/dev/null` shows `discord`
   enabled + healthy; `bin/dev logs discord` shows `gateway connected`. (No token ⇒
   the service is skipped by design.)
3. **Bind a channel** (from the canvas): overflow menu → **discord bindings** →
   *add binding*:
   - **Inbound** (Discord → canvas): channel id (the snowflake), direction `in`,
     handler `frame-sticky`, frame name = a **fuzzy substring** of the target frame's
     name (e.g. `Ideas`). Post a message in that channel → a sticky appears on the
     `Ideas` frame, attributed `@<author> (Discord)`.
   - **Outbound** (canvas → Discord): channel id, direction `out`. Then select a
     frame → overflow menu → **post frame link to Discord** → a link embed appears in
     the channel. (Summary/decision/action-item posts come from the scribe/minutes
     agent via `POST /api/discord/post`, not the button.)
4. **Echo guard:** confirm an outbound embed does not come back as a sticky.

---

## 5. Production deploy

The bot ships as a compiled binary through the normal release → CI → deploy path
(now wired end-to-end):

- **`deploy/release.sh` → CI:** cutting a release tags the version; CI
  (`.github/workflows/release-cli.yml`) cross-compiles `ensembleworks-discord`
  (linux x64 + arm64), boot-checks it (`ensembleworks-discord --check`), and uploads
  it to the GitHub release alongside the other binaries.
- **`deploy/deploy.sh <user@host> <version>`:** fetches + checksum-verifies the
  discord binary, boot-checks it, installs the prod systemd unit, and — because the
  bot is **opt-in** — restarts it only if it's already enabled (like the scribe).

### One-time box setup

1. **Bot env file** — `~ensemble/.config/ensembleworks/discord.env` (0600, owned by
   the app user):
   ```
   DISCORD_BOT_TOKEN=<bot token>
   DISCORD_INTERNAL_SECRET=<the shared secret>
   # bot -> sync server auth (prod is behind Cloudflare Access):
   CF_ACCESS_CLIENT_ID=<service-token client id>
   CF_ACCESS_CLIENT_SECRET=<service-token client secret>
   ```
2. **Sync server env** — add the SAME `DISCORD_INTERNAL_SECRET` (and optionally
   `DISCORD_PORT=8790`) to the sync server's EnvironmentFile
   (`~ensemble/.config/ensembleworks/sync.env`), so `POST /api/discord/post` can reach
   the bot's `/post`.
3. **Cloudflare Access service token** — the bot creates stickies via
   `POST /api/canvas/sticky`, which is behind CF Access in prod. Provision a CF Access
   **service token**, put its client id/secret in `discord.env` (above), and map its
   `common_name` to a **read-write** identity in
   `~ensemble/.config/ensembleworks/service-tokens.toml` (same mechanism as the other
   bots). Without this, inbound stickies are rejected at the edge.
4. **Enable the unit** (first time only — deploy.sh won't force-enable it):
   ```
   sudo systemctl enable --now ensembleworks-discord
   ```

### Deploy & verify

```
deploy/deploy.sh <user@host-tailnet-name> <version>     # e.g. …@ew-…-001 0.14.0
```
Then on the box:
```
journalctl -u ensembleworks-discord -f      # expect: gateway connected
```
Run the §4.3 inbound + outbound + echo round-trips against the deployed instance.

---

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `bin/dev status` shows discord disabled | `DISCORD_BOT_TOKEN` not set in the env it reads (dev.env / discord.env). |
| Inbound stickies are **blank** | **MESSAGE CONTENT** privileged intent not enabled in the Developer Portal. |
| Outbound posts silently do nothing; server logs `delivered: 0` | `DISCORD_INTERNAL_SECRET` mismatch between the bot and the sync server (401), or no **outbound** binding for the room. The server also warns if the secret is unset. |
| Inbound sticky POST rejected in prod (403) | Missing/mis-mapped Cloudflare Access service token — check `discord.env` CF creds + the `service-tokens.toml` entry. |
| Bot connects but nothing routes | No binding for that **channel id**, or the inbound frame name doesn't fuzzy-match any frame. Re-check the binding in the dialog. |
| `gateway connect failed` in logs | Bad/expired `DISCORD_BOT_TOKEN`, or the intent isn't enabled. Outbound `/post` still works; inbound won't until the gateway connects. |

The bot is **loopback-only** (its `/post` binds `127.0.0.1`, no Caddy/public route)
and **opt-in** (off unless `DISCORD_BOT_TOKEN` is present).
