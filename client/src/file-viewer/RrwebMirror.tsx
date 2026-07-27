/**
 * Live mirror of a presenting peer's file-viewer iframe (spec:
 * 2026-07-27-file-viewer-rrweb-broadcast-design.md). Owns an rrweb Replayer
 * in liveMode: seeds from the HTTP backlog, appends live entries from
 * rrwebFollowStore, and scales the replayer wrapper to the shape box.
 * If no playable stream appears within FALLBACK_MS (old server, truncated
 * log, replayer throw), calls onFallback() so the parent reverts to the
 * scroll-fraction follow.
 */
import { useEffect, useRef } from 'react'
import { Replayer } from 'rrweb'
import 'rrweb/dist/style.css'
import { rrwebFollowStore, type RrwebEntry } from './rrwebFollow'

const FALLBACK_MS = 2000

export function RrwebMirror(props: {
	roomId: string
	shapeId: string
	width: number
	height: number
	onFallback: () => void
}) {
	const hostRef = useRef<HTMLDivElement | null>(null)
	const recordedSize = useRef<{ w: number; h: number } | null>(null)
	const replayerRef = useRef<Replayer | null>(null)
	const onFallbackRef = useRef(props.onFallback)
	onFallbackRef.current = props.onFallback

	// Scale the replayer wrapper to the current shape box (transform-origin
	// top-left; recomputed on resize and on rrweb viewport-resize events).
	const fit = () => {
		const host = hostRef.current
		const size = recordedSize.current
		const wrapper = host?.querySelector('.replayer-wrapper') as HTMLElement | null
		if (!host || !size || !wrapper || !size.w || !size.h) return
		const scale = Math.min(host.clientWidth / size.w, host.clientHeight / size.h)
		wrapper.style.transform = `scale(${scale})`
		wrapper.style.transformOrigin = 'top left'
		wrapper.style.position = 'absolute'
		wrapper.style.left = `${Math.max(0, (host.clientWidth - size.w * scale) / 2)}px`
		wrapper.style.top = '0px'
	}

	useEffect(() => {
		let disposed = false
		let sawSnapshot = false
		let failed = false
		let currentPresentId: string | null = null
		let buffered: RrwebEntry[] = []
		let fallbackTimer: ReturnType<typeof setTimeout> | undefined

		// No playable stream within FALLBACK_MS of the current presentation
		// starting → old server / truncated log / stalled peer → fall back.
		// Re-armed per presentation (not just once at mount) so a second
		// presentation that never sends Meta+FullSnapshot still triggers it.
		const armFallbackTimer = () => {
			clearTimeout(fallbackTimer)
			fallbackTimer = setTimeout(() => {
				if (!replayerRef.current && !failed) onFallbackRef.current()
			}, FALLBACK_MS)
		}

		const noteMeta = (entry: RrwebEntry) => {
			const ev = entry.event as { type?: number; data?: { width?: number; height?: number } }
			if (ev?.type === 4 && ev.data?.width) {
				recordedSize.current = { w: ev.data.width, h: ev.data.height ?? 1 }
				requestAnimationFrame(fit)
			}
			if (ev?.type === 2) sawSnapshot = true
		}

		const ensureReplayer = () => {
			// Needs Meta (type 4) + FullSnapshot (type 2) before construction.
			if (replayerRef.current || !sawSnapshot || buffered.length < 2 || !hostRef.current) return
			try {
				const r = new Replayer(buffered.map((e) => e.event) as any[], {
					root: hostRef.current,
					liveMode: true,
				})
				r.startLive()
				r.on('resize', (dim) => {
					const d = dim as { width: number; height: number }
					recordedSize.current = { w: d.width, h: d.height }
					fit()
				})
				replayerRef.current = r
				requestAnimationFrame(fit)
			} catch {
				failed = true
				onFallbackRef.current()
			}
		}

		// A new presentId on an already-subscribed shapeId means the presenter
		// restarted or a different peer took over — tear down and start clean
		// rather than feed a mismatched stream into the live replayer/buffer.
		const resetForNewPresentation = (presentId: string) => {
			replayerRef.current?.destroy()
			replayerRef.current = null
			sawSnapshot = false
			failed = false
			buffered = []
			recordedSize.current = null
			currentPresentId = presentId
			armFallbackTimer()
		}

		const apply = (entries: RrwebEntry[], meta: { presentId: string; truncated: boolean }) => {
			if (currentPresentId === null) {
				currentPresentId = meta.presentId
			} else if (meta.presentId !== currentPresentId) {
				resetForNewPresentation(meta.presentId)
			}
			// Overflow/truncation degrade: the stream is dead for this
			// presentation — drop the replayer and let the caller fall back to
			// scroll-fraction following, whether or not it had already started.
			if (meta.truncated) {
				if (!failed) {
					failed = true
					replayerRef.current?.destroy()
					replayerRef.current = null
					onFallbackRef.current()
				}
				return
			}
			if (failed) return
			for (const entry of entries) {
				noteMeta(entry)
				if (replayerRef.current) {
					try {
						replayerRef.current.addEvent(entry.event as any)
					} catch {
						failed = true
						onFallbackRef.current()
						return
					}
				} else {
					buffered.push(entry)
				}
			}
			ensureReplayer()
		}

		const unsub = rrwebFollowStore.subscribe(props.shapeId, (entries, meta) => apply(entries, meta))

		// Seed from the backlog (late join / mid-presentation mount).
		void fetch(
			`/api/canvas/file-viewer/present-events?room=${encodeURIComponent(props.roomId)}&shapeId=${encodeURIComponent(props.shapeId)}`
		)
			.then((res) => (res.ok ? res.json() : null))
			.then((backlog) => {
				if (!disposed && backlog) rrwebFollowStore.seedBacklog(props.shapeId, backlog)
			})
			.catch(() => {})

		armFallbackTimer()

		return () => {
			disposed = true
			clearTimeout(fallbackTimer)
			unsub()
			replayerRef.current?.destroy()
			replayerRef.current = null
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.shapeId, props.roomId])

	// Refit when the shape box resizes.
	useEffect(() => {
		fit()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.width, props.height])

	return (
		<div
			ref={hostRef}
			style={{
				flex: 1,
				minHeight: 0,
				position: 'relative',
				overflow: 'hidden',
				background: '#fdfcf9',
				pointerEvents: 'none',
			}}
		/>
	)
}
