// The shared canvas session: active tool, tool FSM states, the gesture flag,
// keyboard shortcuts (from the viewport and from anywhere else in the host's
// keyboard scope), clipboard, and the style panel callbacks. Every host mounts
// this once per editor; host-owned concerns (transport, presence, pages,
// embeds) reach it only through the small `CanvasHost` port.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
	applyWheel,
	buildSetStyleIntent,
	cancelActiveTool,
	createInitialToolStates,
	deleteSelectionIntents,
	dispatchToActiveTool,
	duplicateSelectionIntents,
	pasteIntents,
	redoWithRepair,
	reorderSelectionIntents,
	resolveShortcut,
	selectAllIntents,
	shouldFallBackToSelect,
	undoWithRepair,
	type Editor,
	type InputEvent,
	type Intent,
	type KeyInputEvent,
	type ShortcutCommand,
	type StyleAxis,
	type StyleValue,
	type ToolContext,
	type ToolId,
	type ToolSet,
	type ToolStates,
} from '@ensembleworks/canvas-editor'
import { encodeClipboard, serializeSelection } from '@ensembleworks/canvas-model'
import type { CanvasHost } from './host.js'
import { isKeyTargetInScope } from './keyboard-scope.js'
import type { StyleChange } from './style-controls.js'

export interface UseCanvasSessionOptions {
	readonly editor: Editor
	readonly toolContext: ToolContext
	readonly tools: ToolSet
	readonly host: CanvasHost
	/** Keydowns targeting this element's descendants, or the document body,
	 * are canvas shortcuts. The body counts because focus falls back to it when
	 * a text edit ends; without it every shortcut dies until the user clicks. */
	readonly keyboardScopeRef: RefObject<HTMLElement | null>
	/** The element wrapping the Viewport. Keydowns inside it already arrive via
	 * the Viewport's own onKeyDown, so the document listener skips them. */
	readonly viewportContainerRef: RefObject<HTMLElement | null>
}

export interface CanvasSession {
	readonly editor: Editor
	readonly toolContext: ToolContext
	readonly activeToolId: ToolId
	readonly toolStates: ToolStates
	/** True from pointerdown until pointerup or any cancel, so the style panel
	 * hides mid-drag. */
	readonly isGesturing: boolean
	readonly selectTool: (id: ToolId) => void
	/** Abandons the active tool's in-flight gesture (blur, pointercancel,
	 * Escape, tool switch). */
	readonly cancelAndReset: () => void
	/** The Viewport's onInput. Returns true when the keydown's native default
	 * must be suppressed (Enter that began a text edit). */
	readonly handleInput: (event: InputEvent) => boolean | void
	/** Stable write handle for shape bodies and embeds. */
	readonly dispatch: (intents: Intent[]) => void
	readonly onStyleChange: StyleChange
	readonly onArmStyle: StyleChange
}

/** True for a text input, textarea or contentEditable element. Duck-typed on
 * `tagName` rather than `instanceof Element` so it works where only `window`
 * and `document` are installed as globals (happy-dom tests). */
export function isEditableTarget(node: EventTarget | null): boolean {
	const el = node as { tagName?: unknown; isContentEditable?: unknown } | null
	if (!el || typeof el.tagName !== 'string') return false
	return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true
}

/** Keys a focused button activates on. */
function isControlActivationKey(key: string): boolean {
	return key === 'Enter' || key === ' '
}

