// Task G4 (phase-4 plan, docs/plans/2026-07-15-canvas-phase4-bounds.md §1.6)
// — gate the EAGER entry chunk against the Task A0 / Phase-3 Unit-12
// baseline, so new bodies + undo + dispatch don't bloat what every room
// loads at boot.
//
// Run: bun client/scripts/bundle-size-check.ts   (after `vite build` — this
// script does NOT build; the CI step and the local Step-2 command both build
// first).
//
// CRITICAL — this gates client/dist/assets/index-*.js (the EAGER entry
// chunk vite.config.ts's rollupOptions.output leaves unnamed/default-named),
// NOT `CanvasV2App-*.js` (~4.3 MB). CanvasV2App is behind main.tsx's
// `React.lazy(() => import(...))` — a separate chunk that never loads until
// a v2 room is opened (see scripts/exposure-audit.test.ts, which proves the
// v2 module graph is reachable ONLY through that dynamic import). Gating it
// here by accident would be a meaningless multi-MB check. To avoid ever
// picking the wrong file by name-matching alone, we parse dist/index.html
// for its literal `<script type="module" src="...">` tag — there is exactly
// one, and it IS the entry vite wires up; `CanvasV2App`, `tldraw`,
// `livekit`, `xterm`, and `react` all show up only as
// `<link rel="modulepreload">` / `<link rel="stylesheet">`, never as the
// module script tag itself. A raw-size sanity ceiling below double-checks
// we didn't somehow still grab a vendor/lazy chunk.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const CLIENT_DIR = path.resolve(import.meta.dirname, '..')
const DIST_DIR = path.join(CLIENT_DIR, 'dist')
const INDEX_HTML = path.join(DIST_DIR, 'index.html')

// Task A0's green build recorded the entry chunk at 215.39 kB raw / 63.12 kB
// gzip (dist/assets/index-*.js); Phase-3 Unit-12 pinned ~215.4 kB / ~63.1 kB
// as the baseline everyone's re-quoted since. Use the exact A0 numbers here
// so there's one unambiguous source of truth.
const RAW_BASELINE_KB = 215.39
const GZIP_BASELINE_KB = 63.12
const TOLERANCE = 1.02 // ~2% headroom — a real bloat should fail, not scrape by

const KB = 1000 // vite's own build report uses decimal kB (bytes / 1000), not KiB — see below

