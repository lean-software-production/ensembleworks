// Run: bun scripts/ux-contract-presence.test.ts
//
// Task G1 (docs/plans/2026-07-16-ux-contracts-implementation.md) — the CI
// presence-check that fails a diff which touches an interaction-bearing path
// (a canvas tool/renderer/input surface) WITHOUT also touching the
// interaction-contracts module or carrying an explicit opt-out marker in the
// PR body. Named `.test.ts` (not a bare `.ts`) so it runs under `bun run
// test` via scripts/run-tests.ts's own `scripts/*.test.ts` glob — the same
// trick as this file's sibling, exposure-audit.test.ts (see that file's own
// header for the precedent).
//
// Two independent things happen here:
//   1. `checkPresence` — the PURE decision function, exported so it can be
//      unit-tested directly with synthetic file lists (no git, no env) —
//      this is what the self-tests below exercise, RED-then-GREEN, baked
//      permanently into the gate itself (plan step 2).
//   2. The REAL-diff check at the bottom — reads the actual changed-file list
//      and PR body (from CI-injected env vars, falling back to `git diff`
//      for local runs) and asserts THIS diff doesn't violate the gate. It
//      skips (never false-fails) when neither the env vars nor a usable git
//      base are available — e.g. a shallow CI checkout with no `origin/main`.
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'

// ============================================================================
// The vocabulary — kept in sync with the plan's path lists AND with reality:
// canvas-editor/src/tools/, canvas-react/src/, and client/src/canvas-v2/ are
// where v2's tool FSMs, the React renderer, and the client-side input/tool
// glue (tool-loop.ts, ws-client-transport.ts, presence.ts, CanvasV2App.tsx,
// bootstrap-page.ts, DevOverlay.tsx) actually live today — verified by
// listing each directory, not assumed from the plan's prose. The contracts
// module spans interaction-contracts/ (the pure declarations), the FSM
// runner directory canvas-editor/src/contracts/, and the browser runner's two
// files in e2e/ — also verified present.
// ============================================================================
const INTERACTION_BEARING_PREFIXES = ['canvas-editor/src/tools/', 'canvas-react/src/', 'client/src/canvas-v2/'] as const

const CONTRACTS_MODULE_PREFIXES = ['interaction-contracts/', 'canvas-editor/src/contracts/'] as const
const CONTRACTS_MODULE_EXACT_FILES = ['e2e/lib/contracts.ts', 'e2e/tests/contracts.spec.ts'] as const

// The opt-out marker. Case-insensitive on the keyword, but the reason after
// the separator must be non-empty (a bare "ux-contract: none" with nothing
// after it does not count — silence-with-a-label is still silence). Accepts
// an em dash (the documented form), a double-hyphen, or a plain hyphen as the
// separator, so a PR body typed without special characters still counts.
const OPT_OUT_MARKER = /ux-contract:\s*none\s*(?:—|--|-)\s*\S.+/i

function touchesAny(files: readonly string[], prefixes: readonly string[]): boolean {
  return files.some((f) => prefixes.some((p) => f.startsWith(p)))
}

function touchesInteractionSurface(files: readonly string[]): boolean {
  return touchesAny(files, INTERACTION_BEARING_PREFIXES)
}

function touchesContractsModule(files: readonly string[]): boolean {
  return touchesAny(files, CONTRACTS_MODULE_PREFIXES) || files.some((f) => (CONTRACTS_MODULE_EXACT_FILES as readonly string[]).includes(f))
}

function hasOptOutMarker(prBody: string): boolean {
  return OPT_OUT_MARKER.test(prBody)
}

/** The pure decision: null = the diff is fine (either it doesn't touch an
 * interaction-bearing path, or it also touches the contracts module, or the
 * PR body carries the opt-out marker); a string = the violation message,
 * naming the offending interaction-bearing files for a fast fix. */
export function checkPresence(changedFiles: readonly string[], prBody: string): string | null {
  if (!touchesInteractionSurface(changedFiles)) return null
  if (touchesContractsModule(changedFiles)) return null
  if (hasOptOutMarker(prBody)) return null
  const offenders = changedFiles.filter((f) => INTERACTION_BEARING_PREFIXES.some((p) => f.startsWith(p)))
  return (
    `diff touches interaction-bearing path(s) [${offenders.join(', ')}] without touching the ` +
    `interaction-contracts module (interaction-contracts/, canvas-editor/src/contracts/, ` +
    `e2e/lib/contracts.ts, e2e/tests/contracts.spec.ts) and without a ` +
    `'ux-contract: none — <reason>' marker in the PR body. Either add/extend a contract, or ` +
    `opt out explicitly with a reason.`
  )
}

