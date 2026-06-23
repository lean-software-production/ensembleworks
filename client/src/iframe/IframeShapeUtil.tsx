/**
 * An iframe as a tldraw shape — for dev servers running on the VM (proxied
 * under the canvas origin at /dev/{port}/, see deploy/Caddyfile) and any
 * other embeddable web content (docs, dashboards, Storybook…).
 *
 * Position and size are shared via tldraw sync; the iframe's *content* state
 * (scroll position, session) is intentionally per-user. Double-click to
 * interact with the page; click away to go back to canvas navigation.
 */
import { useRef } from 'react'
import {
	BaseBoxShapeUtil,
	HTMLContainer,
	T,
	TLBaseShape,
	TLResizeInfo,
	resizeBox,
	stopEventPropagation,
	useEditor,
	useValue,
} from 'tldraw'
import { wm } from '../theme'

export interface IframeShapeProps {
	w: number
	h: number
	url: string
	title: string
}

declare module '@tldraw/tlschema' {
	interface TLGlobalShapePropsMap {
		iframe: IframeShapeProps
	}
}

export type IframeShape = TLBaseShape<'iframe', IframeShapeProps>

const HEADER_HEIGHT = 28

/**
 * URLs pointing at the VM itself ("localhost" from the VM's perspective)
 * are rewritten to the Caddy dev proxy so every teammate can load them.
 */
export function toProxiedUrl(raw: string): string {
	try {
		const url = new URL(raw)
		const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
		if (isLocal && url.port) {
			return `/dev/${url.port}${url.pathname}${url.search}`
		}
		return raw
	} catch {
		return raw
	}
}

export class IframeShapeUtil extends BaseBoxShapeUtil<IframeShape> {
	static override type = 'iframe' as const
	// Keep in sync with server/src/schema.ts
	static override props = {
		w: T.number,
		h: T.number,
		url: T.string,
		title: T.string,
	}

	override getDefaultProps(): IframeShape['props'] {
		return { w: 800, h: 600, url: 'about:blank', title: 'web view' }
	}

	override canEdit() {
		return true
	}
	override hideRotateHandle() {
		return true
	}

	override onResize(shape: IframeShape, info: TLResizeInfo<IframeShape>) {
		return resizeBox(shape, info, { minWidth: 320, minHeight: 200 })
	}

	override component(shape: IframeShape) {
		return <IframeShapeComponent shape={shape} />
	}

	override getIndicatorPath(shape: IframeShape) {
		const path = new Path2D()
		path.rect(0, 0, shape.props.w, shape.props.h)
		return path
	}
}

function IframeShapeComponent({ shape }: { shape: IframeShape }) {
	const editor = useEditor()
	const isEditing = useValue(
		'isEditing',
		() => editor.getEditingShapeId() === shape.id,
		[editor, shape.id]
	)
	const frameRef = useRef<HTMLIFrameElement>(null)
	const { url, title, w, h } = shape.props

	return (
		<HTMLContainer
			style={{
				display: 'flex',
				flexDirection: 'column',
				width: w,
				height: h,
				borderRadius: 4,
				overflow: 'hidden',
				background: '#fff',
				border: isEditing ? `2px solid ${wm.sealBlue}` : `1px solid ${wm.ruleStrong}`,
				boxShadow: wm.shadowPaper,
				pointerEvents: isEditing ? 'all' : 'none',
			}}
		>
			<div
				onPointerDown={isEditing ? stopEventPropagation : undefined}
				style={{
					height: HEADER_HEIGHT,
					flexShrink: 0,
					display: 'flex',
					alignItems: 'center',
					gap: 8,
					padding: '0 10px',
					background: wm.panel,
					color: wm.inkMuted,
					fontFamily: wm.mono,
					fontSize: 10,
					borderBottom: `1px solid ${wm.rule}`,
					userSelect: 'none',
				}}
			>
				<span
					style={{
						color: wm.ink,
						fontWeight: 700,
						textTransform: 'uppercase',
						letterSpacing: 1.5,
						whiteSpace: 'nowrap',
					}}
				>
					{title}
				</span>
				<span style={{ opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
					{url}
				</span>
				<span style={{ marginLeft: 'auto', display: 'flex', gap: 6, pointerEvents: 'all' }}>
					<HeaderButton
						label="↻"
						title="Reload"
						onClick={() => {
							if (frameRef.current) frameRef.current.src = url
						}}
					/>
					<HeaderButton
						label="↗"
						title="Open in new tab"
						onClick={() => window.open(url, '_blank', 'noopener')}
					/>
				</span>
				{!isEditing && <span style={{ opacity: 0.6 }}>double-click to interact</span>}
			</div>
			<iframe
				ref={frameRef}
				src={url}
				title={title}
				style={{ flex: 1, minHeight: 0, border: 'none', width: '100%' }}
				sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
			/>
		</HTMLContainer>
	)
}

function HeaderButton(props: { label: string; title: string; onClick: () => void }) {
	return (
		<button
			title={props.title}
			onPointerDown={stopEventPropagation}
			onClick={props.onClick}
			style={{
				border: 'none',
				background: 'transparent',
				cursor: 'pointer',
				fontSize: 13,
				color: wm.inkMuted,
				padding: '0 2px',
			}}
		>
			{props.label}
		</button>
	)
}
