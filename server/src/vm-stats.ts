/**
 * VM pressure: a single server-side reading of how loaded the shared box is.
 *
 * Every terminal is a tmux session on this one VM, plus the sync server, the
 * LiveKit relay and the scribe — so "load" is global, not per-client, and one
 * server reading is the source of truth the whole room sees.
 *
 * Memory is read from the *cgroup slice*, not host RAM: the dev services run
 * inside `ensembleworks.slice` (MemoryHigh/MemoryMax — see
 * deploy/systemd/ensembleworks.slice), and it's the slice that gets
 * OOM-killed when a runaway blows the ceiling. memory.current vs memory.max is
 * therefore the number that actually predicts the box falling over, far more
 * than os.freemem() (which on Linux is misleading anyway). PSI
 * (/proc/pressure/* and the slice's memory.pressure) is the truest "are we
 * stalling" signal — the fraction of recent wall-clock tasks spent waiting on
 * CPU or memory. All of it is plain reads of /proc and /sys: zero dependencies.
 */
import { readFileSync } from 'node:fs'
import os from 'node:os'

export interface VmStats {
	cpu: {
		load1: number
		cores: number
		// load1 / cores as a percentage, clamped to 100.
		pct: number
		// PSI "some" avg10 from /proc/pressure/cpu (% of time tasks stalled
		// waiting for CPU over the last 10s), or null if PSI isn't available.
		pressure: number | null
	}
	mem: {
		usedBytes: number
		// The cgroup ceiling (memory.max). null when unlimited / unreadable, in
		// which case usedPct falls back to host total.
		limitBytes: number | null
		// memory.high — the throttle-and-reclaim line that bites before the hard
		// max. Shown as the "amber" mark. null when unset/unreadable.
		highBytes: number | null
		usedPct: number
		// PSI "some" avg10 from the slice's memory.pressure, or null.
		pressure: number | null
		source: 'cgroup' | 'host'
	}
}

// PSI files look like:
//   some avg10=0.40 avg60=0.13 avg300=0.03 total=181987359
//   full avg10=0.00 ...
// We surface the "some" avg10 line — the share of the last 10s in which at
// least one task stalled on the resource.
function parsePressureSome(text: string): number | null {
	const m = text.match(/^some\b.*?\bavg10=([\d.]+)/m)
	return m ? Number(m[1]) : null
}

function readPressure(file: string): number | null {
	try {
		return parsePressureSome(readFileSync(file, 'utf8'))
	} catch {
		return null
	}
}

function readNum(file: string): number | null {
	try {
		const n = Number(readFileSync(file, 'utf8').trim())
		return Number.isFinite(n) ? n : null
	} catch {
		return null
	}
}

// cgroup memory.max / memory.high carry the literal "max" when unlimited.
function readBytesLimit(file: string): number | null {
	try {
		const raw = readFileSync(file, 'utf8').trim()
		if (raw === 'max' || raw === '') return null
		const n = Number(raw)
		return Number.isFinite(n) ? n : null
	} catch {
		return null
	}
}

// Resolve this process's most-specific *.slice cgroup directory under the
// unified hierarchy, e.g. "/ensembleworks.slice/ensembleworks-sync.service"
// → "/sys/fs/cgroup/ensembleworks.slice". Resolved once: a process doesn't
// migrate slices mid-life. Returns null off cgroup-v2 (then we fall back to
// host memory).
let sliceDirCache: string | null | undefined
function sliceCgroupDir(): string | null {
	if (sliceDirCache !== undefined) return sliceDirCache
	sliceDirCache = (() => {
		try {
			// cgroup v2 is a single "0::/<path>" line.
			const line = readFileSync('/proc/self/cgroup', 'utf8')
				.split('\n')
				.map((l) => l.split(':'))
				.find((p) => p[0] === '0' || p[1] === '')
			const rel = line?.[2] ?? ''
			const segs = rel.split('/').filter(Boolean)
			let idx = -1
			for (let i = 0; i < segs.length; i++) if (segs[i]!.endsWith('.slice')) idx = i
			if (idx === -1) return null
			return `/sys/fs/cgroup/${segs.slice(0, idx + 1).join('/')}`
		} catch {
			return null
		}
	})()
	return sliceDirCache
}

function readMem(): VmStats['mem'] {
	const dir = sliceCgroupDir()
	if (dir) {
		const usedBytes = readNum(`${dir}/memory.current`)
		if (usedBytes != null) {
			const limitBytes = readBytesLimit(`${dir}/memory.max`)
			const highBytes = readBytesLimit(`${dir}/memory.high`)
			const pressure = readPressure(`${dir}/memory.pressure`)
			const denom = limitBytes ?? os.totalmem()
			return {
				usedBytes,
				limitBytes,
				highBytes,
				usedPct: round1((usedBytes / denom) * 100),
				pressure,
				source: 'cgroup',
			}
		}
	}
	// No cgroup slice (non-Linux dev, cgroup v1) → host memory. used = total -
	// free is a rough figure on Linux but fine as a fallback.
	const total = os.totalmem()
	const used = total - os.freemem()
	return {
		usedBytes: used,
		limitBytes: total,
		highBytes: null,
		usedPct: round1((used / total) * 100),
		pressure: null,
		source: 'host',
	}
}

function round1(n: number): number {
	return Math.round(n * 10) / 10
}

// A 2s read-cache so a roomful of clients polling the pulse endpoint don't each
// re-stat /proc and /sys on the same tick. Cheap insurance; the reads are tiny.
let cache: { t: number; v: VmStats } | null = null

export function readVmStats(now: number = Date.now()): VmStats {
	if (cache && now - cache.t < 2000) return cache.v
	const cores = os.cpus().length || 1
	const load1 = os.loadavg()[0] ?? 0
	const v: VmStats = {
		cpu: {
			load1: round1(load1),
			cores,
			pct: Math.min(100, round1((load1 / cores) * 100)),
			pressure: readPressure('/proc/pressure/cpu'),
		},
		mem: readMem(),
	}
	cache = { t: now, v }
	return v
}

// Exposed for unit tests.
export const _internal = { parsePressureSome }
