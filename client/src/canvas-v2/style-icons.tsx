// Task style-panel-icons — small, self-contained inline SVG/CSS glyphs for
// every non-color StylePanel control (fill/dash/size/font/align/
// verticalAlign/textAlign/geo/arrowhead), replacing the plain `humanize(v)`
// text pills those controls used to render (StylePanel.tsx's AxisRow, before
// this task).
//
// WHY INLINE, NOT @tldraw/assets: v1's own icon rendering
// (TldrawUiIcon.tsx) resolves a name like 'fill-solid'/'geo-star' through
// `useAssetUrls()` to a URL fetched at runtime (a CDN-hosted or self-hosted
// SVG file), backed by the separate `@tldraw/assets` package — which is not
// installed in this workspace at all (checked: no @tldraw/assets in
// node_modules, not even transitively) and would be a real new external
// asset-pipeline dependency for one polish task. The task brief allows
// "otherwise inline SVGs" for exactly this case. These are small, self-drawn
// glyphs that read as the right FAMILY of control (a filled vs. outlined
// square for fill, a dash pattern for dash, a growing dot for size, an "Aa"
// in the real webfont for font, alignment bars, a per-variant outline for
// each of the 20 geo values, a per-variant line-ending for each of the 9
// arrowhead values) — not a pixel-for-pixel trace of tldraw's own icon set.
//
// PURELY PRESENTATIONAL: every icon component below takes just the axis
// VALUE (a plain string already validated by canvas-model's STYLE_ENUMS —
// see style-axes.ts's STYLE_VALUE_SETS) and renders a small, fixed-size
// (`ICON_PX`) glyph. None of them read shape/selection/editor state, add a
// click handler, or change what StylePanel.tsx's AxisRow does with a click —
// StylePanel.tsx still owns every `<button>`, `data-style-*` attribute, and
// `onClick`; these components only ever replace the TEXT CHILD of a control
// that already exists (or add an aria-label where the text child is gone),
// so no interaction contract applies (see StylePanel.tsx's own module
// header for the ux-contract opt-out this task recorded).
import type { CSSProperties, ReactNode } from 'react'

export const ICON_PX = 15

const BASE_ICON_STYLE: CSSProperties = { display: 'block', overflow: 'visible' }

function Svg({ children, viewBox = '0 0 24 24' }: { readonly children: ReactNode; readonly viewBox?: string }) {
	return (
		<svg width={ICON_PX} height={ICON_PX} viewBox={viewBox} style={BASE_ICON_STYLE} aria-hidden="true" focusable="false">
			{children}
		</svg>
	)
}

// ============================================================================
// Fill — canvas-model's FILL enum has 6 values (tldraw's own panel only ever
// shows 3 in its primary row plus 3 more in a "fillExtra" row — style-axes.ts
// keeps all 6 in one control, so all 6 need a distinct glyph).
// ============================================================================
export function FillIcon({ variant }: { readonly variant: string }) {
	switch (variant) {
		case 'none':
			return (
				<Svg>
					<rect x="5" y="5" width="14" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.75" />
				</Svg>
			)
		case 'semi':
			return (
				<Svg>
					<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.75" />
				</Svg>
			)
		case 'solid':
			return (
				<Svg>
					<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" fillOpacity="0.55" stroke="currentColor" strokeWidth="1.75" />
				</Svg>
			)
		case 'fill':
			return (
				<Svg>
					<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="currentColor" strokeWidth="1.75" />
				</Svg>
			)
		case 'pattern':
			return (
				<Svg>
					<defs>
						<pattern id="ew-fill-pattern" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
							<line x1="0" y1="0" x2="0" y2="4" stroke="currentColor" strokeWidth="1.5" />
						</pattern>
					</defs>
					<rect x="5" y="5" width="14" height="14" rx="2" fill="url(#ew-fill-pattern)" stroke="currentColor" strokeWidth="1.75" />
				</Svg>
			)
		case 'lined-fill':
			return (
				<Svg>
					<rect x="5" y="5" width="14" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.75" />
					<line x1="6" y1="18" x2="18" y2="6" stroke="currentColor" strokeWidth="1.5" />
					<line x1="6" y1="12" x2="12" y2="6" stroke="currentColor" strokeWidth="1.5" />
					<line x1="12" y1="18" x2="18" y2="12" stroke="currentColor" strokeWidth="1.5" />
				</Svg>
			)
		default:
			return (
				<Svg>
					<rect x="5" y="5" width="14" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.75" />
				</Svg>
			)
	}
}