function findEntryChunkPath(): string {
	if (!existsSync(INDEX_HTML)) {
		console.error(
			`bundle-size-check: ${path.relative(CLIENT_DIR, INDEX_HTML)} not found. Run the client build first:\n` +
				`  bun run --filter '@ensembleworks/client' build`,
		)
		process.exit(1)
	}
	const html = readFileSync(INDEX_HTML, 'utf8')
	// Entry point: the <script type="module" src="..."> tag vite emits for the
	// eager entry. modulepreload <link>s (react/tldraw/livekit/xterm vendor
	// chunks) and any lazy chunk never appear as a <script> tag at all. Attribute
	// order isn't assumed (type/src/crossorigin can appear in any order) — grab
	// each <script> opening tag whole, then require both `type="module"` and a
	// `src` inside it.
	const openTags = [...html.matchAll(/<script\b[^>]*>/gi)]
	const entrySrcs: string[] = []
	for (const [tag] of openTags) {
		if (!/\btype=["']module["']/i.test(tag)) continue
		const srcMatch = tag.match(/\bsrc=["']([^"']+)["']/i)
		if (srcMatch) entrySrcs.push(srcMatch[1])
	}
	if (entrySrcs.length === 0) {
		console.error('bundle-size-check: no <script type="module" src="..."> tag found in dist/index.html')
		process.exit(1)
	}
	if (entrySrcs.length > 1) {
		console.error(
			`bundle-size-check: expected exactly one entry <script type="module"> tag, found ${entrySrcs.length}: ` +
				entrySrcs.join(', '),
		)
		process.exit(1)
	}
	const src = entrySrcs[0] // e.g. "/assets/index-C1Rivhs2.js"
	const resolved = path.join(DIST_DIR, src.replace(/^\//, ''))
	if (!existsSync(resolved)) {
		console.error(`bundle-size-check: entry script referenced dist/index.html not found on disk: ${resolved}`)
		process.exit(1)
	}
	return resolved
}

// Vite computes the gzip size it prints in the build report via real Node's
// `zlib.gzip` with no options (Z_DEFAULT_COMPRESSION) — confirmed by
// comparing this script's output against a live `vite build` run. Bun's own
// zlib bindings (node:zlib and Bun.gzipSync alike) use a different bundled
// zlib and produce a measurably different byte count at the "same" default
// level (~0.7% higher on this chunk) — close enough to stay well inside the
// 2% gate either way, but shelling out to `node` when it's on PATH keeps the
// number we report an exact match for what `vite build` itself printed,
// rather than an approximation. Node 22.12.0 is a pinned, required tool in
// this repo's toolchain (devcontainer + CI setup-node), so it should always
// be present; if it isn't, fall back to the current runtime's zlib rather
// than hard-failing the gate over a missing side tool.
function gzipSize(buf: Buffer): number {
	try {
		const out = execFileSync(
			'node',
			['-e', 'process.stdout.write(String(require("zlib").gzipSync(require("fs").readFileSync(0)).length))'],
			{ input: buf, maxBuffer: 32 * 1024 * 1024 },
		)
		return Number(out.toString('utf8'))
	} catch {
		console.warn('bundle-size-check: `node` unavailable, falling back to the current runtime\'s zlib for gzip sizing')
		return zlib.gzipSync(buf).length
	}
}

function fmtKb(bytes: number): string {
	return `${(bytes / KB).toFixed(2)} kB`
}

function main() {
	const entryPath = findEntryChunkPath()
	const rawBytes = statSync(entryPath).size

	// Sanity ceiling: the eager entry has never been anywhere near 1 MB; the
	// lazy CanvasV2App chunk is ~4.3 MB. If we ever picked up the wrong file,
	// fail loudly here instead of silently gating the wrong thing.
	const SANITY_CEILING_BYTES = 1_000_000
	if (rawBytes > SANITY_CEILING_BYTES) {
		console.error(
			`bundle-size-check: entry chunk ${path.relative(CLIENT_DIR, entryPath)} is ${fmtKb(rawBytes)} — ` +
				`far above the ${fmtKb(SANITY_CEILING_BYTES)} sanity ceiling for the eager entry. ` +
				'This almost certainly means the wrong chunk was picked up (e.g. the lazy CanvasV2App chunk). Aborting.',
		)
		process.exit(1)
	}

	const gzipBytes = gzipSize(readFileSync(entryPath))

	const rawBaselineBytes = RAW_BASELINE_KB * KB
	const gzipBaselineBytes = GZIP_BASELINE_KB * KB
	const rawLimitBytes = rawBaselineBytes * TOLERANCE
	const gzipLimitBytes = gzipBaselineBytes * TOLERANCE

	const rawOk = rawBytes <= rawLimitBytes
	const gzipOk = gzipBytes <= gzipLimitBytes

	console.log('bundle-size-check: entry chunk =', path.relative(CLIENT_DIR, entryPath))
	console.log(
		`  raw:  ${fmtKb(rawBytes)} (baseline ${RAW_BASELINE_KB.toFixed(2)} kB, limit ${fmtKb(rawLimitBytes)}) — ${
			rawOk ? 'PASS' : 'FAIL'
		}`,
	)
	console.log(
		`  gzip: ${fmtKb(gzipBytes)} (baseline ${GZIP_BASELINE_KB.toFixed(2)} kB, limit ${fmtKb(gzipLimitBytes)}) — ${
			gzipOk ? 'PASS' : 'FAIL'
		}`,
	)

	if (!rawOk || !gzipOk) {
		console.error(
			'\nbundle-size-check: FAIL — the eager entry chunk grew more than ~2% over the Task A0 / Unit-12 baseline. ' +
				'Investigate which recent change bloated it before widening this gate.',
		)
		process.exit(1)
	}

	console.log('\nbundle-size-check: PASS — entry chunk within ~2% of the A0 baseline')
}

main()
