// rAF-based frame sampler + metrics. Portable (works in Electron later),
// no CDP dependency. Inject BEFORE page load; measure around a scenario.
import type { Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const installSampler = (page: Page) =>
	page.addInitScript(() => {
		const w = window as any
		w.__frames = [] as number[]
		const loop = (t: number) => {
			w.__frames.push(t)
			requestAnimationFrame(loop)
		}
		requestAnimationFrame(loop)
	})

// A frame gap over this counts as a dropped/janky frame (~1.5x a 60fps tick).
const JANK_THRESHOLD_MS = 25

export interface FrameStats {
	frames: number
	p50ms: number
	p95ms: number
	maxms: number
	droppedOver25ms: number
}

export async function measure(page: Page, scenario: () => Promise<void>): Promise<FrameStats> {
	const start = await page.evaluate(() => performance.now())
	await scenario()
	const end = await page.evaluate(() => performance.now())
	const deltas = await page.evaluate(
		([s, e]) => {
			const f = (window as any).__frames.filter((t: number) => t >= s && t <= e)
			return f.slice(1).map((t: number, i: number) => t - f[i])
		},
		[start, end],
	)
	const sorted = [...deltas].sort((a, b) => a - b)
	const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
	return {
		frames: deltas.length,
		p50ms: Number(pick(0.5).toFixed(2)),
		p95ms: Number(pick(0.95).toFixed(2)),
		maxms: Number((sorted[sorted.length - 1] ?? 0).toFixed(2)),
		droppedOver25ms: deltas.filter((d: number) => d > JANK_THRESHOLD_MS).length,
	}
}

const FILE = path.join(import.meta.dirname, '../baselines/tldraw-perf.json')
export const capturing = process.env.EW_CAPTURE === '1'

// Read the engine version from the client's manifest at capture time — never
// hardcode provenance, or recaptures would silently stamp stale facts.
function engineVersion(): string {
	const pkg = JSON.parse(
		readFileSync(path.join(import.meta.dirname, '../../client/package.json'), 'utf8'),
	)
	return `tldraw@${pkg.dependencies.tldraw}`
}

// Merge semantics: recapturing one scenario (e.g. via -g) updates only its key.
// Provenance is therefore PER KEY — a partial recapture must not restamp
// scenarios it didn't rerun.
export function record(key: string, value: Record<string, unknown>) {
	mkdirSync(path.dirname(FILE), { recursive: true })
	const all = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {}
	all[key] = {
		...value,
		_meta: {
			engine: engineVersion(),
			capturedAt: new Date().toISOString(),
			host: os.hostname(),
		},
	}
	writeFileSync(FILE, JSON.stringify(all, null, 2) + '\n')
}