// ============================================================================
// Dash — a short horizontal stroke, patterned per variant (draw's slight
// wobble approximated with a gentle curve, matching v1's hand-drawn feel).
// ============================================================================
export function DashIcon({ variant }: { readonly variant: string }) {
	const common = { stroke: 'currentColor', strokeWidth: 2.25, strokeLinecap: 'round' as const, fill: 'none' }
	switch (variant) {
		case 'none':
			return (
				<Svg>
					<line x1="4" y1="12" x2="20" y2="12" stroke="currentColor" strokeWidth="1.5" strokeDasharray="1 3" strokeLinecap="round" opacity="0.5" />
				</Svg>
			)
		case 'draw':
			return (
				<Svg>
					<path d="M4 13 Q9 9 12 12 T20 11" {...common} />
				</Svg>
			)
		case 'solid':
			return (
				<Svg>
					<line x1="4" y1="12" x2="20" y2="12" {...common} />
				</Svg>
			)
		case 'dashed':
			return (
				<Svg>
					<line x1="4" y1="12" x2="20" y2="12" {...common} strokeDasharray="4 3" />
				</Svg>
			)
		case 'dotted':
			return (
				<Svg>
					<line x1="4" y1="12" x2="20" y2="12" {...common} strokeDasharray="0.1 4" />
				</Svg>
			)
		default:
			return (
				<Svg>
					<line x1="4" y1="12" x2="20" y2="12" {...common} />
				</Svg>
			)
	}
}

// ============================================================================
// Size — a single dot, radius scaling with the value (parity idea: v1's own
// size icons are dots of increasing radius too — DefaultStylePanelContent's
// size row reads visually as "small dot -> big dot").
// ============================================================================
const SIZE_RADIUS: Readonly<Record<string, number>> = { s: 2.5, m: 4, l: 5.5, xl: 7.5 }
export function SizeIcon({ variant }: { readonly variant: string }) {
	const r = SIZE_RADIUS[variant] ?? 4
	return (
		<Svg>
			<circle cx="12" cy="12" r={r} fill="currentColor" />
		</Svg>
	)
}

// ============================================================================
// Font — an "Aa" glyph set in the ACTUAL webfont each value paints with
// (fonts.css, vendored alongside this task's own family — same
// tldraw_draw/tldraw_sans/tldraw_serif/tldraw_mono names NoteShape/GeoShape/
// TextShape already declare), so the icon doubles as a live preview, not
// just a labeled placeholder.
// ============================================================================
const FONT_FAMILY: Readonly<Record<string, string>> = {
	draw: "'tldraw_draw', sans-serif",
	sans: "'tldraw_sans', sans-serif",
	serif: "'tldraw_serif', serif",
	mono: "'tldraw_mono', monospace",
}
export function FontIcon({ variant }: { readonly variant: string }) {
	return (
		<span style={{ fontFamily: FONT_FAMILY[variant] ?? FONT_FAMILY.draw, fontSize: 13, lineHeight: 1, display: 'inline-block' }}>Aa</span>
	)
}

// ============================================================================
// Align (horizontal 'align'/'textAlign') and verticalAlign — three bars
// whose own alignment within the icon's box mirrors the value (start/
// middle/end), oriented per axis.
// ============================================================================
export function AlignIcon({ axis, variant }: { readonly axis: 'align' | 'textAlign' | 'verticalAlign'; readonly variant: string }) {
	const base = variant.endsWith('-legacy') ? variant.slice(0, -'-legacy'.length) : variant
	if (axis === 'verticalAlign') {
		const y = base === 'start' ? 4 : base === 'end' ? 16 : 10
		return (
			<Svg>
				<line x1="5" y1={y} x2="19" y2={y} stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
				<line x1="8" y1={y + 4} x2="16" y2={y + 4} stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.55" />
			</Svg>
		)
	}
	const x2 = base === 'start' ? 15 : base === 'end' ? 21 : 18
	const x1b = base === 'start' ? 5 : base === 'end' ? 11 : 8
	return (
		<Svg>
			<line x1="5" y1="7" x2="19" y2="7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
			<line x1={x1b} y1="12" x2={x2} y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
			<line x1="5" y1="17" x2="19" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
		</Svg>
	)
}

