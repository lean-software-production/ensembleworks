#!/usr/bin/env bash
# deploy/cutover.sh <ssh-target> <version>
# One-time Phase-3 cutover: prove production data loads under the new binaries,
# back up DATA_DIR (era-exempt), reseed env + SKILL files, then cross the era
# boundary via a normal deploy. Run ONCE; afterwards use deploy/deploy.sh.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
SSH_TARGET="${1:?usage: cutover.sh <ssh-target> <version>}"
VERSION="${2:?usage: cutover.sh <ssh-target> <version>}"
VERSION="${VERSION#v}"

# lib.sh rides to the box so the on-box helpers (ew_fetch_release / ew_free_port /
# ew_poll_health) are available to the data-load check.
scp -q deploy/lib.sh "${SSH_TARGET}:/tmp/ew-lib.sh"

# 1. DATA-LOAD CHECK against production copies. Boot the fetched server binary
#    against a COPY of the live DATA_DIR (not a scratch one) — every room must load
#    (keel 1, spec §7.1). ABORT on any file the new world cannot read.
ssh "$SSH_TARGET" 'bash -s' -- "$VERSION" < deploy/cutover-dataload-check.sh

# 2. DATA_DIR BACKUP — outside ~/releases so KEEP never prunes it (spec D8, keel 3).
ssh "$SSH_TARGET" "bash -s" <<'EOF'
set -euo pipefail
APP_HOME="$(getent passwd ensembleworks | cut -d: -f6)"
ts="$(date +%Y%m%dT%H%M%S)"
sudo -u ensembleworks mkdir -p "$APP_HOME/backups"
sudo -u ensembleworks cp -a --reflink=auto \
  "$APP_HOME/.local/share/ensembleworks" "$APP_HOME/backups/pre-cutover-$ts"
echo "backed up DATA_DIR -> ~/backups/pre-cutover-$ts (rollback across the era boundary)"
EOF

# 3. ENV + SKILL RESEED. Rewrite ~/.config/ensembleworks/*.env CANVAS_* -> ENSEMBLEWORKS_*
#    and install the #4-authored SKILL.md set into the sandbox. Files ride from this
#    operator checkout (scp), matching the tag.
scp -q deploy/cutover-reseed.sh "${SSH_TARGET}:/tmp/ew-reseed.sh"
ssh "$SSH_TARGET" 'bash /tmp/ew-reseed.sh'

# 4. Cross the era boundary via a normal deploy (the ONE sanctioned crossing).
EW_ALLOW_ERA_CROSS=1 deploy/deploy.sh "$SSH_TARGET" "$VERSION"

# 5. MANUAL CANVAS-RENDER GATE (mandatory — no automated layer covers it, spec §4.3).
cat >&2 <<'CHECK'
==> cutover deployed. BEFORE declaring success, do this by hand:
    1. Open the prod canvas URL in a browser (hard-refresh / incognito).
    2. Confirm the tldraw editor RENDERS — toolbar + shapes visible, NOT a
       blank white frame. A blank frame == the VITE_TLDRAW_LICENSE_KEY secret
       was missing/expired at CI build time (spec §4.3); re-run release-cli.yml
       with the secret set, then redeploy. Do NOT declare cutover done on a blank canvas.
    3. Restart terminal agents; users hard-refresh. Rollback = ~/backups/pre-cutover-*.
CHECK
