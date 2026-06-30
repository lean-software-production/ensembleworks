# EnsembleWorks — Deploy Orchestration Options

**Status:** decision record. Survey of how we could roll out releases to the
`ew-*` boxes, the trade-offs considered, and the conclusion. Captures a design
conversation so the reasoning isn't re-run from scratch.

**Conclusion (TL;DR):** keep the current `deploy.sh`-over-SSH push model for now.
The likely next step is **`ansible-pull` GitOps on the existing systemd boxes** —
but even that can wait; nothing here is urgent. Managed Kubernetes (OVH MKS),
self-hosted k3s, and the Cloudflare/OVH platform options are **over-capitalised
for our current 2–3 pet-box scale** and, in the k8s cases, collide with the
terminal/agent-sandbox model that is the heart of the product.

---

## 1. Where we are today (the baseline)

Releases are cut and deployed by hand:

- `deploy/release.sh patch|minor|major` — bumps `package.json`, tags `vX.Y.Z`,
  pushes the tag. Run from a clean `main`.
- `deploy/deploy.sh <ssh-target> <version>` — a **push** model: `scp`s a few
  files to `/tmp` on the box, then `ssh`es in and runs a `bash -s` heredoc as an
  admin user with passwordless sudo. The **box itself** then clones/fetches from
  GitHub at the tag (`git worktree add $TAG`), builds **as the app user**,
  installs systemd units + Caddyfile, swaps the `current` symlink, restarts
  services, and smoke-checks the edge port.

Key property: the remote half already does everything locally on the box. The
push half (scp + ssh) is almost vestigial — the box is self-sufficient and
already mints its own GitHub App token to authenticate outbound. This makes the
codebase unusually **pull-shaped already**.

Boxes: `ew-staging-001-tailnet`, `ew-lsp-001-tailnet` (prod), reached as
`mrdavidlaing@…` over Tailscale, with Caddy + Cloudflare Tunnel as public
ingress. Host concerns (app/agent users, sudoers, launcher, tmux.conf, token
minting, docker for neko) are owned by the **laingville bootstrap**, not this
repo.

---

## 2. Push vs pull

**Push** (CI/laptop → box, our model today). An external actor initiates: reach
in over SSH and run the deploy.

**Pull** (box → GitHub). The box watches a desired-state source (a tag, a
version manifest, a git repo) and reconciles itself toward it on a timer/trigger.
Nothing reaches into the box.

| | Push | Pull |
|---|---|---|
| Inbound access | Needs SSH + standing sudo on every box | **None** — box only dials out |
| Who holds privilege | A central identity can sudo on all boxes | Each box self-updates with its own least-privilege token |
| Self-healing | A box down during deploy is missed | Catches up when it returns; drift re-reconciles |
| Scaling to N boxes | O(N) from the deployer | O(1) — boxes self-enroll |
| Latency | Immediate | Up to the poll interval (unless nudged) |
| "Approve prod" gate | GitHub Environments reviewer pause | Manifest **PR review** (we already have PR review) |
| Observability | One CI run to watch | Diffuse — each box must report back |
| Moving parts | None on the box | A reconcile agent to build, log, lock, maintain |

The big swings for us: pull **eliminates inbound access + standing sudo creds**
and is **self-healing**; the costs are **latency** and **diffuse observability**.

**GitOps hybrid** (the attractive shape): desired state is a per-channel version
manifest in git; boxes reconcile toward it; **promotion to prod = a PR bumping
`production: 0.3.x`**, which gives the approval gate + audit via git history,
reusing PR review we already have.

---

## 3. GitHub Actions + Environments (the CI-push path)

`deploy.sh` is already CI-friendly (parameterised by target + version; the box
self-fetches/builds), so a workflow only needs SSH reachability to the tailnet.

- **GitHub Environments** don't deploy anything — they add a governance/audit
  layer on a job via `environment: production`. They uniquely provide: a **native
  human-approval pause** (required reviewers, ≤6 per env; no clean plain-YAML
  equivalent), **secret blast-radius scoping** (prod creds invisible to other
  jobs), **ref-based deploy restriction** (only tags/`main` may hit prod), and a
  **per-environment deployment history/audit** UI.
- **Plan gate:** environment protection rules are free for **public** repos; for
  **private** repos (ours) they need **GitHub Pro / Team / Enterprise** — confirm
  the account's plan before relying on them. No documented cap on the *number* of
  environments.
- **Runner → tailnet** is the only real new dependency. Cleanest: GitHub-hosted
  runner + `tailscale/github-action` (ephemeral, `tag:ci`), with a tailnet ACL
  restricting `tag:ci` to SSH on the deploy boxes only. SSH auth on top is either
  a dedicated CI key or **Tailscale SSH** (ACL-driven, no key). A self-hosted
  runner on the tailnet is the alternative (more standing infra).

This path also **kills the `npm ci` dev-box disruption**: `release.sh` runs
`npm ci`, which wipes `node_modules` and repeatedly knocked out the local dev
stack (sync/term/client) when cutting releases from the dev box. Moving the
rollout to CI (or a separate release checkout) avoids disturbing the live dev
session.

---

## 4. Vendor survey (does anyone sell "deploy orchestration" for our boxes?)

Short answer across all three: **no turnkey product to orchestrate deploys to
our own pet VMs** — that category basically *is* Ansible/GitOps. What each vendor
*does* offer:

