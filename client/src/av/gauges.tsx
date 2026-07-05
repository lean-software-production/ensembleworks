import { wm } from '../theme'
import { type LatencySample, type VmStats } from './useSessionPulse'

// Green/amber/red by threshold — shared by the VM bars and the latency pills so
// "amber" means the same kind of "getting tight" everywhere in the panel.
function gradeColor(value: number, warn: number, crit: number): string {
	if (value >= crit) return wm.crit
	if (value >= warn) return wm.warn
	return wm.ok
}

function fmtBytes(n: number): string {
	if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)}G`
	if (n >= 1 << 20) return `${Math.round(n / (1 << 20))}M`
	return `${Math.round(n / 1024)}K`
}

// The VM-pressure strip: two compact bars (CPU then MEM) reading the one shared
// box everyone's terminals run on. MEM tracks the cgroup slice — the thing that
// OOM-kills the box — so its amber line sits at memory.high. Tooltips carry the
// raw load average, PSI stall %, and byte figures.
export function VmStrip({ vm }: { vm: VmStats }) {
	const cpuTip =
		`CPU load ${vm.cpu.load1} on ${vm.cpu.cores} core${vm.cpu.cores === 1 ? '' : 's'}` +
		(vm.cpu.pressure != null ? ` · stall ${vm.cpu.pressure}%/10s` : '')
	const memHighPct =
		vm.mem.limitBytes && vm.mem.highBytes ? (vm.mem.highBytes / vm.mem.limitBytes) * 100 : null
	const memTip =
		`Memory ${fmtBytes(vm.mem.usedBytes)}${vm.mem.limitBytes ? ` / ${fmtBytes(vm.mem.limitBytes)}` : ''}` +
		` (${vm.mem.source})` +
		(vm.mem.pressure != null ? ` · stall ${vm.mem.pressure}%/10s` : '')
	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 3 }} data-vm-strip>
			<VmBar
				label="LOAD"
				pct={vm.cpu.pct}
				color={gradeColor(vm.cpu.pct, 60, 85)}
				caption={`${Math.round(vm.cpu.pct)}%`}
				title={cpuTip}
			/>
			<VmBar
				label="MEM"
				pct={vm.mem.usedPct}
				color={gradeColor(vm.mem.usedPct, memHighPct ?? 70, 90)}
				caption={`${Math.round(vm.mem.usedPct)}%`}
				title={memTip}
				mark={memHighPct}
			/>
		</div>
	)
}

function VmBar(props: {
	label: string
	pct: number
	color: string
	caption: string
	title: string
	// Optional amber tick drawn at this percent (the memory.high throttle line).
	mark?: number | null
}) {
	return (
		<div title={props.title} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
			<span
				style={{
					fontFamily: wm.mono,
					fontSize: 8,
					fontWeight: 700,
					letterSpacing: 0.6,
					color: wm.inkMuted,
					width: 26,
					flex: '0 0 auto',
				}}
			>
				{props.label}
			</span>
			<div
				style={{
					position: 'relative',
					flex: 1,
					height: 6,
					borderRadius: 3,
					background: wm.panelWarm,
					overflow: 'hidden',
				}}
			>
				<div
					style={{
						width: `${Math.min(100, Math.max(0, props.pct))}%`,
						height: '100%',
						background: props.color,
						transition: 'width 600ms ease, background 600ms ease',
					}}
				/>
				{props.mark != null && (
					<div
						style={{
							position: 'absolute',
							top: 0,
							bottom: 0,
							left: `${Math.min(100, Math.max(0, props.mark))}%`,
							width: 1,
							background: wm.ink,
							opacity: 0.45,
						}}
					/>
				)}
			</div>
			<span
				style={{
					fontFamily: wm.mono,
					fontSize: 9,
					color: wm.inkMuted,
					width: 30,
					textAlign: 'right',
					flex: '0 0 auto',
				}}
			>
				{props.caption}
			</span>
		</div>
	)
}

// A small round-trip badge per participant row: a tiny line graph of the recent
// round-trips, with the numbers (min/max/latest) tucked into the hover tooltip.
// Normalised over its own min/max so the shape fills the box. Fewer than two
// samples can't draw a line, so it reads as a muted dash until the trail fills.
export function LatencyPill({ latency, history }: { latency: LatencySample | null; history: number[] }) {
	const known = latency != null
	const ms = latency?.rtt ?? 0
	const color = known ? gradeColor(ms, 120, 300) : wm.inkSubtle
	const w = 36
	const h = 11
	const min = history.length ? Math.min(...history) : 0
	const max = history.length ? Math.max(...history) : 0
	const title = known
		? `Round-trip to the server — now ${ms} ms, min ${min} ms, max ${max} ms (last ${history.length})`
		: 'No recent latency sample'

	if (history.length < 2) {
		return (
			<span
				title={title}
				style={{
					display: 'inline-flex',
					alignItems: 'center',
					justifyContent: 'center',
					width: w,
					flex: '0 0 auto',
					fontFamily: wm.mono,
					fontSize: 9,
					color: wm.inkSubtle,
				}}
			>
				—
			</span>
		)
	}

	const span = max - min || 1
	const stepX = w / (history.length - 1)
	// SVG y grows downward, so a higher rtt sits nearer the top (1px inset).
	const coords = history
		.map((p, i) => `${(i * stepX).toFixed(1)},${(1 + (1 - (p - min) / span) * (h - 2)).toFixed(1)}`)
		.join(' ')
	return (
		<svg
			width={w}
			height={h}
			viewBox={`0 0 ${w} ${h}`}
			style={{ flex: '0 0 auto', display: 'block' }}
		>
			<title>{title}</title>
			<polyline
				points={coords}
				fill="none"
				stroke={color}
				strokeWidth={1}
				strokeLinejoin="round"
				strokeLinecap="round"
			/>
		</svg>
	)
}
