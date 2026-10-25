import type { ReactNode } from 'react'
import type { ToolId } from '@ensembleworks/canvas-editor'

const PATHS: Record<ToolId, ReactNode> = {
	select: <path d="M6 3l12 9-5.5 1.2L9.5 19z" />,
	hand: <path d="M8 13V6a1.5 1.5 0 013 0v5m0-6.5a1.5 1.5 0 013 0V11m0-5a1.5 1.5 0 013 0v7.5c0 4-2.5 6.5-6 6.5-3 0-4.5-1.5-6-4l-2-3.5a1.5 1.5 0 012.6-1.5L8 13" />,
	note: (
		<>
			<path d="M5 4h14v10l-5 6H5z" />
			<path d="M14 20v-6h5" />
		</>
	),
	text: <path d="M5 7V5h14v2M12 5v14M9 19h6" />,
	geo: <rect x="4" y="6" width="16" height="12" rx="1.5" />,
	frame: <path d="M8 3v18M16 3v18M3 8h18M3 16h18" />,
	bbthread: (
		<>
			<rect x="4" y="5" width="16" height="14" rx="1" />
			<rect x="14" y="5" width="6" height="14" fill="currentColor" stroke="none" />
		</>
	),
	arrow: <path d="M5 19L19 5M10 5h9v9" />,
	draw: <path d="M4 17c2.5-5 4.5 1.5 7.5-3.5S15.5 7 20 6" />,
	line: (
		<>
			<path d="M6.5 17.5l11-11" />
			<circle cx="5.5" cy="18.5" r="1.5" />
			<circle cx="18.5" cy="5.5" r="1.5" />
		</>
	),
}

export function ToolIcon({ tool }: { readonly tool: ToolId }) {
	return (
		<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
			{PATHS[tool]}
		</svg>
	)
}
