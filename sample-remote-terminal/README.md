# Sample Remote Terminal (EnsembleWorks)

Open this repo in **GitHub Codespaces**, run one script, and this cloud machine
appears as a terminal tile on an EnsembleWorks canvas. The container also ships
handy dev tools (tmux, neovim, Node, ripgrep, git-delta, opencode, pi).

## Use it

1. **Code → Create codespace on main.** Wait for the container to build.
2. In the Codespace terminal, run:
   ```bash
   ./connect.sh
   ```
3. It prompts for:
   - `CANVAS_URL` — the canvas base URL, e.g. `https://canvas.example.com`
   - `CF Access Client ID` / `Secret` — a Cloudflare Access **service token**
     pair that lets this machine through the canvas's Cloudflare Access boundary
   - (label defaults to the Codespace name)

   Answer once and optionally save to a git-ignored `.termgw.env` so re-runs are
   zero-touch.
4. The connector registers with the canvas. Open the canvas, add a terminal from
   the New-terminal picker, and choose this gateway by its label. `Ctrl-C` in the
   Codespace stops it.

## How it works

`connect.sh` downloads the prebuilt `termgw` connector from a public GitHub
release (`RELEASE_REPO`, default `lean-software-production/ensembleworks`),
verifies its SHA-256, and runs it. `termgw` dials the canvas over an outbound
WebSocket through Cloudflare Access and serves tmux-backed sessions. Nothing is
compiled here — the sample repo is just a launcher.

## Overrides

| Env var | Default | Purpose |
|---|---|---|
| `RELEASE_REPO` | `lean-software-production/ensembleworks` | Where to download `termgw` from |
| `TERMGW_VERSION` | `latest` | Release tag to pin, or `latest` |
| `GATEWAY_LABEL` | Codespace name | Label shown in the New-terminal picker |

Preview the resolved config and download URL without connecting:
```bash
./connect.sh --dry-run
```

## Agent tools

`opencode` and `pi` are preinstalled but need your own provider/API key at
runtime (`pi` `/login`, or `ANTHROPIC_API_KEY` etc.). This repo does not manage
those credentials.
