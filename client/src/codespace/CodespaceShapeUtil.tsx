/**
 * A Codespace as a tldraw container shape (EW Codespaces coexistence spec §5).
 *
 * - Synced props are IDENTITY ONLY (gatewayId/repo/branch — decision log SP3
 *   item 2). Everything live — status dot, owner, input policy — comes from
 *   the shared gatewayPoller (~5s poll of GET /api/terminal/list) and is
 *   rendered locally, never written to the store.
 * - It is a container: child terminals are the EXISTING terminal shape,
 *   created with parentId = this shape (children transform with the parent
 *   natively — seedSessionCanvas.ts frame precedent) and
 *   props.gateway = gatewayId, so the existing client fork routes them to
 *   the relay with no new code path.
 * - The lock toggle POSTs /api/terminal/input-policy. It is VISIBLE to all
 *   and actionable only by the owner — the server 403s everyone else and the
 *   next poll re-asserts truth; the badge is decoration, never enforcement.
 * - Lifecycle stays in the CLI for v1: no stop/rebuild controls (spec §5).
 */
import { codespaceShapeProps } from '@ensembleworks/contracts'
import { useEffect, useState } from 'react'
import {
	BaseBoxShapeUtil,
	HTMLContainer,
	TLBaseShape,
	TLResizeInfo,
	createShapeId,
	resizeBox,
	useEditor,
} from 'tldraw'
import { wm } from '../theme'
import { gatewayPoller } from './gatewayPoll'
import { codespaceViewFor, type CodespaceView } from './gatewayView'

export interface CodespaceShapeProps {
	w: number
	h: number
	gatewayId: string
	repo: string
	branch: string
}

// Register the shape in tldraw's global shape union (tldraw v5 pattern), so
// editor.createShape({ type: 'codespace', ... }) is fully typed.
declare module '@tldraw/tlschema' {
	interface TLGlobalShapePropsMap {
		codespace: CodespaceShapeProps
	}
}

export type CodespaceShape = TLBaseShape<'codespace', CodespaceShapeProps>

const MIN_W = 480
const MIN_H = 320
const HEADER_H = 40

export class CodespaceShapeUtil extends BaseBoxShapeUtil<CodespaceShape> {
	static override type = 'codespace' as const
	static override props = codespaceShapeProps

	override getDefaultProps(): CodespaceShape['props'] {
		return { w: 960, h: 600, gatewayId: '', repo: '', branch: '' }
	}

	override hideRotateHandle() {
		return true
	}
	override canEdit() {
		return false
	}

	override onResize(shape: CodespaceShape, info: TLResizeInfo<CodespaceShape>) {
		return resizeBox(shape, info, { minWidth: MIN_W, minHeight: MIN_H })
	}

	override component(shape: CodespaceShape) {
		return <CodespaceShapeComponent shape={shape} />
	}

	override getIndicatorPath(shape: CodespaceShape) {
		const path = new Path2D()
		path.rect(0, 0, shape.props.w, shape.props.h)
		return path
	}
}

