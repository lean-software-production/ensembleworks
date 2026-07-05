/**
 * Pure roadmap document model for the roadmap shape: wire-format types, the
 * glyph/chip mappings from the Roadmap.dc.html design, the status-click
 * cycle, and an optimistic local mirror of the server's set/move semantics.
 * Keep op semantics in sync with server/src/roadmap-store.ts (applyOps).
 */

export interface RoadmapMetric {
	key: string
	text: string
	done: boolean
}
export interface RoadmapFeature {
	key: string
	text: string
	status: string
}
export interface RoadmapInitiative {
	key: string
	title: string
	status: string
	statement?: string
	metrics?: RoadmapMetric[]
	features?: RoadmapFeature[]
}
export interface RoadmapOutcome {
	key: string
	zone: string
	status: string
	title: string
	why?: string
	initiatives?: RoadmapInitiative[]
}
export interface RoadmapDoc {
	meta: { title: string; revision?: string; updated?: string }
	outcomes: RoadmapOutcome[]
}

export type RoadmapOp =
	| { op: 'replace'; data: RoadmapDoc }
	| { op: 'set'; key: string; fields: Record<string, unknown> }
	| { op: 'move'; key: string; zone?: string; index?: number }

export const ZONES = [
	{ id: 'done', label: 'Done — shipped', marker: false, warm: true },
	{ id: 'now', label: 'Now / in progress', marker: true, warm: false },
	{ id: 'next', label: 'Next', marker: false, warm: false },
	{ id: 'later', label: 'Later — ranked', marker: false, warm: false },
] as const

export function glyphFor(status: string): { g: string; c: string } {
	if (status === 'done') return { g: '✓', c: 'var(--rm-ok)' }
	if (status === 'in-progress') return { g: '●', c: 'var(--rm-seal-blue)' }
	if (status === 'parked') return { g: '–', c: 'var(--rm-fg-subtle)' }
	return { g: '○', c: 'var(--rm-fg-subtle)' }
}

export function chipFor(status: string): { text: string; fg: string; bc: string } {
	if (status === 'done') return { text: 'Done', fg: 'var(--rm-ok)', bc: 'rgba(21,163,134,0.4)' }
	if (status === 'in-progress') {
		return { text: 'In progress', fg: 'var(--rm-seal-blue)', bc: 'rgba(0,73,144,0.35)' }
	}
	if (status === 'parked') return { text: 'Parked', fg: 'var(--rm-fg-subtle)', bc: 'var(--rm-rule)' }
	return { text: 'Planned', fg: 'var(--rm-fg-subtle)', bc: 'var(--rm-rule)' }
}

// The v1 status click: planned → in-progress → done → planned. `parked` sits
// outside the cycle (parking is a deliberate CLI/agent act); clicking a
// parked item re-activates it as planned.
export function cycleStatus(status: string): string {
	if (status === 'planned') return 'in-progress'
	if (status === 'in-progress') return 'done'
	return 'planned'
}

// Filter semantics: 'all' matches everything, otherwise exact status match.
// Applied per node — an outcome, initiative or feature dims when its own
// status misses the filter, independent of its parent.
export function statusMatchesFilter(filter: string, status: string): boolean {
	return filter === 'all' || status === filter
}

// Metrics are binary (done / open). Done matches only the 'done' filter; an
// open metric is live work, so it matches every other filter.
export function metricMatchesFilter(filter: string, done: boolean): boolean {
	return filter === 'all' || (filter === 'done') === done
}

export function countsLine(doc: RoadmapDoc): string {
	const nI = doc.outcomes.reduce((n, o) => n + (o.initiatives ?? []).length, 0)
	const nF = doc.outcomes.reduce(
		(n, o) => n + (o.initiatives ?? []).reduce((m, i) => m + (i.features ?? []).length, 0),
		0
	)
	return `${doc.outcomes.length} outcomes · ${nI} initiatives · ${nF} features`
}

function findNode(doc: RoadmapDoc, key: string): { node: any; list: any[] } | null {
	for (const o of doc.outcomes) {
		if (o.key === key) return { node: o, list: doc.outcomes }
		for (const i of o.initiatives ?? []) {
			if (i.key === key) return { node: i, list: o.initiatives! }
			for (const m of i.metrics ?? []) if (m.key === key) return { node: m, list: i.metrics! }
			for (const f of i.features ?? []) if (f.key === key) return { node: f, list: i.features! }
		}
	}
	return null
}

// Optimistic mirror of the server's applyOps for the ops the canvas emits
// (set + move). Trusting by design: the component only builds valid ops, and
// any divergence is reconciled by the rev-bump refetch.
export function applyLocalOp(doc: RoadmapDoc, op: RoadmapOp): RoadmapDoc {
	if (op.op === 'replace') return structuredClone(op.data)
	const next = structuredClone(doc)
	const ref = findNode(next, op.key)
	if (!ref) return next
	if (op.op === 'set') {
		Object.assign(ref.node, op.fields)
		return next
	}
	if (ref.list === next.outcomes) {
		const outcomes = next.outcomes
		outcomes.splice(outcomes.indexOf(ref.node), 1)
		const zone = op.zone ?? ref.node.zone
		ref.node.zone = zone
		const zoneMembers = outcomes.filter((o) => o.zone === zone)
		const at = Math.min(op.index ?? zoneMembers.length, zoneMembers.length)
		const anchor = zoneMembers[at]
		const pos = anchor
			? outcomes.indexOf(anchor)
			: zoneMembers.length
				? outcomes.indexOf(zoneMembers[zoneMembers.length - 1]!) + 1
				: outcomes.length
		outcomes.splice(pos, 0, ref.node)
	} else {
		const list = ref.list
		list.splice(list.indexOf(ref.node), 1)
		list.splice(Math.min(op.index ?? list.length, list.length), 0, ref.node)
	}
	return next
}