// ============================================================================
// Self-tests — the RED->GREEN evidence baked into the gate itself (plan
// step 2). These exercise the PURE function directly; the "demonstrably RED
// against a synthetic offender" step the implementation plan requires before
// this file was committed was run separately against the real-diff branch
// below (env-var-injected synthetic data) — see the task's commit message /
// report for the captured verbatim failure. These assertions are the
// permanent regression form of that same proof: if `checkPresence` ever stops
// detecting the offending case, THIS test starts failing.
// ============================================================================
{
  // RED: an interaction-bearing file, no contracts touch, no marker.
  const v = checkPresence(['canvas-editor/src/tools/select.ts'], '')
  assert.ok(v !== null, 'an interaction-bearing change with no contracts touch and no marker must be flagged')
  assert.ok(v!.includes('canvas-editor/src/tools/select.ts'), 'the violation message names the offending file')
  console.log('ok: presence check flags an interaction-bearing diff with no contracts touch and no marker')
}
{
  // GREEN: same interaction-bearing file, PLUS a contracts-module touch.
  const v = checkPresence(['canvas-editor/src/tools/select.ts', 'interaction-contracts/src/contracts/foo.ts'], '')
  assert.equal(v, null, 'adding a contracts-module touch clears the violation')
  console.log('ok: presence check passes once the diff also touches the contracts module')
}
{
  // GREEN: same interaction-bearing file, no contracts touch, but the PR body
  // carries the opt-out marker with a real reason.
  const v = checkPresence(['canvas-editor/src/tools/select.ts'], 'ux-contract: none — pure internal rename, no gesture/observable change')
  assert.equal(v, null, 'a PR body opt-out marker with a reason clears the violation')
  console.log('ok: presence check passes with an explicit ux-contract: none marker + reason')
}
{
  // Positive control: a diff that touches NEITHER surface is never flagged
  // (else the checker would be vacuously strict and every unrelated PR would
  // need an opt-out).
  const v = checkPresence(['README.md', 'docs/plans/2026-07-16-ux-contracts-implementation.md'], '')
  assert.equal(v, null, 'a diff that never touches an interaction-bearing path is never flagged')
  console.log('ok: presence check ignores diffs outside the interaction-bearing surface')
}
{
  // Edge: an interaction-bearing file, no marker, but ONLY the browser-runner
  // spec file (not the FSM side) counts as a contracts touch too.
  const v = checkPresence(['client/src/canvas-v2/tool-loop.ts', 'e2e/tests/contracts.spec.ts'], '')
  assert.equal(v, null, 'touching only the browser-runner spec file still counts as the contracts module')
  console.log('ok: presence check recognizes e2e/tests/contracts.spec.ts alone as a contracts-module touch')
}
{
  // Edge: the marker keyword present but with no reason after it must NOT
  // count (silence-with-a-label is still silence).
  const v = checkPresence(['canvas-editor/src/tools/select.ts'], 'ux-contract: none')
  assert.ok(v !== null, 'a marker with no reason after it does not satisfy the opt-out')
  console.log('ok: presence check rejects a bare marker with no reason')
}

// ============================================================================
// The real-diff check. Reads the actual changed-file list + PR body from
// CI-injected env vars (UX_CONTRACT_CHANGED_FILES, newline-separated;
// UX_CONTRACT_PR_BODY), falling back to `git diff --name-only
// origin/main...HEAD` for a local run with no env set. Skips cleanly (never
// false-fails) when neither is available.
// ============================================================================
function realChangedFiles(): readonly string[] | null {
  const envFiles = process.env.UX_CONTRACT_CHANGED_FILES
  if (envFiles !== undefined) {
    return envFiles.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
  }
  try {
    const out = execSync('git diff --name-only origin/main...HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
  } catch {
    return null
  }
}

const changedFiles = realChangedFiles()
if (changedFiles === null) {
  console.log('skip: ux-contract-presence -- no UX_CONTRACT_CHANGED_FILES env and no usable git base (origin/main unavailable); not failing')
} else {
  const prBody = process.env.UX_CONTRACT_PR_BODY ?? ''
  const violation = checkPresence(changedFiles, prBody)
  assert.equal(violation, null, violation ?? undefined)
  console.log(`ok: ux-contract-presence -- real diff (${changedFiles.length} file(s)) does not violate the presence gate`)
}

console.log('ok: ux-contract-presence -- self-tests + real-diff check complete')