### Cloudflare
- **Access for Infrastructure (SSH)** — GA. Short-lived certs from a
  Cloudflare-managed CA (no long-lived keys), per-user/per-target/per-username
  policies, command logging + session recording. Needs `cloudflared` on the box
  (we may already run it) + trust the CA in `sshd_config`. Great for **audited
  human SSH**; the *client* side wants the WARP client, so it's **awkward from a
  headless CI runner** — Tailscale's action is the cleaner CI fit.
- **Tunnel** — already in use; reinforces the box-dials-out (pull) grain.
- **Containers + Sandboxes** — **GA April 2026**, now with **PTY/terminal
  support, persistent isolated Linux environments, snapshot-based session
  recovery, credential injection** — explicitly aimed at AI-agent workloads
  (Figma in prod). Strikingly close to our `ensembleworks-agent` terminals, *but*
  instances are request-driven with idle `sleepAfter` sleep, and it's a
  re-architecture onto Cloudflare's runtime (orchestration only for workloads on
  Cloudflare). Interesting as a **future home for the agent terminals**, not a
  deploy-orchestration answer for our fleet.

### OVHcloud
- No managed "roll out to my fleet" product. Their bare-metal/VPS automation
  story is **Terraform/Pulumi to provision + Ansible/Puppet/Chef to
  configure/deploy** (official OVH + OpenStack Terraform providers; an OVHcloud
  MCP server for infra management).
- **Ansible is the useful pointer:** `ansible-playbook` over SSH = a cleaner
  push `deploy.sh` with inventory + idempotent handlers; **`ansible-pull` = the
  pull/GitOps model off-the-shelf** (each box crons a pull from the repo and
  applies the playbook to itself — no inbound SSH, self-healing).
- **Managed Kubernetes (MKS)** — real orchestration if we containerise; 2026
  Standard Plan beta (multi-AZ, 99.99% SLA, up to 500 nodes).

### Managed-k8s cost reality (OVH MKS)
Control plane is **free**; you pay for worker nodes (regular Public Cloud
instances) + LB + storage:

| Node | vCPU/RAM | ~Monthly |
|---|---|---|
| D2-2 | 1 / 2 GB | €8.98 |
| D2-4 | 2 / 4 GB | €17.81 |
| C3-8 | 4 / 8 GB | €78.69 |
| C3-32 | 16 / 32 GB | €314.41 |

Plus LB €6.94/mo and block storage €0.048/GB/mo. The Standard (SLA/multi-AZ)
tier is paid (fee not published; needs a quote). **"Free control plane" is a
trap at our scale:** a minimally-real HA cluster wants ≥2 nodes
(~€165–180/mo/env before the SLA fee), vs a single VPS/bare-metal box per env
today — k8s would *raise* cost and add cluster ops in exchange for orchestration
we can get ~free with Ansible/GitOps.

---

## 5. Self-hosted k3s (control plane + each VM a worker)

The strongest "real orchestration without the MKS spend" option: free,
self-hosted on the VMs we already pay for; node-per-VM is k3s's sweet spot; and
it cleanly *is* the GitOps-pull model (Flux/Argo reconciling from git, with
scheduling + self-healing for free).

**The catch isn't money or k8s overhead — it's that our most important workload
fights containers hardest:**

- **Terminal/agent sandbox.** Today the isolation boundary is **Unix users +
  sudoers + a host launcher** (gateway drops each shell to `ensembleworks-agent`
  via `sudo`). k8s's boundary is the **pod**, so this becomes **pod-per-session**
  with the gateway holding k8s API privileges — a re-architecture of the gateway,
  launcher, sudoers, and `agent-home` provisioning.
- **Session survival regresses.** *"tmux is the substrate: sessions survive the
  gateway, reachable from plain `ssh` + `tmux attach`"* gets **harder** under pod
  lifecycle (we just fixed the systemd analog with `KillMode=process`).
- **LiveKit** (UDP/hostNetwork) is finicky on k8s; **stateful services** need PVs
  with node-pinning (eroding the reschedule benefit); **host coupling**
  (Tailscale, Tunnel, neko/docker, token minting) mostly doesn't vanish.

Topology note: for 2–3 boxes, a single k3s server (SPOF for scheduling) or HA
with 3 embedded-etcd servers. Either way it's a **platform migration**, not a
deploy win, and the terminal-sandbox redesign is its decisive first question.

**Interesting hybrid if we ever go container-ward:** k3s for the stateless-ish
services (sync, scribe, caddy) **+ Cloudflare Sandboxes for the agent terminals**
— letting each runtime handle the part it's good at, instead of forcing pty
sessions into pods.

---

## 6. Decision

1. **Now:** keep `deploy.sh` push. It works; it's boring and debuggable
   (`journalctl`/`systemctl`); the Unix-user sandbox already works. The only
   active papercut — `npm ci` in `release.sh` disturbing the dev box — is
   mitigated by cutting releases from a separate checkout or moving the rollout
   to CI later.
2. **Next step (when it's worth it):** **`ansible-pull` GitOps** on the existing
   systemd boxes — ~80% of the orchestration value (idempotent, self-healing,
   no inbound SSH, git as desired-state, promotion via PR) for ~5% of the effort
   and **zero re-architecture**. Not urgent; can wait.
3. **Deliberate future spike, not a deploy answer:** k3s (or k3s + Cloudflare
   Sandboxes) as a platform direction *if* we commit to containers and want
   pod-per-agent elasticity — gated on solving the terminal-sandbox redesign
   first. Managed MKS is over-capitalised at current scale.

**Not pursuing now:** GitHub Environments CI-push (revisit if we want gated,
audited rollouts and confirm the repo's plan supports private-repo
environments), managed Kubernetes, and any workload move onto Cloudflare's
runtime.
