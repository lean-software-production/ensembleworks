# Discord bot — verification & remaining steps

Status as of 2026-07-09: the feature is **code-complete and test-verified** (unit +
integration, all six workspaces typecheck, inbound proven end-to-end with a fake
gateway + real sync server). What remains is **live verification with real Discord
credentials** and **wiring the bot into the release/deploy pipeline** — neither of
which can be done without external credentials or a real deploy, so they are
documented here rather than executed.

See [discord-bot-design.md](discord-bot-design.md) for the design and
[plans/2026-07-08-discord-bot.md](plans/2026-07-08-discord-bot.md) for the plan.
Load-bearing assumption still holds: **single-org per deployment** (one bot token;
room participants mutually trusted). Revisit if multi-tenancy ever appears.

## A. Discord application setup (do once, before any live test)

1. Discord Developer Portal → New Application → add a **Bot**.
2. Enable the **MESSAGE CONTENT** privileged intent (Bot → Privileged Gateway
   Intents). Without it the bot receives empty `content` and inbound stickies are
   blank. This is a dashboard toggle, not code.
3. Copy the **bot token** → this is `DISCORD_BOT_TOKEN`.
4. Invite the bot with a minimal OAuth2 URL: scope `bot`; permissions **View
   Channels** + **Send Messages** only. Nothing else.
5. Generate a high-entropy `DISCORD_INTERNAL_SECRET` (e.g. `openssl rand -hex 32`).

## B. Local dev verification (dogfood)

1. Put both secrets in `~/.config/ensembleworks/dev.env`:
   ```
   DISCORD_BOT_TOKEN=...
   DISCORD_INTERNAL_SECRET=<the same value the sync server will use>
   ```
   The sync server inherits the tmux-server env from the same `dev.env`, so a
   single entry there reaches **both** the bot and the sync server — which is
   exactly what the outbound path needs (they must share `DISCORD_INTERNAL_SECRET`).
2. `bin/dev up`. Confirm the `discord` service starts: `bin/dev status --json
   2>/dev/null` shows `discord` enabled + healthy; `bin/dev logs discord` shows
   `gateway connected` (no token ⇒ the service is skipped by design).
3. **Inbound:** in the canvas, add a frame named e.g. `Ideas`. Overflow menu →
   *discord bindings* → add an **inbound** binding: the Discord channel id, direction
   `in`, handler `frame-sticky`, frame name `Ideas` (fuzzy). Post a message in that
   Discord channel → a sticky appears on the `Ideas` frame attributed
   `@<author> (Discord)`.
4. **Outbound:** add an **outbound** binding (the room → a Discord channel). Select a
   frame → overflow menu → *post frame link to Discord* → a frame-link embed appears
   in the bound channel. (Summary/decision/action-item posts originate from the
   scribe/minutes agent via `POST /api/discord/post`, not the button.)
5. **Echo guard:** confirm the outbound embed does **not** come back as a sticky
   (the bot ignores `author.bot`).
6. **Frame deep-link (Milestone A):** the frame-link URL is `?room=<room>&frame=<shapeId>`
   — opening it should zoom the canvas to that frame once it hydrates. Also verify
   the overflow *copy frame link* action copies that URL.

## C. Deferred: release + deploy pipeline wiring (needs a real deploy in the loop)

The bot builds and runs, and its systemd units exist
(`deploy/systemd/ensembleworks-discord.service` and `…/prod/…`), but it is **not yet
wired into `deploy/deploy.sh` / `deploy/release.sh`**. Doing this blind (without a
real deploy to verify) risks breaking a working production script, so it was left as
an explicit step:

1. **`deploy/release.sh`** already gates on `npm run build` which now includes the
   discord workspace (its `build` = `tsc --noEmit`). If the bot ships as a **compiled
   binary** like the server/transcriber, add `@ensembleworks/discord`’s `build:binary`
   (→ `dist/ensembleworks-discord`) to the artifact build + the GitHub release upload.
2. **`deploy/deploy.sh`**:
   - fetch the `ensembleworks-discord` binary alongside the server/transcriber
     artifacts (see the artifact list around the top-of-file comment);
   - add `ensembleworks-discord` to the prod unit install list (the
     `sudo rm -rf …service.d` + `for u in …` loop and the `PROD_UNITS` copy) with the
     `@APP_USER@`/`@APP_HOME@` sed substitution;
   - add it to the enable/restart block near the end (mirror the scribe line:
     `systemctl is-active --quiet ensembleworks-discord && restart || true` if you want
     it optional, or add it to the unconditional restart list if always-on);
   - ensure a boot-check of the fetched binary if the script boot-checks the others.
3. **Secrets on the box:** create `~/.config/ensembleworks/discord.env` with
   `DISCORD_BOT_TOKEN` + `DISCORD_INTERNAL_SECRET`, and ensure the **sync server's**
   EnvironmentFile (`sync.env`) carries the **same** `DISCORD_INTERNAL_SECRET` (and
   optionally `DISCORD_PORT=8790`). Without the shared secret, outbound posts 401.
4. **Prod bot→server auth:** the bot creates stickies via `POST /api/canvas/sticky`
   using a Cloudflare Access service token (`CF_ACCESS_CLIENT_ID`/`_SECRET`), the same
   pattern as other bots — provision one and map its `common_name` in
   `service-tokens.toml` to a read-write identity.

Verify the first deploy by watching `journalctl -u ensembleworks-discord` for a clean
`gateway connected`, then run the B.3–B.5 round-trips against the deployed instance.

## D. Outstanding local-UI verification debt

The client UI (frame deep-link + copy-link from Milestone A, the bindings dialog and
outbound trigger from B/E) has been unit/type-verified but **not driven in a running
browser** yet. The B.3–B.6 steps above cover it once a bot token is available; if you
want to verify the canvas UI *before* setting up Discord, the deep-link and
copy-link (A) and the bindings dialog rendering (B) can be exercised without a token.
