/**
 * The roadmap control — a zoned outcome board (Done / Now / Next / Later)
 * rendered as a tldraw shape. React port of the Roadmap.dc.html design
 * component.
 *
 * Data plane: the document lives server-side (server/src/roadmap-store.ts);
 * this shape holds only { roadmapId, rev }. The component fetches the JSON on
 * mount and whenever props.rev changes — the server bumps rev on every write,
 * and that prop change arriving over tldraw sync is the multiplayer "refetch
 * now" signal. Human edits (drag-reorder, zone moves, status clicks) apply
 * optimistically via applyLocalOp and POST the same op the CLI would; a
 * failed POST triggers a refetch so the board never drifts from the server.
 *
 * Interaction gating follows the terminal shape: double-click to edit
 * (drag/filter/status-click active), Esc or click away to go back to canvas
 * navigation. View state (filter, collapse, drag hover) is local per client.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
	BaseBoxShapeUtil,
	HTMLContainer,
	T,
	TLBaseShape,
	TLResizeInfo,
	resizeBox,
	useEditor,
	useValue,
} from 'tldraw'
import { getRoomId } from '../identity'
import {
	ZONES,
	applyLocalOp,
	chipFor,
	countsLine,
	cycleStatus,
	glyphFor,
	type RoadmapDoc,
	type RoadmapInitiative,
	type RoadmapOp,
	type RoadmapOutcome,
} from './model'
import './roadmap.css'

export interface RoadmapShapeProps {
	w: number
	h: number
	roadmapId: string
	// Bumped server-side on every write (POST /api/roadmap) to trigger refetch.
	rev?: number
}

declare module '@tldraw/tlschema' {
	interface TLGlobalShapePropsMap {
		roadmap: RoadmapShapeProps
	}
}

export type RoadmapShape = TLBaseShape<'roadmap', RoadmapShapeProps>

export const ROADMAP_DEFAULT_W = 1280
export const ROADMAP_DEFAULT_H = 720
const MIN_W = 480
const MIN_H = 320

export class RoadmapShapeUtil extends BaseBoxShapeUtil<RoadmapShape> {
	static override type = 'roadmap' as const
	// Keep in sync with server/src/schema.ts
	static override props = {
		w: T.number,
		h: T.number,
		roadmapId: T.string,
		rev: T.number.optional(),
	}

	override getDefaultProps(): RoadmapShape['props'] {
		return { w: ROADMAP_DEFAULT_W, h: ROADMAP_DEFAULT_H, roadmapId: 'roadmap' }
	}

	override canEdit() {
		return true
	}
	override canScroll() {
		return true
	}
	override hideRotateHandle() {
		return true
	}

	override onResize(shape: RoadmapShape, info: TLResizeInfo<RoadmapShape>) {
		return resizeBox(shape, info, { minWidth: MIN_W, minHeight: MIN_H })
	}

	override component(shape: RoadmapShape) {
		return <RoadmapShapeComponent shape={shape} />
	}

	override getIndicatorPath(shape: RoadmapShape) {
		const path = new Path2D()
		path.rect(0, 0, shape.props.w, shape.props.h)
		return path
	}
}

interface DragInfo {
	type: 'outcome' | 'ini' | 'child'
	container: string
	key: string
}

const FILTERS = [
	['all', 'All'],
	['done', 'Done'],
	['in-progress', 'In progress'],
	['planned', 'Planned'],
] as const

function RoadmapShapeComponent({ shape }: { shape: RoadmapShape }) {
	const editor = useEditor()
	const isEditing = useValue(
		'isEditing',
		() => editor.getEditingShapeId() === shape.id,
		[editor, shape.id]
	)
	const [doc, setDoc] = useState<RoadmapDoc | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [refresh, setRefresh] = useState(0)
	const [filter, setFilter] = useState('all')
	const [openState, setOpenState] = useState<Record<string, boolean>>({})
	const [copied, setCopied] = useState<string | null>(null)
	const [over, setOver] = useState<string | null>(null)
	const drag = useRef<DragInfo | null>(null)
	const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

	const { roadmapId, rev } = shape.props

	useEffect(() => {
		let cancelled = false
		fetch(
			`/api/roadmap?room=${encodeURIComponent(getRoomId())}&name=${encodeURIComponent(roadmapId)}`
		)
			.then(async (r) => {
				if (r.status === 404) return null
				if (!r.ok) throw new Error(`server answered ${r.status}`)
				return ((await r.json()) as { data: RoadmapDoc }).data
			})
			.then((data) => {
				if (cancelled) return
				setDoc(data)
				setError(null)
			})
			.catch((err) => {
				if (!cancelled) setError(String(err?.message ?? err))
			})
		return () => {
			cancelled = true
		}
	}, [roadmapId, rev, refresh])

	// Optimistic write: mutate the local doc, POST the same op the CLI would,
	// refetch on failure so the board reconverges with the server.
	const postOp = useCallback(
		(op: RoadmapOp) => {
			setDoc((d) => (d ? applyLocalOp(d, op) : d))
			fetch('/api/roadmap', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ room: getRoomId(), name: roadmapId, ops: [op] }),
			})
				.then((r) => {
					if (!r.ok) setRefresh((n) => n + 1)
				})
				.catch(() => setRefresh((n) => n + 1))
		},
		[roadmapId]
	)

	const copyKey = (key: string) => {
		navigator.clipboard?.writeText(key).catch(() => {})
		setCopied(key)
		clearTimeout(copyTimer.current)
		copyTimer.current = setTimeout(() => setCopied(null), 1400)
	}

	// ---- drag core (port of DCLogic's drag core) ------------------------------
	const startDrag = (e: React.DragEvent, info: DragInfo) => {
		e.stopPropagation()
		drag.current = info
		try {
			e.dataTransfer.setData('text/plain', info.key)
			e.dataTransfer.effectAllowed = 'move'
		} catch {
			/* dataTransfer may be unavailable in tests */
		}
	}
	const endDrag = () => {
		drag.current = null
		setOver(null)
	}
	const allowDrop = (e: React.DragEvent, type: DragInfo['type'], container: string, sig: string) => {
		const d = drag.current
		if (d && d.type === type && d.container === container) {
			e.preventDefault()
			e.stopPropagation()
			if (over !== sig) setOver(sig)
		}
	}
	const overShadow = (sig: string) => (over === sig ? '0 0 0 2px var(--rm-seal-blue) inset' : 'none')

	// ---- drop handlers → move ops ---------------------------------------------
	// Dropping outcome A on outcome B: A adopts B's zone and takes B's index
	// within that zone (server move semantics are index-within-zone).
	const dropOutcomeOn = (e: React.DragEvent, targetKey: string) => {
		e.preventDefault()
		e.stopPropagation()
		const d = drag.current
		if (!doc || !d || d.type !== 'outcome' || d.key === targetKey) return endDrag()
		const target = doc.outcomes.find((o) => o.key === targetKey)
		if (!target) return endDrag()
		const zoneMembers = doc.outcomes.filter((o) => o.zone === target.zone && o.key !== d.key)
		postOp({
			op: 'move',
			key: d.key,
			zone: target.zone,
			index: zoneMembers.findIndex((o) => o.key === targetKey),
		})
		endDrag()
	}
	const dropOutcomeOnZone = (e: React.DragEvent, zoneId: string) => {
		e.preventDefault()
		e.stopPropagation()
		const d = drag.current
		if (!d || d.type !== 'outcome') return endDrag()
		postOp({ op: 'move', key: d.key, zone: zoneId })
		endDrag()
	}
	// Reorder within a nested list (initiatives / metrics / features).
	const dropInList = (e: React.DragEvent, list: { key: string }[], targetKey: string) => {
		e.preventDefault()
		e.stopPropagation()
		const d = drag.current
		if (!d || d.key === targetKey) return endDrag()
		const without = list.filter((x) => x.key !== d.key)
		postOp({ op: 'move', key: d.key, index: without.findIndex((x) => x.key === targetKey) })
		endDrag()
	}

	const keyBtn = (key: string) => (
		<button
			className="rm-key"
			title="Copy key"
			style={copied === key ? { color: 'var(--rm-ok)' } : undefined}
			onClick={(e) => {
				e.stopPropagation()
				copyKey(key)
			}}
		>
			{copied === key ? 'copied ✓' : key}
		</button>
	)

	// ---- nested renderers -------------------------------------------------------
	const renderChild = (
		item: { key: string; text: string; done?: boolean; status?: string },
		kind: 'metrics' | 'features',
		ini: RoadmapInitiative,
		outcomeKey: string
	) => {
		const container = `child:${outcomeKey}/${ini.key}/${kind}`
		const sig = `${container}:${item.key}`
		const isMetric = kind === 'metrics'
		const g = isMetric
			? { g: item.done ? '✓' : '○', c: item.done ? 'var(--rm-ok)' : 'var(--rm-fg-subtle)' }
			: glyphFor(item.status ?? 'planned')
		const list = (isMetric ? ini.metrics : ini.features) ?? []
		return (
			<div
				key={item.key}
				className="rm-drag"
				draggable
				onDragStart={(e) => startDrag(e, { type: 'child', container, key: item.key })}
				onDragEnd={endDrag}
				onDragOver={(e) => allowDrop(e, 'child', container, sig)}
				onDrop={(e) => dropInList(e, list, item.key)}
				style={{
					display: 'flex',
					gap: 6,
					padding: '5px 0',
					borderBottom: '1px solid var(--rm-rule-cool)',
					boxShadow: overShadow(sig),
				}}
			>
				<span style={{ color: 'var(--rm-fg-subtle)', fontSize: 10, flex: 'none', letterSpacing: -2 }}>⠿</span>
				<button
					className="rm-glyph"
					style={{ color: g.c }}
					title={isMetric ? 'Toggle done' : 'Cycle status'}
					onClick={(e) => {
						e.stopPropagation()
						postOp(
							isMetric
								? { op: 'set', key: item.key, fields: { done: !item.done } }
								: { op: 'set', key: item.key, fields: { status: cycleStatus(item.status ?? 'planned') } }
						)
					}}
				>
					{g.g}
				</button>
				<div style={{ flex: 1 }}>
					<div style={{ fontSize: 11.5, lineHeight: 1.4 }}>{item.text}</div>
					{keyBtn(item.key)}
				</div>
			</div>
		)
	}

	const renderInitiative = (ini: RoadmapInitiative, outcomeKey: string) => {
		const isOpen = openState[ini.key] ?? true
		const st = glyphFor(ini.status)
		const container = `ini:${outcomeKey}`
		const sig = `${container}:${ini.key}`
		const list = doc?.outcomes.find((o) => o.key === outcomeKey)?.initiatives ?? []
		return (
			<div
				key={ini.key}
				onDragOver={(e) => allowDrop(e, 'ini', container, sig)}
				onDrop={(e) => dropInList(e, list, ini.key)}
				style={{
					width: 212,
					flex: 'none',
					border: '1px solid var(--rm-rule)',
					borderRadius: 2,
					background: 'var(--rm-bg)',
					boxShadow: overShadow(sig),
				}}
			>
				<div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '8px 10px', background: 'var(--rm-panel)' }}>
					<span
						className="rm-drag"
						draggable
						onDragStart={(e) => startDrag(e, { type: 'ini', container, key: ini.key })}
						onDragEnd={endDrag}
						title="Drag to reorder"
						style={{ color: 'var(--rm-fg-subtle)', fontSize: 11, lineHeight: 1.5, flex: 'none', letterSpacing: -2 }}
					>
						⠿
					</span>
					<button
						className="rm-glyph"
						style={{ color: st.c, fontSize: 11 }}
						title="Cycle status"
						onClick={(e) => {
							e.stopPropagation()
							postOp({ op: 'set', key: ini.key, fields: { status: cycleStatus(ini.status) } })
						}}
					>
						{st.g}
					</button>
					<div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
						<div style={{ fontWeight: 700, fontSize: 12.5, lineHeight: 1.3 }}>{ini.title}</div>
						{keyBtn(ini.key)}
					</div>
					<button
						title="Collapse / expand"
						onClick={(e) => {
							e.stopPropagation()
							setOpenState((s) => ({ ...s, [ini.key]: !isOpen }))
						}}
						style={{
							flex: 'none',
							width: 18,
							height: 18,
							fontFamily: 'var(--rm-mono)',
							fontSize: 11,
							lineHeight: 1,
							color: 'var(--rm-fg-muted)',
							background: 'none',
							border: '1px solid var(--rm-rule)',
							borderRadius: 2,
							cursor: 'pointer',
							padding: 0,
						}}
					>
						{isOpen ? '–' : '+'}
					</button>
				</div>
				{isOpen && (
					<div style={{ padding: 10, borderTop: '1px solid var(--rm-rule)' }}>
						{ini.statement && (
							<p style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--rm-fg-muted)', fontStyle: 'italic', margin: '0 0 10px' }}>
								{ini.statement}
							</p>
						)}
						<div className="rm-label" style={{ fontSize: 8, color: 'var(--rm-seal-blue)', marginBottom: 2 }}>
							Metrics — when done?
						</div>
						{(ini.metrics ?? []).map((m) => renderChild(m, 'metrics', ini, outcomeKey))}
						<div className="rm-label" style={{ fontSize: 8, color: 'var(--rm-seal-blue)', margin: '10px 0 2px' }}>
							Features
						</div>
						{(ini.features ?? []).map((f) => renderChild(f, 'features', ini, outcomeKey))}
					</div>
				)}
			</div>
		)
	}

	const renderOutcome = (oc: RoadmapOutcome) => {
		const match = filter === 'all' || oc.status === filter
		const chip = chipFor(oc.status)
		const sig = `oc:${oc.key}`
		return (
			<div
				key={oc.key}
				onDragOver={(e) => allowDrop(e, 'outcome', 'root', sig)}
				onDrop={(e) => dropOutcomeOn(e, oc.key)}
				style={{
					opacity: match ? 1 : 0.22,
					borderRight: '1px solid var(--rm-rule)',
					padding: '0 12px 16px',
					transition: 'opacity 120ms linear',
					boxShadow: overShadow(sig),
				}}
			>
				<div
					className="rm-drag"
					draggable
					onDragStart={(e) => startDrag(e, { type: 'outcome', container: 'root', key: oc.key })}
					onDragEnd={endDrag}
					style={{
						height: 72,
						display: 'flex',
						flexDirection: 'column',
						justifyContent: 'center',
						gap: 5,
						borderBottom: '1px solid var(--rm-rule)',
					}}
				>
					<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
						<span style={{ color: 'var(--rm-fg-subtle)', fontSize: 11, lineHeight: 1, letterSpacing: -2 }}>⠿</span>
						<button
							className="rm-key"
							title="Copy key"
							style={{
								fontSize: 9.5,
								letterSpacing: 1,
								padding: '2px 7px',
								background: 'var(--rm-panel)',
								border: '1px solid var(--rm-rule)',
								borderRadius: 2,
								...(copied === oc.key ? { color: 'var(--rm-ok)' } : {}),
							}}
							onClick={(e) => {
								e.stopPropagation()
								copyKey(oc.key)
							}}
						>
							{copied === oc.key ? 'copied ✓' : oc.key}
						</button>
						<button
							title="Cycle status"
							onClick={(e) => {
								e.stopPropagation()
								postOp({ op: 'set', key: oc.key, fields: { status: cycleStatus(oc.status) } })
							}}
							style={{
								fontFamily: 'var(--rm-mono)',
								fontSize: 8.5,
								letterSpacing: 1.5,
								padding: '2px 6px',
								whiteSpace: 'nowrap',
								border: `1px solid ${chip.bc}`,
								color: chip.fg,
								background: 'none',
								borderRadius: 2,
								textTransform: 'uppercase',
								cursor: 'pointer',
							}}
						>
							{chip.text}
						</button>
					</div>
					<div style={{ fontFamily: 'var(--rm-serif)', fontWeight: 600, fontSize: 16, letterSpacing: -0.2, lineHeight: 1.15 }}>
						{oc.title}
					</div>
				</div>
				<div style={{ height: 104, borderBottom: '1px solid var(--rm-rule)', padding: '10px 2px', overflow: 'hidden' }}>
					<div className="rm-label" style={{ fontSize: 8, marginBottom: 4 }}>
						Why
					</div>
					<p style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--rm-fg-muted)', margin: 0, maxWidth: '44ch' }}>
						{oc.why}
					</p>
				</div>
				<div style={{ display: 'flex', gap: 12, paddingTop: 12, alignItems: 'flex-start' }}>
					{(oc.initiatives ?? []).map((ini) => renderInitiative(ini, oc.key))}
				</div>
			</div>
		)
	}

	// ---- top-level layout ---------------------------------------------------------
	const header = (
		<div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', borderBottom: '1px solid var(--rm-rule-strong)' }}>
			<div style={{ width: 20, height: 20, background: 'var(--rm-seal-blue)', borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
				<div style={{ width: 8, height: 8, background: 'var(--rm-seal-cream)', transform: 'rotate(45deg)' }} />
			</div>
			<div>
				<div style={{ fontFamily: 'var(--rm-serif)', fontWeight: 600, fontSize: 17, letterSpacing: -0.2 }}>
					{doc?.meta.title ?? shape.props.roadmapId}
				</div>
				<div className="rm-label" style={{ fontSize: 9, letterSpacing: 1, textTransform: 'none' }}>
					{doc
						? `${[doc.meta.revision, doc.meta.updated].filter(Boolean).join(' · ')} · ${countsLine(doc)}`
						: error
							? `unreachable: ${error}`
							: 'loading…'}
				</div>
			</div>
			<div style={{ flex: 1 }} />
			<span className="rm-label">Drag to reorder · Filter</span>
			<div style={{ display: 'flex', gap: 6 }}>
				{FILTERS.map(([id, label]) => {
					const active = filter === id
					return (
						<button
							key={id}
							onClick={(e) => {
								e.stopPropagation()
								setFilter(id)
							}}
							style={{
								fontFamily: 'var(--rm-mono)',
								fontSize: 8.5,
								letterSpacing: 1.5,
								textTransform: 'uppercase',
								whiteSpace: 'nowrap',
								padding: '4px 9px',
								border: `1px solid ${active ? 'var(--rm-seal-blue)' : 'var(--rm-rule-strong)'}`,
								borderRadius: 2,
								background: active ? 'var(--rm-seal-blue)' : 'transparent',
								color: active ? '#f6efe2' : 'var(--rm-fg-muted)',
								cursor: 'pointer',
							}}
						>
							{label}
						</button>
					)
				})}
			</div>
		</div>
	)

	const board = doc && (
		<div style={{ overflow: 'auto', flex: 1 }}>
			<div style={{ display: 'flex', alignItems: 'stretch', minWidth: 'max-content', minHeight: '100%' }}>
				{/* Sticky left rail: row labels for the aligned outcome grid. */}
				<div style={{ position: 'sticky', left: 0, zIndex: 4, flex: 'none', width: 84, background: 'var(--rm-bg)', borderRight: '1px solid var(--rm-rule-strong)', display: 'flex', flexDirection: 'column' }}>
					<div style={{ height: 36, borderBottom: '1px solid var(--rm-rule-strong)' }} />
					<div style={{ height: 72, display: 'flex', alignItems: 'center', padding: '0 10px', borderBottom: '1px solid var(--rm-rule)' }}>
						<span className="rm-label">Outcome</span>
					</div>
					<div style={{ height: 104, display: 'flex', alignItems: 'center', padding: '0 10px', borderBottom: '1px solid var(--rm-rule)' }}>
						<span className="rm-label">Why</span>
					</div>
					<div style={{ flex: 1, padding: '16px 10px' }}>
						<span className="rm-label" style={{ lineHeight: 2 }}>
							Initiatives
							<br />
							Metrics
							<br />
							Features
						</span>
					</div>
				</div>

				{ZONES.map((zone) => {
					const outcomes = doc.outcomes.filter((o) => o.zone === zone.id)
					const zoneSig = `zone:${zone.id}`
					return (
						<div key={zone.id} style={{ display: 'contents' }}>
							{zone.marker && (
								<div style={{ flex: 'none', width: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--rm-panel)', borderRight: '2px solid var(--rm-seal-blue)' }}>
									<span style={{ writingMode: 'vertical-rl', fontFamily: 'var(--rm-mono)', fontSize: 9, letterSpacing: 3, color: 'var(--rm-seal-blue)', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
										← past · Today · future →
									</span>
								</div>
							)}
							<div style={{ flex: 'none', minWidth: 260, borderRight: '1px solid var(--rm-rule-strong)', background: zone.warm ? 'var(--rm-bg-warm)' : 'transparent' }}>
								<div
									onDragOver={(e) => allowDrop(e, 'outcome', 'root', zoneSig)}
									onDrop={(e) => dropOutcomeOnZone(e, zone.id)}
									style={{ height: 36, display: 'flex', alignItems: 'center', padding: '0 14px', borderBottom: '1px solid var(--rm-rule-strong)', boxShadow: overShadow(zoneSig) }}
								>
									<span style={{ fontFamily: 'var(--rm-mono)', fontSize: 9.5, fontWeight: 500, letterSpacing: 2, color: 'var(--rm-seal-blue)', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
										{zone.label}
									</span>
									<span style={{ flex: 1 }} />
									<span style={{ fontFamily: 'var(--rm-mono)', fontSize: 8.5, color: 'var(--rm-fg-subtle)' }}>
										{outcomes.length}
									</span>
								</div>
								<div
									onDragOver={(e) => allowDrop(e, 'outcome', 'root', zoneSig)}
									onDrop={(e) => dropOutcomeOnZone(e, zone.id)}
									style={{ display: 'flex', alignItems: 'stretch', minHeight: 120 }}
								>
									{outcomes.length === 0 ? (
										<div className="rm-label" style={{ width: 244, margin: '16px 8px', border: '1px dashed var(--rm-rule-strong)', borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: overShadow(zoneSig) }}>
											Drop outcome here
										</div>
									) : (
										outcomes.map(renderOutcome)
									)}
								</div>
							</div>
						</div>
					)
				})}
			</div>
		</div>
	)

	const emptyState = !doc && (
		<div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 24 }}>
			<div style={{ textAlign: 'center', maxWidth: 420 }}>
				<div style={{ fontFamily: 'var(--rm-serif)', fontWeight: 600, fontSize: 17, marginBottom: 8 }}>
					{error ? 'Roadmap unreachable' : 'No roadmap data yet'}
				</div>
				<div style={{ fontSize: 12, color: 'var(--rm-fg-muted)', lineHeight: 1.5 }}>
					{error ??
						`Push one from a canvas terminal: canvas roadmap push "${shape.props.roadmapId}" roadmap.json`}
				</div>
			</div>
		</div>
	)

	const legend = (
		<div style={{ display: 'flex', gap: 18, padding: '10px 18px', borderTop: '1px solid var(--rm-rule-strong)' }}>
			<span className="rm-label" style={{ letterSpacing: 1, textTransform: 'none' }}>✓ done</span>
			<span className="rm-label" style={{ letterSpacing: 1, textTransform: 'none' }}>● in progress</span>
			<span className="rm-label" style={{ letterSpacing: 1, textTransform: 'none' }}>○ planned</span>
			<span style={{ flex: 1 }} />
			<span className="rm-label" style={{ letterSpacing: 1, textTransform: 'none' }}>
				{isEditing ? '⠿ drag to reorder · click glyphs to set status · click keys to copy' : 'double-click to interact'}
			</span>
		</div>
	)

	return (
		<HTMLContainer style={{ pointerEvents: isEditing ? 'all' : 'none' }}>
			<div
				className="rm-root"
				onPointerDown={(e) => {
					if (isEditing) e.stopPropagation()
				}}
				onWheel={(e) => {
					if (isEditing) e.stopPropagation()
				}}
				style={{
					width: shape.props.w,
					height: shape.props.h,
					display: 'flex',
					flexDirection: 'column',
					overflow: 'hidden',
					border: '1px solid var(--rm-rule-strong)',
					borderRadius: 4,
					background: 'var(--rm-bg)',
				}}
			>
				{header}
				{doc ? board : emptyState}
				{legend}
			</div>
		</HTMLContainer>
	)
}
