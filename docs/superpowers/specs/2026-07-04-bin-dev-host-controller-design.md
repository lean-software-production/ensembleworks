# bin/dev as a host-side devcontainer controller — design

**Date:** 2026-07-04
**Status:** approved (design); spec under review

## Goal

Make the **expected** way to run `bin/dev` be from the **host** (outside the
devcontainer). From there, `bin/dev up` starts the devcontainer, and every
other command forwards into the container's `bin/dev` — so a human or agent
drives the whole stack with one consistent command from the repo root, never
needing `devcontainer exec --workspace-folder …` or a random container name.
Inside the container, `bin/dev` keeps working exactly as today (it's the
engine `postStartCommand` calls). Native-on-host stays available as an opt-in.

## The two roles

`bin/dev` picks a role from the environment at startup:

- **engine** — runs the stack in tmux (today's behaviour: `up/down/status/
  logs/restart/attach/doctor`). Active when **inside the container**
  (`ENSEMBLEWORKS_IN_DEVCONTAINER=1`, set by the Dockerfile) OR when
  `ENSEMBLEWORKS_NATIVE=1` forces it on the host.
- **controller** — the default on the host: manages the devcontainer and
  forwards commands into it.

```
inside container (ENSEMBLEWORKS_IN_DEVCONTAINER=1) → engine
host + ENSEMBLEWORKS_NATIVE=1                       → engine (native escape hatch)
host (default)                                      → controller
```

Only the engine needs the Node-version gate (node-pty ABI), `dev.env`, and the
service table; the controller skips all of that (it just shells out), so it
runs on the host under any recent Node.

## Controller behaviour

The controller finds this repo's devcontainer by the label the devcontainer
CLI stamps: `docker ps --filter label=devcontainer.local_folder=<repoDir>`
(→ container id + name). The workspace mount is `/workspaces/<basename repoDir>`.

| command | host action |
|---|---|
| `up` | require the `@devcontainers/cli` (else fail with the install remedy); run `devcontainer up --workspace-folder <repoDir>` (inherit stdio). Its `postStart` runs the inner `bin/dev up`, whose cheat-sheet (URL, voice line) prints through. |
| `down` | **stop the whole devcontainer**: `docker stop <id>` if one is running, else say so. (Restartable; data preserved. Restart a single service with `restart <svc>`; full restart is `down` + `up`.) |
| `status` / `logs` / `restart` | forward → `docker exec -w /workspaces/<name> <id> bin/dev <args...>` (inherit stdio, propagate exit code). If no container: narrate "no devcontainer — start with `bin/dev up`" and exit non-zero. |
| `doctor` | check **host** prerequisites (docker on PATH, `@devcontainers/cli` on PATH); then, if a container is running, also forward the inner `doctor`. Exit code reflects readiness. |
| `attach` | **print instructions, never nest**: the exact `docker exec -it <id> tmux attach -t workspace` line, plus the nested-tmux detach caveat (`Ctrl-b Ctrl-b d`). If no container, say to `bin/dev up` first. |

## Verbosity — every call, to stderr

All detection + forwarding narration goes to **stderr**, so `status --json`'s
**stdout stays clean and parseable** (an agent piping `status --json` gets only
JSON). Format:

```
bin/dev [host] · not inside a devcontainer
bin/dev [host] · devcontainer 'lucid_hofstadter' running  (repo …/ensembleworks)
bin/dev [host] · forwarding `status` → docker exec -w /workspaces/ensembleworks lucid_hofstadter bin/dev status
```

- Engine, inside: one line `bin/dev [devcontainer] · executing natively`.
- Engine, native escape hatch: `bin/dev [native] · executing natively on the host`.
- Controller `up`: narrate the CLI check + the `devcontainer up` invocation.
- Controller `down`: narrate `stopping devcontainer '<name>' (docker stop)`.
- No-container cases: narrate what was looked for and what to do.

## File structure

- **`.devcontainer/Dockerfile`** — add `ENV ENSEMBLEWORKS_IN_DEVCONTAINER=1`.
- **`bin/dev-lib.mjs`** — add pure, unit-tested helpers (no I/O):
  - `resolveMode(env)` → `'engine' | 'controller'`.
  - `forwardArgv(containerName, workspaceDir, args)` → the `docker exec` argv array.
  - `attachInstructions(containerName)` → the printed text.
  - `workspaceDirFor(repoDir)` → `/workspaces/<basename>`.
- **`bin/dev-host.mjs`** (new) — the controller: docker lookup, `up/down/
  forward/doctor/attach`, and the stderr `narrate()` helper. `node:` builtins only.
- **`bin/dev-main.mjs`** — at the top, `resolveMode`; if `controller`,
  `await import('./dev-host.mjs')` and run it (skipping the Node gate, `dev.env`,
  and engine dispatch); else run the engine as today, emitting the one-line
  engine narration. Keep the existing exports (`repoDir`, `makeCtx`, …) intact
  for `dev-doctor.mjs`.
- **`bin/dev.test.ts`** — cover `resolveMode` (the three env cases),
  `forwardArgv`, `workspaceDirFor`, and `attachInstructions`.
- **Docs** — README/CONTRIBUTING/AGENTS: the expected flow is host-side
  (`bin/dev up` starts the devcontainer); `devcontainer exec` no longer needed;
  `ENSEMBLEWORKS_NATIVE=1` documented.

`postStartCommand` (`bin/dev up --no-install`) and `postCreateCommand`
(`… bin/dev doctor`) are unchanged — they run **inside** the container, so the
Dockerfile marker routes them to the engine automatically.

## Error handling

- Controller `up` without the `@devcontainers/cli`: exit non-zero with
  `npm i -g @devcontainers/cli` remedy (enforce-not-provide).
- Any forward with no running container: clear stderr message naming the label
  searched and pointing at `bin/dev up`; non-zero exit.
- `docker` absent on the host: `doctor`/controller commands fail with a pointed
  message; `up` names docker as the missing prerequisite.
- Multiple matching containers (rare): use the first, narrate that others were
  found and ignored (no silent pick).

## Testing

- **Unit (`npx tsx bin/dev.test.ts`):** `resolveMode` for the three env
  combinations; `forwardArgv`/`workspaceDirFor` produce the exact argv and
  `/workspaces/<name>` path; `attachInstructions` contains the detach caveat.
- **End-to-end (manual):** rebuild the devcontainer from this branch (so the
  `ENSEMBLEWORKS_IN_DEVCONTAINER` marker is baked). From the host repo root:
  `bin/dev up` starts it; `bin/dev status`/`status --json` (clean stdout) and
  `logs sync` forward correctly; `attach` prints instructions; `down` stops the
  container; `ENSEMBLEWORKS_NATIVE=1 bin/dev status` (with no container) takes
  the engine path.

## Out of scope

- Rewriting how the engine runs the stack (unchanged).
- A `down`-that-keeps-the-container variant (a single `down` = stop container).
- Auto-installing the devcontainer CLI (enforce-not-provide only).
