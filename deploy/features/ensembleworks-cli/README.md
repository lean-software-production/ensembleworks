# ensembleworks-cli (devcontainer feature)

Installs the `ensembleworks` CLI and runs `ensembleworks terminal connect` under
a background supervisor, so this container hosts canvas terminal shapes via the
EnsembleWorks relay. Replaces the retired Go `termgw` feature.

## Usage — strict-prod path (no baked secret, recommended)

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
init-chained supervisor: `remoteEnv` is applied only to interactive/exec
sessions and lifecycle hooks, not to the container's backgrounded entrypoint.
On an anonymous/dev instance, omit the token entirely.

## Options

| Option | Delivered as | Notes |
|---|---|---|
| `version` | which release `install.sh` fetches | **Pin it** (e.g. `0.11.0`). `latest` bakes a non-reproducible layer — fine only for throwaway boxes. |
| `url` | env `ENSEMBLEWORKS_URL` | Not a secret; baked freely. Required (or inject at runtime) or the supervisor fails loud. |
| `gatewayLabel` | `--label` | Empty ⇒ the CLI defaults to the container hostname. |
| `gatewayId` | `--gateway-id` | Empty ⇒ the CLI derives a stable per-box id. Set only to pin a friendly id. |
| `tokenId` / `tokenSecret` | env in `/etc/ensembleworks-connect.env` | **SECURITY: baked into the image layer.** Escape hatch for trusted/throwaway images only — prefer runtime injection above. |

## Defaults & footguns

- **Single room (`team`).** The feature has no room option. A multi-room operator
  adds `ENSEMBLEWORKS_ROOM` to the same runtime `containerEnv` block.
- **Runtime env overrides a baked value.** The supervisor sources the baked
  env file key-by-key, skipping any key already set at container runtime — so
  rotating `-e ENSEMBLEWORKS_TOKEN_SECRET=…` needs no image rebuild.