// ============================================================================
// Geo — one glyph per value of canvas-model's 20-entry GEO enum
// (shape.ts). A regular-polygon helper covers pentagon/hexagon/octagon; the
// rest get their own small path. Any value not explicitly handled (there
// should be none — this switch is exhaustive over STYLE_VALUE_SETS.geo, and
// style-icons.test.ts pins that every real value renders pairwise-distinct
// from every other) falls back to a plain rectangle outline,
// mirroring GeoShape.tsx's own "unhandled variant -> rectangle" fallback.
// ============================================================================
function regularPolygonPoints(sides: number, cx: number, cy: number, r: number, rotationDeg: number): string {
	const points: string[] = []
	for (let i = 0; i < sides; i++) {
		const angle = ((360 / sides) * i + rotationDeg) * (Math.PI / 180)
		points.push(`${(cx + r * Math.sin(angle)).toFixed(2)},${(cy - r * Math.cos(angle)).toFixed(2)}`)
	}
	return points.join(' ')
}

const outline = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinejoin: 'round' as const }

export function GeoIcon({ variant }: { readonly variant: string }) {
	switch (variant) {
		case 'rectangle':
			return (
				<Svg>
					<rect x="4" y="6" width="16" height="12" rx="1" {...outline} />
				</Svg>
			)
		case 'ellipse':
			return (
				<Svg>
					<ellipse cx="12" cy="12" rx="8" ry="6" {...outline} />
				</Svg>
			)
		case 'oval':
			return (
				<Svg>
					<ellipse cx="12" cy="12" rx="9" ry="5" {...outline} />
				</Svg>
			)
		case 'triangle':
			return (
				<Svg>
					<polygon points="12,4 20,20 4,20" {...outline} />
				</Svg>
			)
		case 'diamond':
			return (
				<Svg>
					<polygon points="12,3 21,12 12,21 3,12" {...outline} />
				</Svg>
			)
		case 'rhombus':
			return (
				<Svg>
					<polygon points="9,4 21,4 15,20 3,20" {...outline} />
				</Svg>
			)
		case 'rhombus-2':
			return (
				<Svg>
					<polygon points="15,4 21,20 9,20 3,4" {...outline} />
				</Svg>
			)
		case 'trapezoid':
			return (
				<Svg>
					<polygon points="8,6 16,6 20,18 4,18" {...outline} />
				</Svg>
			)
		case 'pentagon':
			return (
				<Svg>
					<polygon points={regularPolygonPoints(5, 12, 12.5, 9, 0)} {...outline} />
				</Svg>
			)
		case 'hexagon':
			return (
				<Svg>
					<polygon points={regularPolygonPoints(6, 12, 12, 9, 0)} {...outline} />
				</Svg>
			)
		case 'octagon':
			return (
				<Svg>
					<polygon points={regularPolygonPoints(8, 12, 12, 9, 22.5)} {...outline} />
				</Svg>
			)
		case 'star': {
			const points: string[] = []
			for (let i = 0; i < 10; i++) {
				const r = i % 2 === 0 ? 9 : 4
				const angle = (36 * i - 90) * (Math.PI / 180)
				points.push(`${(12 + r * Math.cos(angle)).toFixed(2)},${(12 + r * Math.sin(angle)).toFixed(2)}`)
			}
			return (
				<Svg>
					<polygon points={points.join(' ')} {...outline} />
				</Svg>
			)
		}
		case 'cloud':
			return (
				<Svg>
					<path
						d="M7 17a4 4 0 0 1-.5-7.97A5 5 0 0 1 16 7.1 4.5 4.5 0 0 1 17.5 17H7z"
						{...outline}
					/>
				</Svg>
			)
		case 'heart':
			return (
				<Svg>
					<path
						d="M12 20 4 12.5A4.5 4.5 0 1 1 12 8a4.5 4.5 0 1 1 8 4.5Z"
						{...outline}
					/>
				</Svg>
			)
		case 'arrow-right':
			return (
				<Svg>
					<line x1="4" y1="12" x2="18" y2="12" stroke="currentColor" strokeWidth="1.75" />
					<polygon points="14,7 21,12 14,17" {...outline} />
				</Svg>
			)
		case 'arrow-left':
			return (
				<Svg>
					<line x1="6" y1="12" x2="20" y2="12" stroke="currentColor" strokeWidth="1.75" />
					<polygon points="10,7 3,12 10,17" {...outline} />
				</Svg>
			)
		case 'arrow-up':
			return (
				<Svg>
					<line x1="12" y1="6" x2="12" y2="20" stroke="currentColor" strokeWidth="1.75" />
					<polygon points="7,10 12,3 17,10" {...outline} />
				</Svg>
			)
		case 'arrow-down':
			return (
				<Svg>
					<line x1="12" y1="4" x2="12" y2="18" stroke="currentColor" strokeWidth="1.75" />
					<polygon points="7,14 12,21 17,14" {...outline} />
				</Svg>
			)
		case 'x-box':
			return (
				<Svg>
					<rect x="4" y="4" width="16" height="16" rx="1" {...outline} />
					<line x1="7" y1="7" x2="17" y2="17" stroke="currentColor" strokeWidth="1.75" />
					<line x1="17" y1="7" x2="7" y2="17" stroke="currentColor" strokeWidth="1.75" />
				</Svg>
			)
		case 'check-box':
			return (
				<Svg>
					<rect x="4" y="4" width="16" height="16" rx="1" {...outline} />
					<polyline points="7,12 10.5,16 17,8" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
				</Svg>
			)
		default:
			return (
				<Svg>
					<rect x="4" y="6" width="16" height="12" rx="1" {...outline} />
				</Svg>
			)
	}
}

