// The single decision "what does this keydown mean for the canvas?", shared by
// every host. Order matters and matches the web app's original handler:
// cancel, delete, undo, redo, clipboard, z-order, select-all, tool letters.
// Every branch is silent while a shape is being text-edited — the text editor
// owns the keyboard then.
import type { KeyInputEvent } from '../input.js'
import type { ReorderOp } from '../reorder-intents.js'
import { clipboardShortcut, type ClipboardAction } from './clipboard-shortcut.js'
import { reorderShortcut } from './reorder-shortcut.js'
import { toolShortcut, type ToolShortcut } from './tool-shortcut.js'

export type ShortcutCommand =
  | { readonly type: 'cancel' }
  | { readonly type: 'delete' }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }
  | { readonly type: 'clipboard'; readonly action: ClipboardAction }
  | { readonly type: 'reorder'; readonly op: ReorderOp }
  | { readonly type: 'selectAll' }
  | { readonly type: 'tool'; readonly shortcut: ToolShortcut }

export function resolveShortcut(event: KeyInputEvent, editingId: string | null): ShortcutCommand | null {
  if (editingId !== null) return null
  if (event.key === 'Escape') return { type: 'cancel' }
  if (event.key === 'Delete' || event.key === 'Backspace') return { type: 'delete' }
  const key = event.key.toLowerCase()
  const withModifier = event.modifiers.ctrl || event.modifiers.meta
  if (withModifier && key === 'z' && !event.modifiers.shift) return { type: 'undo' }
  if ((withModifier && key === 'z' && event.modifiers.shift) || (event.modifiers.ctrl && key === 'y')) return { type: 'redo' }
  const clip = clipboardShortcut(event, editingId)
  if (clip) return { type: 'clipboard', action: clip.action }
  const reorder = reorderShortcut(event, editingId)
  if (reorder) return { type: 'reorder', op: reorder.op }
  if (withModifier && key === 'a') return { type: 'selectAll' }
  const tool = toolShortcut(event, editingId)
  if (tool) return { type: 'tool', shortcut: tool }
  return null
}
