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

## C. Release + deploy pipeline — WIRED (operator steps in the runbook)

The bot is now wired end-to-end into the release/deploy pipeline and the machinery is
**locally verified** via `deploy/test/fake-release.sh` (fetch → checksum → boot-check
including `ensembleworks-discord --check` all pass):

- **CI** (`.github/workflows/release-cli.yml`) cross-compiles `ensembleworks-discord`
  (linux x64 + arm64) in the `binaries` job, boot-checks it in `smoke`, and the
  `publish` job uploads it with the other release assets.
- **`deploy/lib.sh`** fetches + re-homes + boot-checks the binary
  (`ew_fetch_release`, `ew_boot_check`).
- **`deploy/deploy.sh`** ships the prod unit, installs it, and restarts it
  **if enabled** (opt-in, like the scribe).
- **`discord/src/main.ts --check`** is the boot-check entrypoint (links + binds
  `/post`, exits 0, never connects to Discord).

The remaining work is **operator setup on the box** (env files, the shared secret,
the Cloudflare Access service token, enabling the unit) and the **first real deploy** —
all documented step-by-step in **[discord-bot-runbook.md](discord-bot-runbook.md) §5**.
What has *not* happened is an actual production deploy + live Discord round-trip; the
runbook's verification step (`journalctl -u ensembleworks-discord` → `gateway
connected`, then the §4 round-trips) closes that out.

## D. Outstanding local-UI verification debt

The client UI (frame deep-link + copy-link from Milestone A, the bindings dialog and
outbound trigger from B/E) has been unit/type-verified but **not driven in a running
browser** yet. The B.3–B.6 steps above cover it once a bot token is available; if you
want to verify the canvas UI *before* setting up Discord, the deep-link and
copy-link (A) and the bindings dialog rendering (B) can be exercised without a token.