// ============================================================================
// Arrowhead — a short shaft with the variant's glyph at the tip (mirrors the
// real arrow overlay's own left-to-right convention). canvas-model's
// ARROWHEAD enum carries 9 values, one MORE than tldraw's own 8 ('pipe' —
// see StylePanel.tsx's module header / this task's brief: the model
// legitimately accepts it, the panel must offer it, even though tldraw's own
// panel doesn't). 'pipe' gets its own double-bar glyph so it reads as
// distinct from 'bar's single perpendicular stroke.
// ============================================================================
export function ArrowheadIcon({ variant }: { readonly variant: string }) {
	const shaft = <line x1="3" y1="12" x2="15" y2="12" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
	switch (variant) {
		case 'none':
			return (
				<Svg>
					<line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
				</Svg>
			)
		case 'arrow':
			return (
				<Svg>
					{shaft}
					<polyline points="12,7 19,12 12,17" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
				</Svg>
			)
		case 'triangle':
			return (
				<Svg>
					{shaft}
					<polygon points="14,7 21,12 14,17" {...outline} />
				</Svg>
			)
		case 'inverted':
			return (
				<Svg>
					{shaft}
					<polygon points="14,17 21,12 14,7" {...outline} />
				</Svg>
			)
		case 'square':
			return (
				<Svg>
					{shaft}
					<rect x="14" y="8" width="8" height="8" {...outline} />
				</Svg>
			)
		case 'dot':
			return (
				<Svg>
					{shaft}
					<circle cx="18" cy="12" r="4" fill="currentColor" />
				</Svg>
			)
		case 'diamond':
			return (
				<Svg>
					{shaft}
					<polygon points="18,7 23,12 18,17 13,12" {...outline} />
				</Svg>
			)
		case 'bar':
			return (
				<Svg>
					{shaft}
					<line x1="19" y1="6" x2="19" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
				</Svg>
			)
		case 'pipe':
			return (
				<Svg>
					{shaft}
					<line x1="17" y1="6" x2="17" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
					<line x1="20" y1="6" x2="20" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
				</Svg>
			)
		default:
			return (
				<Svg>
					<line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
				</Svg>
			)
	}
}