function CodespaceShapeComponent({ shape }: { shape: CodespaceShape }) {
	const editor = useEditor()
	const [view, setView] = useState<CodespaceView>(() =>
		codespaceViewFor(null, shape.props.gatewayId)
	)
	useEffect(
		() =>
			gatewayPoller.subscribe((list) =>
				setView(codespaceViewFor(list, shape.props.gatewayId))
			),
		[shape.props.gatewayId]
	)

	const locked = view.inputPolicy === 'locked'
	const dotColor =
		view.status === 'connected' ? '#2e7d32' : view.status === 'offline' ? '#c62828' : '#9e9e9e'
	// Display 'sso:alice@acme.dev' as 'alice@acme.dev' (prefix is an authz
	// namespace, not a name).
	const ownerLabel = view.owner ? view.owner.replace(/^(sso|token):/, '') : null

	const addTerminal = () => {
		// Stack new children with a small cascade; child x/y are PARENT-relative.
		const childCount = editor.getSortedChildIdsForParent(shape.id).length
		const sessionId = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`
		const id = createShapeId()
		editor.createShape({
			id,
			type: 'terminal',
			parentId: shape.id,
			x: 24 + childCount * 32,
			y: HEADER_H + 24 + childCount * 32,
			props: {
				w: 720,
				h: 440,
				sessionId,
				title: `${shape.props.repo.split('/').pop() || 'codespace'} terminal`,
				gateway: shape.props.gatewayId,
			},
		})
		editor.setSelectedShapes([id])
	}

	const togglePolicy = () => {
		// Optimism-free: POST, then re-poll. Non-owners get a server 403 and the
		// poll simply re-asserts the current truth (server is the authority).
		void fetch('/api/terminal/input-policy', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				gatewayId: shape.props.gatewayId,
				policy: locked ? 'shared' : 'locked',
			}),
		})
			.catch(() => {})
			.then(() => gatewayPoller.refresh())
	}

	const { w, h } = shape.props
	return (
		<HTMLContainer
			style={{
				width: w,
				height: h,
				position: 'relative',
				// The body is inert: pointer events fall through to tldraw so the
				// container selects/drags/resizes like any shape; only the header's
				// controls take the pointer.
				pointerEvents: 'none',
			}}
		>
			<div
				style={{
					position: 'absolute',
					inset: 0,
					borderRadius: 6,
					border: `1.5px solid ${wm.ink}`,
					background: 'rgba(249,250,251,0.6)',
					boxShadow: wm.shadowPaper,
				}}
			/>
			{/* Header: repo@branch · status dot · owner · lock toggle · + terminal */}
			<div
				onPointerDown={(e) => e.stopPropagation()}
				style={{
					position: 'absolute',
					top: 0,
					left: 0,
					right: 0,
					height: HEADER_H,
					display: 'flex',
					alignItems: 'center',
					gap: 10,
					padding: '0 12px',
					borderBottom: `1px solid ${wm.ink}`,
					background: '#f9fafb',
					borderRadius: '6px 6px 0 0',
					fontFamily: wm.mono,
					fontSize: 12,
					color: wm.sealBlue,
					pointerEvents: 'all',
				}}
			>
				<span
					title={`gateway ${shape.props.gatewayId}: ${view.status}`}
					style={{
						width: 9,
						height: 9,
						borderRadius: '50%',
						background: dotColor,
						flex: '0 0 auto',
					}}
				/>
				<span
					style={{
						fontWeight: 700,
						textTransform: 'none',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						whiteSpace: 'pre',
					}}
				>
					{shape.props.repo}
					{shape.props.branch ? `@${shape.props.branch}` : ''}
				</span>
				{ownerLabel && (
					<span style={{ color: wm.inkMuted, overflow: 'hidden', textOverflow: 'ellipsis' }}>
						{ownerLabel}
					</span>
				)}
				<span style={{ flex: 1 }} />
				<button
					type="button"
					onClick={togglePolicy}
					title={
						view.viewerIsOwner
							? locked
								? 'Input locked to you — click to share the keyboard'
								: 'Input shared — click to lock to you'
							: locked
								? 'Input locked to the owner (read-only for you)'
								: 'Input shared'
					}
					style={{
						font: 'inherit',
						border: `1px solid ${wm.ink}`,
						borderRadius: 4,
						padding: '2px 8px',
						background: locked ? '#fff' : '#e8f5e9',
						cursor: view.viewerIsOwner ? 'pointer' : 'default',
						color: 'inherit',
					}}
				>
					{locked ? '🔒 locked' : '🔓 shared'}
				</button>
				<button
					type="button"
					onClick={addTerminal}
					title="New terminal in this codespace"
					style={{
						font: 'inherit',
						border: `1px solid ${wm.ink}`,
						borderRadius: 4,
						padding: '2px 8px',
						background: '#fff',
						cursor: 'pointer',
						color: 'inherit',
					}}
				>
					+ terminal
				</button>
			</div>
		</HTMLContainer>
	)
}
