/**
 * The pure key -> tool-switch DECISION (Task keyboard/K3) -- tldraw's
 * single-key tool shortcuts (useTools.tsx: v/h/n/t/r/o/a/f/d/l), reduced to
 * the ToolId set v2 actually ships (no eraser/laser/text-alias tools --
 * tool-loop.ts's `ToolId` union is the exhaustive v2 list). DOM-free and
 * unit-testable, mirroring clipboard-dom.ts/reorder-dom.ts:
 * CanvasV2App.tsx's `handleGlobalShortcut` is the only caller, and composes
 * the result (selectTool(hit.toolId), plus a SetNextStyle({geo: armGeo})
 * dispatch when armGeo is set -- the same armed-style path StylePanel's
 * AS3 mode already uses).
 *
 * ONE canonical list (TOOL_SHORTCUTS) is the single source of truth for
 * BOTH the key->action decision (toolShortcut) and the toolbar's tooltip
 * label (TOOL_SHORTCUT_LABEL, derived below) -- so a future added/changed
 * binding can't drift between "what the key does" and "what the tooltip
 * claims it does".
 */
import type { KeyInputEvent } from '@ensembleworks/canvas-editor'
import type { ToolId } from './tool-loop.js'

export interface ToolShortcut {
	readonly toolId: ToolId
	/** Set only for the geo tool's two variant-arming letters ('r'/'o') --
	 * see the module header. A plain string (not canvas-model's GEO enum
	 * type): this module stays dependency-free like reorder-dom.ts, and the
	 * caller's SetNextStyle intent takes `Record<string, unknown>` anyway. */
	readonly armGeo?: string
}

// tldraw source (node_modules/tldraw/src/lib/ui/hooks/useTools.tsx), narrowed
// to the ToolId set v2 ships (tool-loop.ts's ToolId union has no
// eraser/laser -- those tldraw tools have no v2 equivalent, so 'e'/'k' are
// deliberately unmapped). 'r'/'o' both select the SAME v2 tool ('geo' -- v2
// has no separate rectangle/ellipse toolbar buttons) but arm DIFFERENT geo
// variants, matching useTools.tsx's `onSelect` for each (which calls BOTH
// `setStyleForNextShapes(GeoShapeGeoStyle, geo)` and `setCurrentTool('geo')`).
const TOOL_SHORTCUTS: readonly { readonly key: string; readonly shortcut: ToolShortcut }[] = [
	{ key: 'v', shortcut: { toolId: 'select' } },
	{ key: 'h', shortcut: { toolId: 'hand' } },
	{ key: 'n', shortcut: { toolId: 'note' } },
	{ key: 't', shortcut: { toolId: 'text' } },
	{ key: 'r', shortcut: { toolId: 'geo', armGeo: 'rectangle' } },
	{ key: 'o', shortcut: { toolId: 'geo', armGeo: 'ellipse' } },
	{ key: 'a', shortcut: { toolId: 'arrow' } },
	{ key: 'f', shortcut: { toolId: 'frame' } },
	{ key: 'd', shortcut: { toolId: 'draw' } },
	{ key: 'l', shortcut: { toolId: 'line' } },
]

/**
 * Pure decision: does this keydown mean a tool-switch shortcut, and which
 * tool (+ optional armed geo variant)? Gated on `editingId === null` exactly
 * like Escape/Delete/undo/clipboard/reorder in CanvasV2App.tsx's
 * `handleGlobalShortcut` -- every one of these letters is an ordinary
 * typeable character, so while a shape is being text-edited the
 * TextEditor's own textarea must receive them unmolested. Also suppressed
 * whenever Ctrl/Cmd/Alt is held: bare letters are the tldraw-parity tool
 * shortcuts, but the SAME letters double as modified shortcuts elsewhere
 * (Ctrl+A select-all, Ctrl+D duplicate) -- requiring NO modifier here is
 * what keeps the two families from colliding. `event.key.toLowerCase()`
 * (same reasoning as the undo/redo z-branch): Shift+R still picks the
 * rectangle tool, matching tldraw's own un-shifted `kbd` bindings.
 */
export function toolShortcut(event: KeyInputEvent, editingId: string | null): ToolShortcut | null {
	if (editingId !== null) return null
	if (event.modifiers.ctrl || event.modifiers.meta || event.modifiers.alt) return null
	const key = event.key.toLowerCase()
	const found = TOOL_SHORTCUTS.find((t) => t.key === key)
	return found ? found.shortcut : null
}

/** One displayable key per ToolId, for the toolbar's tooltip (`title`
 * attribute) -- the FIRST-registered TOOL_SHORTCUTS entry for a given
 * toolId wins (geo's two entries, 'r' and 'o', both map to the SAME toolId;
 * 'r' is listed first above, so it is geo's displayed label). Derived from
 * TOOL_SHORTCUTS, never hand-duplicated, so the tooltip can't drift from
 * the actual key->tool mapping. */
export const TOOL_SHORTCUT_LABEL: Partial<Record<ToolId, string>> = (() => {
	const map: Partial<Record<ToolId, string>> = {}
	for (const { key, shortcut } of TOOL_SHORTCUTS) {
		if (!(shortcut.toolId in map)) map[shortcut.toolId] = key.toUpperCase()
	}
	return map
})()
