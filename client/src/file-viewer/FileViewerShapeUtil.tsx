/**
 * A file from the agent home, rendered as a sandboxed iframe portal — for
 * HTML reports, rendered markdown, and other static output an agent wants to
 * put on the canvas (see server/src/features/files.ts and
 * server/src/files-render.ts for the /files/* proxy this points at).
 *
 * Position/size and the current `rev` are shared via tldraw sync; the
 * iframe's *content* (scroll position, in-page state) is per-user. The
 * refresh button bumps `rev`, which every client applies via sync — so
 * "refresh" is a room-wide reload, not a local one (unlike the iframe
 * shape's dev-server reload, which only resets the local <iframe>.src).
 * Double-click to interact; click away to go back to canvas navigation.
 */
import { fileViewerShapeProps } from '@ensembleworks/contracts'
import {
	BaseBoxShapeUtil,
	HTMLContainer,
	TLBaseShape,
	TLResizeInfo,
	resizeBox,
	stopEventPropagation,
	useEditor,
	useValue,
} from 'tldraw'
import { wm } from '../theme'

export interface FileViewerShapeProps {
	w: number
	h: number
	// Path relative to the agent user's home, e.g. "my-repo/docs/report.html".
	path: string
	title: string
	// Bumped by POST /api/canvas/file-viewer refresh so every client reloads.
	rev?: number
	// Remote gateway id (future); optional so existing rooms need no migration.
	gateway?: string
}

declare module '@tldraw/tlschema' {
	interface TLGlobalShapePropsMap {
		'file-viewer': FileViewerShapeProps
	}
}

export type FileViewerShape = TLBaseShape<'file-viewer', FileViewerShapeProps>

const HEADER_HEIGHT = 28

export class FileViewerShapeUtil extends BaseBoxShapeUtil<FileViewerShape> {
	static override type = 'file-viewer' as const
	static override props = fileViewerShapeProps

	override getDefaultProps(): FileViewerShape['props'] {
		return { w: 720, h: 540, path: '', title: '', rev: 0 }
	}

	override canEdit() {
		return true
	}
	override hideRotateHandle() {
		return true
	}

	override onResize(shape: FileViewerShape, info: TLResizeInfo<FileViewerShape>) {
		return resizeBox(shape, info, { minWidth: 320, minHeight: 200 })
	}

	override component(shape: FileViewerShape) {
		return <FileViewerShapeComponent shape={shape} />
	}

	override getIndicatorPath(shape: FileViewerShape) {
		const path = new Path2D()
		path.rect(0, 0, shape.props.w, shape.props.h)
		return path
	}
}

function FileViewerShapeComponent({ shape }: { shape: FileViewerShape }) {
	const editor = useEditor()
	const isEditing = useValue(
		'isEditing',
		() => editor.getEditingShapeId() === shape.id,
		[editor, shape.id]
	)
	const { path, w, h, rev } = shape.props
	const displayTitle = shape.props.title || path || 'file viewer'

	const refresh = () => {
		editor.updateShape({
			id: shape.id,
			type: 'file-viewer',
			props: { rev: (shape.props.rev ?? 0) + 1 },
		})
	}

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
						overflow: 'hidden',
						textOverflow: 'ellipsis',
					}}
				>
					{displayTitle}
				</span>
				<span style={{ opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
					{path}
				</span>
				<span style={{ marginLeft: 'auto', display: 'flex', gap: 6, pointerEvents: 'all' }}>
					<HeaderButton label="↻" title="Refresh (reloads for everyone)" onClick={refresh} />
					{/* v1 placeholder — Task 7 wires actual scroll-follow presenting. */}
					<HeaderButton
						label="▶"
						title="coming in this build: scroll-follow"
						onClick={() => {}}
						disabled
					/>
				</span>
				{!isEditing && <span style={{ opacity: 0.6 }}>double-click to interact</span>}
			</div>
			{path ? (
				<iframe
					// Per-segment encode so exotic names (#, ?, %) round-trip the
					// route's decode-once contract (features/files.ts re-encodes the
					// decoded express param the same way before hitting the file-server).
					src={`/files/${path.split('/').map(encodeURIComponent).join('/')}?rev=${rev ?? 0}`}
					title={displayTitle}
					style={{ flex: 1, minHeight: 0, border: 'none', width: '100%', pointerEvents: isEditing ? 'all' : 'none' }}
					// SECURITY: no `allow-same-origin`, ever. Without it the iframe's
					// document loads into an opaque (null) origin, so file-server
					// content can never read the canvas's cookies/localStorage or reach
					// the credentialed /api endpoints under the app's own origin — even
					// though it shares allow-scripts. Adding allow-same-origin back
					// would let an agent-authored file impersonate the signed-in user.
					sandbox="allow-scripts allow-forms allow-downloads"
				/>
			) : (
				<div
					style={{
						flex: 1,
						minHeight: 0,
						display: 'grid',
						placeItems: 'center',
						color: wm.inkSubtle,
						fontFamily: wm.mono,
						fontSize: 11,
					}}
				>
					no file
				</div>
			)}
		</HTMLContainer>
	)
}

function HeaderButton(props: { label: string; title: string; onClick: () => void; disabled?: boolean }) {
	return (
		<button
			title={props.title}
			disabled={props.disabled}
			onPointerDown={stopEventPropagation}
			onClick={props.onClick}
			style={{
				border: 'none',
				background: 'transparent',
				cursor: props.disabled ? 'not-allowed' : 'pointer',
				fontSize: 13,
				color: props.disabled ? wm.inkSubtle : wm.inkMuted,
				opacity: props.disabled ? 0.5 : 1,
				padding: '0 2px',
			}}
		>
			{props.label}
		</button>
	)
}
