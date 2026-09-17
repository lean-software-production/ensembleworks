// Run: bun scripts/plugin-icon-registry.test.ts   (also via `bun run test`)
//
// Every plugins/*/package.json must declare a bb.branding.icon that BB can
// actually resolve, and no two may declare the same one.
//
// WHY THIS GATE EXISTS. An unknown glyph name is not an error. The plugin
// loads, the manifest validates, and the host silently substitutes its Zap
// fallback — a lightning bolt. Nothing in typecheck, `bb plugin build`, or CI
// notices, and the only signal is a human eventually looking at the sidebar
// and saying "why is that a lightning bolt".
//
// It had already happened to half the suite (found 2026-09-17): Communications
// Hub declared `MessagesSquare`, Huddle `AudioWaveform`, and Identity
// `UsersRound`. None of the three exist in BB's registry, so all three rendered
// as the identical bolt. All were near-misses on real names — BB's set overlaps
// Lucide but is not Lucide, and the singular `MessageSquare` / `UserRound` are
// the forms that exist. A typo here is invisible by construction, which is
// exactly the kind of thing a cheap file-reading test should catch.
//
// The duplicate check is the same failure one step removed: Attractor and Fabro
// both declared `Workflow`, which is resolvable but makes two plugins
// indistinguishable in the rail. An icon that does not identify its plugin is
// not doing its job.
//
// WHY DUPLICATES ARE KEYED ON ARTWORK, NOT ON THE MANIFEST STRING. Once the
// suite moved to the shared "Stage" icon system, all six plugins declare the
// byte-identical string "./assets/icon.svg" while shipping six different
// drawings. Comparing the declared string would flag all six as duplicates;
// comparing the resolved artwork is what the check actually means, so a
// plugin-relative icon is keyed on the SHA-256 of its file. Copy another
// plugin's SVG verbatim and this still catches you.
//
// REGENERATING scripts/bb-host-glyphs.json AFTER A BB UPGRADE. The list is
// vendored because the repo cannot query a running bb server at test time, and
// a stale list is still far better than no check (it can only produce a false
// failure on a genuinely new glyph, never a false pass on a typo). To refresh
// it, read the client bundle of the bb-app version in engines.bb: the core map
// is the object literal ending `Zap:F}` in app/dist/assets/index-*.js, and the
// extended set is the backtick-quoted, dot-delimited `var On=` string in the
// same file (its artwork lazy-loads from icon-extended-*.js). Union the two.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const PLUGINS = 'plugins'
const REGISTRY = 'scripts/bb-host-glyphs.json'

const { glyphs, bbAppVersion } = JSON.parse(readFileSync(REGISTRY, 'utf8')) as {
  glyphs: string[]
  bbAppVersion: string
}
const known = new Set(glyphs)

const declared = new Map<string, string[]>()
const failures: string[] = []

for (const dir of readdirSync(PLUGINS, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  const manifestPath = join(PLUGINS, dir.name, 'package.json')
  if (!existsSync(manifestPath)) continue

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const icon: unknown = manifest?.bb?.branding?.icon
  if (icon === undefined) continue // a plugin may legitimately ship no branding
  if (typeof icon !== 'string' || icon === '') {
    failures.push(`${manifestPath}: bb.branding.icon must be a non-empty string`)
    continue
  }

  let key = icon
  if (icon.startsWith('./')) {
    // Plugin-relative artwork (Canvas ships ./assets/icon.svg). The host
    // resolves it as a file, so the only thing to check is that it is there —
    // a missing file is the same silent-fallback failure by another route.
    const artwork = join(PLUGINS, dir.name, icon.slice(2))
    if (!icon.toLowerCase().endsWith('.svg')) {
      // BB's own manifest schema rejects this, but it fails at plugin-load
      // time on someone's machine rather than here.
      failures.push(`${manifestPath}: plugin-owned bb.branding.icon must be an .svg file, got ${icon}`)
    } else if (!existsSync(artwork)) {
      failures.push(`${manifestPath}: bb.branding.icon points at ${icon}, which does not exist`)
    } else {
      // The host renders plugin SVGs as a CSS mask filled with currentColor
      // (backgroundColor: currentColor + maskImage: url(...)), so only the
      // alpha channel survives. Artwork that paints itself with fills and no
      // strokes still works, but any COLOUR in the file is silently discarded
      // -- worth knowing before someone tries to brand one of these.
      key = `sha256:${createHash('sha256').update(readFileSync(artwork)).digest('hex')}`
    }
  } else if (!known.has(icon)) {
    const hint = nearest(icon)
    failures.push(
      `${manifestPath}: bb.branding.icon "${icon}" is not a BB host glyph, so it will ` +
        `silently render as the Zap fallback (a lightning bolt).` +
        (hint ? ` Did you mean "${hint}"?` : ''),
    )
  }

  const owners = declared.get(key) ?? []
  owners.push(dir.name)
  declared.set(key, owners)
}

for (const [key, owners] of declared) {
  if (owners.length > 1) {
    const what = key.startsWith('sha256:') ? 'identical icon artwork' : `the glyph "${key}"`
    failures.push(
      `${owners.length} plugins share ${what} (${owners.join(', ')}) — they are ` +
        `indistinguishable in the sidebar. Give each its own.`,
    )
  }
}

/** Closest known glyph by edit distance, for the "did you mean" hint. */
function nearest(name: string): string | undefined {
  let best: string | undefined
  let bestScore = Infinity
  for (const candidate of known) {
    const score = distance(name.toLowerCase(), candidate.toLowerCase())
    if (score < bestScore) {
      bestScore = score
      best = candidate
    }
  }
  // Only volunteer a suggestion when it is close enough to be plausible;
  // the real-world cases (MessagesSquare, UsersRound) are 1-2 edits away.
  return bestScore <= Math.max(3, Math.floor(name.length / 4)) ? best : undefined
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = row
  }
  return prev[b.length]
}

assert.ok(declared.size > 0, `no plugin manifests with bb.branding.icon found under ${PLUGINS}/`)

if (failures.length > 0) {
  assert.fail(
    `plugin branding icons are broken:\n\n` +
      failures.map((f) => `  - ${f}`).join('\n') +
      `\n\nValid glyph names: ${REGISTRY} (${glyphs.length} names, from bb-app ${bbAppVersion}).\n` +
      `If you are on a newer bb and the glyph genuinely exists, regenerate that file — ` +
      `see the header of this test.\n`,
  )
}

console.log(`ok: ${declared.size} plugin branding icons, all resolvable and distinct`)