export function useCanvasSession(options: UseCanvasSessionOptions): CanvasSession {
	const { editor, toolContext, tools, host, keyboardScopeRef, viewportContainerRef } = options

	const [activeToolId, setActiveToolId] = useState<ToolId>('select')
	const activeToolIdRef = useRef(activeToolId)
	activeToolIdRef.current = activeToolId
	const [isGesturing, setIsGesturing] = useState(false)
	const [toolStates, setToolStates] = useState<ToolStates>(() => createInitialToolStates(tools))
	const toolStatesRef = useRef(toolStates)
	toolStatesRef.current = toolStates
	const hostRef = useRef(host)
	hostRef.current = host

	const dispatch = useCallback((intents: Intent[]) => editor.applyAll(intents), [editor])

	const cancelAndReset = useCallback(() => {
		const { states, intents } = cancelActiveTool(tools, toolStatesRef.current, activeToolIdRef.current, editor)
		if (intents.length > 0) editor.applyAll(intents)
		toolStatesRef.current = states
		setToolStates(states)
		// Every abandonment path may never deliver a pointerup.
		setIsGesturing(false)
	}, [editor, tools])

	const selectTool = useCallback(
		(id: ToolId) => {
			cancelAndReset()
			// Only the select tool clears hover, so leaving it would strand a
			// frozen hover ring.
			if (activeToolIdRef.current === 'select' && id !== 'select') editor.apply({ type: 'SetHover', id: null })
			setActiveToolId(id)
		},
		[cancelAndReset, editor],
	)

	const runCommand = useCallback(
		(command: ShortcutCommand): void => {
			const apply = (intents: Intent[]) => {
				if (intents.length > 0) editor.applyAll(intents)
			}
			const clipboardFailed = () => hostRef.current.notify('Clipboard is not available')
			switch (command.type) {
				case 'cancel':
					cancelAndReset()
					selectTool('select')
					return
				case 'endEdit':
					// Pane input routing task (docs/plans/2026-09-15-bb-thread-frame.md's
					// follow-up section) — Escape while editing a region with no DOM
					// surface of its own (a bbthread's thread pane) resolves here
					// instead of 'cancel': it must end ONLY the edit, not also reset
					// the active tool back to 'select' (cancelAndReset()/selectTool()
					// would be redundant — the select tool is already active whenever
					// editingId is set) or abandon an unrelated in-flight gesture.
					apply([{ type: 'EndEdit' }])
					return
				case 'delete':
					apply(deleteSelectionIntents(editor))
					return
				case 'undo':
					undoWithRepair(editor)
					return
				case 'redo':
					redoWithRepair(editor)
					return
				case 'reorder':
					apply(reorderSelectionIntents(editor, command.op))
					return
				case 'selectAll':
					apply(selectAllIntents(editor))
					return
				case 'tool':
					selectTool(command.shortcut.toolId)
					if (command.shortcut.armGeo) apply([{ type: 'SetNextStyle', props: { geo: command.shortcut.armGeo } }])
					return
				case 'clipboard': {
					const selection = [...editor.get().selection]
					if (command.action === 'duplicate') {
						apply(duplicateSelectionIntents(editor))
					} else if (command.action === 'paste') {
						hostRef.current.clipboard.read().then((text) => apply(pasteIntents(editor, text)), clipboardFailed)
					} else if (selection.length > 0) {
						const payload = encodeClipboard(serializeSelection(editor.doc.listShapes(), editor.doc.listBindings(), selection))
						// Cut captures its delete now, from the selection just
						// serialized, and applies it only once the write succeeds: a
						// failed write never loses shapes, and a selection change during
						// the write never deletes something that was not copied.
						const deleteAfter = command.action === 'cut' ? deleteSelectionIntents(editor) : []
						hostRef.current.clipboard.write(payload).then(() => apply(deleteAfter), clipboardFailed)
					}
					return
				}
			}
		},
		[editor, cancelAndReset, selectTool],
	)

	const handleShortcut = useCallback(
		(event: KeyInputEvent): boolean => {
			const command = resolveShortcut(event, editor.get().editingId)
			if (!command) return false
			runCommand(command)
			return true
		},
		[editor, runCommand],
	)

	/** Feeds one event to the active tool. Returns true when it was an Enter
	 * that just began a text edit: that keydown's native default must be
	 * suppressed, or it types a newline into the freshly focused editor. */
	const dispatchToTool = useCallback(
		(event: InputEvent): boolean => {
			const activeBefore = activeToolIdRef.current
			const editingBefore = editor.get().editingId
			const next = dispatchToActiveTool(tools, toolStatesRef.current, activeBefore, editor, event)
			toolStatesRef.current = next
			setToolStates(next)
			const editingAfter = editor.get().editingId
			// A create tool that just began a text edit hands over to select.
			if (shouldFallBackToSelect(activeBefore, editingBefore, editingAfter)) setActiveToolId('select')
			return event.type === 'keydown' && event.key === 'Enter' && editingBefore === null && editingAfter !== null
		},
		[editor, tools],
	)

	const handleInput = useCallback(
		(event: InputEvent): boolean | void => {
			if (event.type === 'pointerdown') setIsGesturing(true)
			if (event.type === 'pointerup') setIsGesturing(false)
			if (event.type === 'pointermove') hostRef.current.onCursorScreen({ x: event.x, y: event.y })
			// Wheel pans/zooms whichever tool is active.
			if (event.type === 'wheel') {
				editor.apply({ type: 'SetCamera', ...applyWheel(editor.get().camera, event) })
				return
			}
			if (event.type === 'keydown' && handleShortcut(event)) return
			// The Viewport preventDefaults on true (an Enter that began an edit).
			return dispatchToTool(event)
		},
		[editor, handleShortcut, dispatchToTool],
	)

	// Whether the user's last pointerdown or focus landed inside the keyboard
	// scope. Body-targeted keydowns count as canvas shortcuts only while it is
	// true (see keyboard-scope.ts). Starts true: the canvas has just mounted,
	// so it is what the user opened, and nothing else has been touched since.
	const lastInteractionInScopeRef = useRef(true)
	useEffect(() => {
		function onInteraction(e: Event): void {
			const scope = keyboardScopeRef.current
			lastInteractionInScopeRef.current = scope !== null && scope.contains(e.target as Node | null)
		}
		document.addEventListener('pointerdown', onInteraction, true)
		document.addEventListener('focusin', onInteraction, true)
		return () => {
			document.removeEventListener('pointerdown', onInteraction, true)
			document.removeEventListener('focusin', onInteraction, true)
		}
	}, [keyboardScopeRef])

	// Keydowns delivered outside the viewport (a focused toolbar button, or the
	// body) never reach the Viewport's own onKeyDown, so a document listener
	// covers them. It skips editable targets, and skips targets inside the
	// viewport container, which the Viewport path already handled.
	useEffect(() => {
		function onKeydown(e: KeyboardEvent): void {
			const container = viewportContainerRef.current
			if (!container) return
			const target = e.target as Node | null
			if (isEditableTarget(target)) return
			const scope = keyboardScopeRef.current
			const body = scope?.ownerDocument.body ?? null
			if (!isKeyTargetInScope(target, scope, body, lastInteractionInScopeRef.current)) return
			const keyEvent: KeyInputEvent = {
				type: 'keydown',
				key: e.key,
				modifiers: { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey },
				t: e.timeStamp,
			}
			const command = resolveShortcut(keyEvent, editor.get().editingId)
			// Native select-all is document-wide, so suppress it for viewport-
			// focused keydowns too (they bubble here before the containment skip).
			if (command?.type === 'selectAll') e.preventDefault()
			if (target && container.contains(target)) return
			// Clipboard keys are suppressed only on this path: cancelling a
			// viewport-focused Ctrl+V keydown would also cancel the native paste
			// event the image-paste listener relies on.
			if (command?.type === 'clipboard') e.preventDefault()
			if (command) {
				runCommand(command)
				return
			}
			// Tool input from a focused chrome control inside the scope (a toolbar
			// button, a page tab): Enter and Space are that control's activation
			// keys, so they must not also reach the tool (Enter would begin
			// editing the selection), and a key the control already handled
			// (defaultPrevented) is its own. Other keys, such as arrow nudge,
			// still reach the tool, as they did from a focused toolbar button.
			if (target !== null && target !== body && (isControlActivationKey(e.key) || e.defaultPrevented)) return
			if (dispatchToTool(keyEvent)) e.preventDefault()
		}
		document.addEventListener('keydown', onKeydown)
		return () => document.removeEventListener('keydown', onKeydown)
	}, [editor, runCommand, dispatchToTool, keyboardScopeRef, viewportContainerRef])

	const onStyleChange = useCallback<StyleChange>(
		(axis: StyleAxis, value: StyleValue, opts) => {
			const ids = Array.from(editor.get().selection)
			if (ids.length === 0) return
			const intents: Intent[] = [buildSetStyleIntent(ids, axis, value)]
			// Style memory: a plain style click also arms the next shape's style;
			// Ctrl/Cmd (onlySelection) restyles the selection only.
			if (!opts?.onlySelection) intents.push({ type: 'SetNextStyle', props: { [axis]: value } })
			dispatch(intents)
		},
		[editor, dispatch],
	)

	const onArmStyle = useCallback<StyleChange>(
		(axis: StyleAxis, value: StyleValue) => dispatch([{ type: 'SetNextStyle', props: { [axis]: value } }]),
		[dispatch],
	)

	return { editor, toolContext, activeToolId, toolStates, isGesturing, selectTool, cancelAndReset, handleInput, dispatch, onStyleChange, onArmStyle }
}
