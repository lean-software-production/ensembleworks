import { useEffect, useRef, useState } from 'react'
import { stopEventPropagation } from 'tldraw'
import { scheduler } from '../kernel/scheduler'
import { wm } from '../theme'

// The shape of a transcript entry as served by GET /api/scribe/transcript. Mirrors the
// server's TranscriptEntry; only the fields the modal renders are typed here.
interface TranscriptLine {
	id: string
	t: number
	name: string
	text: string
	frame: { name: string; dist: number } | null
}

// A read-only popup over the canvas showing the session's running transcript.
// Polls every 4s so it stays live while the scribe is recording, and sticks to
// the newest line unless the reader has scrolled up into the history.
export function TranscriptModal({ roomId, onClose }: { roomId: string; onClose: () => void }) {
	const [entries, setEntries] = useState<TranscriptLine[]>([])
	const [error, setError] = useState<string | null>(null)
	const [loaded, setLoaded] = useState(false)
	const scrollRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		let cancelled = false
		const load = async () => {
			try {
				const res = await fetch(`/api/scribe/transcript?room=${encodeURIComponent(roomId)}&limit=500`)
				const body = (await res.json()) as { entries?: TranscriptLine[]; error?: string }
				if (cancelled) return
				if (!res.ok) throw new Error(body.error || 'Failed to load transcript')
				setEntries(body.entries ?? [])
				setError(null)
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load transcript')
			} finally {
				if (!cancelled) setLoaded(true)
			}
		}
		load()
		const cancel = scheduler.every(4000, () => {
			void load()
		})
		return () => {
			cancelled = true
			cancel()
		}
	}, [roomId])

	// Follow the tail on new lines, but leave the scroll alone if the reader has
	// scrolled up to revisit earlier turns.
	useEffect(() => {
		const el = scrollRef.current
		if (!el) return
		if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight
	}, [entries])

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [onClose])

	return (
		<div
			// Click the backdrop (but not the panel) to dismiss.
			onPointerDown={(e) => {
				stopEventPropagation(e)
				onClose()
			}}
			style={{
				position: 'fixed',
				inset: 0,
				zIndex: 1000,
				display: 'grid',
				placeItems: 'center',
				background: 'rgba(0, 0, 0, 0.35)',
				pointerEvents: 'auto',
			}}
		>
			<div
				onPointerDown={stopEventPropagation}
				style={{
					display: 'flex',
					flexDirection: 'column',
					width: 'min(560px, 90vw)',
					maxHeight: '80vh',
					background: wm.bg,
					border: `1px solid ${wm.ruleStrong}`,
					borderRadius: 4,
					boxShadow: wm.shadowPaper,
					fontFamily: wm.sans,
				}}
			>
				<div
					style={{
						display: 'flex',
						alignItems: 'baseline',
						justifyContent: 'space-between',
						gap: 12,
						padding: '10px 12px',
						borderBottom: `1px solid ${wm.rule}`,
					}}
				>
					<strong
						style={{
							fontFamily: wm.mono,
							fontSize: 11,
							textTransform: 'uppercase',
							letterSpacing: 1,
						}}
					>
						Session transcript
					</strong>
					<span style={{ fontSize: 11, color: wm.inkSubtle }}>
						{entries.length} {entries.length === 1 ? 'line' : 'lines'}
					</span>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close transcript"
						style={{
							border: `1px solid ${wm.ruleStrong}`,
							borderRadius: 2,
							background: 'transparent',
							color: wm.ink,
							padding: '2px 8px',
							fontFamily: wm.mono,
							fontSize: 12,
							cursor: 'pointer',
						}}
					>
						✕
					</button>
				</div>
				<div
					ref={scrollRef}
					style={{
						overflowY: 'auto',
						padding: '10px 12px',
						display: 'flex',
						flexDirection: 'column',
						gap: 10,
					}}
				>
					{error && <span style={{ fontSize: 12, color: wm.crit }}>{error}</span>}
					{!error && !loaded && (
						<span style={{ fontSize: 12, color: wm.inkSubtle }}>Loading…</span>
					)}
					{!error && loaded && entries.length === 0 && (
						<span style={{ fontSize: 12, color: wm.inkSubtle }}>
							No transcript yet — say something and it'll appear here.
						</span>
					)}
					{entries.map((entry) => (
						<div key={entry.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
							<div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
								<span style={{ fontFamily: wm.mono, fontSize: 10, color: wm.inkSubtle }}>
									{new Date(entry.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
								</span>
								<span style={{ fontSize: 12, fontWeight: 700, color: wm.ink }}>{entry.name}</span>
								{entry.frame && (
									<span
										style={{
											fontFamily: wm.mono,
											fontSize: 9,
											textTransform: 'uppercase',
											letterSpacing: 0.6,
											color: wm.sealBlue,
										}}
									>
										{entry.frame.name}
									</span>
								)}
							</div>
							<div style={{ fontSize: 13, lineHeight: 1.4, color: wm.ink }}>{entry.text}</div>
						</div>
					))}
				</div>
			</div>
		</div>
	)
}
