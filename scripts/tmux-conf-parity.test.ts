// Run: bun scripts/tmux-conf-parity.test.ts   (also via `bun run test`)
//
// deploy/tmux-ensembleworks.conf and the devcontainer feature's copy at
// deploy/features/ensembleworks-cli/tmux-ensembleworks.conf must stay
// byte-identical. Canvas terminals should behave the same whether they are
// hosted by the prod box (which installs the former to
// /etc/ensembleworks/tmux.conf) or by a container running the published
// ensembleworks-cli feature (which installs the latter to
// /usr/local/share/ensembleworks-connect/). Drift means the "invisible tmux"
// guarantees hold in one place and not the other — and it would drift
// silently, because nothing else reads both files.
//
// WHY A TEST RATHER THAN A SYMLINK. The obvious fix is to make the feature's
// copy a symlink to the canonical one. It does not work: `devcontainer
// features publish` packages the FEATURE DIRECTORY ALONE into an OCI
// artifact, so a `../../` symlink is preserved as a symlink and arrives at
// the consumer dangling. install.sh's `install -D -m 0644
// ./tmux-ensembleworks.conf` then follows it and fails with
// `cannot stat: No such file or directory`, failing the feature install and
// the consumer's whole container build. Verified 2026-07-21 by packaging a
// symlinked feature dir with tar and running install.sh against the
// extracted copy.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CANONICAL = 'deploy/tmux-ensembleworks.conf'
const FEATURE_COPY = 'deploy/features/ensembleworks-cli/tmux-ensembleworks.conf'

const canonical = readFileSync(CANONICAL, 'utf8')
const featureCopy = readFileSync(FEATURE_COPY, 'utf8')

if (canonical !== featureCopy) {
  // Point at the first differing line — a whole-file diff is unreadable for a
  // 280-line conf, and the usual drift is one edit applied to only one copy.
  const a = canonical.split('\n')
  const b = featureCopy.split('\n')
  let i = 0
  while (i < Math.max(a.length, b.length) && a[i] === b[i]) i++
  assert.fail(
    `${CANONICAL} and ${FEATURE_COPY} have diverged (first difference at line ${i + 1}):\n` +
      `  ${CANONICAL}:\n    ${a[i] ?? '<end of file>'}\n` +
      `  ${FEATURE_COPY}:\n    ${b[i] ?? '<end of file>'}\n\n` +
      `Apply the edit to BOTH, then re-run. They cannot be symlinked — see the header of this file.`,
  )
}

// Guard the mechanism itself, not just today's contents: if someone "fixes"
// the duplication with a symlink, the parity check above still passes (both
// reads resolve to the same bytes) while the published feature is broken.
// Catch it here instead of in a consumer's failed container build.
const { lstatSync } = await import('node:fs')
for (const p of [CANONICAL, FEATURE_COPY]) {
  assert.ok(
    !lstatSync(p).isSymbolicLink(),
    `${p} is a symlink. The devcontainer feature is published as an OCI artifact containing only its own directory, so a symlink escaping it arrives dangling and fails install.sh. Keep both as real files.`,
  )
}

console.log('ok: tmux conf parity — canonical and feature copy are byte-identical, both real files')
