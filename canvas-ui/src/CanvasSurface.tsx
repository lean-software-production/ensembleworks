// The canvas viewport every host renders: grid, shape bodies, text/frame-name
// editors, the selection overlay and the contextual style panel, all driven by
// one `CanvasSession`. Hosts add their own world content and screen overlays
// through the two slots.
import { useCallback, type ReactNode } from 'react'
import type { EditorState } from '@ensembleworks/canvas-editor'
import { currentSnapResult } from '@ensembleworks/canvas-editor'
import type { CanvasDocument } from '@ensembleworks/canvas-model'
import { FrameNameEditor, Grid, Overlay, ShapeLayer, TextEditor, Viewport, WorldLayer, type ViewportSize } from '@ensembleworks/canvas-react'
import type { CanvasSession } from './use-canvas-session.js'
import { StylePanel } from './StylePanel.js'

export interface CanvasSurfaceProps {
	readonly session: CanvasSession
	readonly editorState: EditorState
	readonly snapshot: CanvasDocument
	readonly viewportSize: ViewportSize
	/** Rendered inside the world layer after shape bodies (e.g. the web app's embeds). */
	readonly worldLayers?: ReactNode
	/** Rendered in screen space after the selection overlay, before the style panel
	 * (e.g. collaborator cursors, editing indicators). */
	readonly overlays?: ReactNode
}

export function CanvasSurface({ session, editorState, snapshot, viewportSize, worldLayers, overlays }: CanvasSurfaceProps) {
	const { editor, toolContext } = session
	const onTextChange = useCallback((id: string, text: string) => editor.apply({ type: 'SetText', id, text }), [editor])
	const onEndEdit = useCallback(() => editor.apply({ type: 'EndEdit' }), [editor])
	const onAutosize = useCallback((id: string, props: Record<string, unknown>) => editor.apply({ type: 'UpdateProps', id, props }), [editor])
	const onNameChange = useCallback((id: string, name: string) => editor.apply({ type: 'UpdateProps', id, props: { name } }), [editor])

	return (
		<Viewport onInput={session.handleInput} onViewportBlur={session.cancelAndReset} onPointerCancel={session.cancelAndReset} style={{ position: 'absolute', inset: 0 }}>
			<Grid camera={editorState.camera} />
			<WorldLayer camera={editorState.camera}>
				<ShapeLayer toolContext={toolContext} camera={editorState.camera} viewportSize={viewportSize} dispatch={session.dispatch} />
				{worldLayers}
				<TextEditor toolContext={toolContext} onTextChange={onTextChange} onEndEdit={onEndEdit} onAutosize={onAutosize} />
				<FrameNameEditor toolContext={toolContext} onNameChange={onNameChange} onEndEdit={onEndEdit} />
			</WorldLayer>
			<Overlay
				editorState={editorState}
				snapshot={snapshot}
				camera={editorState.camera}
				viewportSize={viewportSize}
				index={toolContext.index()}
				snapResult={currentSnapResult(session.toolStates, session.activeToolId)}
			/>
			{/* Later siblings paint over earlier ones: host overlays sit above the
			    selection overlay and below the style panel. */}
			{overlays}
			<StylePanel
				selection={editorState.selection}
				snapshot={snapshot}
				camera={editorState.camera}
				viewportSize={viewportSize}
				isGesturing={session.isGesturing}
				activeToolId={session.activeToolId}
				nextShapeStyle={editorState.nextShapeStyle}
				onStyleChange={session.onStyleChange}
				onArmStyle={session.onArmStyle}
				openSlot={null}
				onOpenSlotChange={() => {}}
			/>
		</Viewport>
	)
}
