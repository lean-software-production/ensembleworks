import { serializeSelection, type Shape } from '@ensembleworks/canvas-model'
import type { Editor } from './editor.js'
import type { Intent } from './intents.js'

function subtrees(shapes: readonly Shape[]) {
  const byId = new Map<string, Shape>(shapes.map(s => [s.id, s]))
  const byParent = new Map<string, Shape[]>()
  for (const shape of shapes) {
    const children = byParent.get(shape.parentId) ?? []
    children.push(shape)
    byParent.set(shape.parentId, children)
  }
  return (rootId: string): Shape[] => {
    const root = byId.get(rootId)
    const found = root ? [root] : []
    const seen = new Set(found.map(s => s.id))
    for (let i = 0; i < found.length; i++) {
      for (const child of byParent.get(found[i]!.id) ?? []) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        found.push(child)
      }
    }
    return found
  }
}

/** Cut may remove only restorable content. Release N excludes artifacts from
 * clipboard serialization: keep a selected artifact-containing subtree whole,
 * including its frame, while cutting unrelated selected roots normally.
 * No reparenting or cloning of preserved history. */
export function prepareCut(editor: Editor) {
  const shapes = editor.doc.listShapes()
  const byId = new Map<string, Shape>(shapes.map(s => [s.id, s]))
  const tree = subtrees(shapes)
  const selection = new Set(editor.get().selection)
  const roots = [...selection].filter(id => {
    const seen = new Set([id])
    let parent = byId.get(id)?.parentId
    while (parent && !seen.has(parent)) {
      if (selection.has(parent)) return false
      seen.add(parent)
      parent = byId.get(parent)?.parentId
    }
    return true
  }).filter(id => tree(id).every(s => s.kind !== 'artifact'))
  const payload = serializeSelection(shapes, editor.doc.listBindings(), roots)
  const copied = new Map(payload.shapes.map(s => [s.id, JSON.stringify(s)]))

  return {
    payload,
    /** Evaluate after the async write succeeds. A new/changed descendant or
     * artifact arriving during the write must not be cascade-deleted. Never
     * consult a later selection to choose what gets deleted. */
    deleteIntents(): Intent[] {
      const currentTree = subtrees(editor.doc.listShapes())
      const removed = new Set<string>()
      const ids = roots.filter(id => {
        const tree = currentTree(id)
        if (tree.length === 0 || !tree.every(s => s.kind !== 'artifact' && copied.get(s.id) === JSON.stringify(s))) return false
        for (const s of tree) removed.add(s.id)
        return true
      })
      if (ids.length === 0) return []
      return [
        { type: 'DeleteShapes', ids },
        { type: 'SetSelection', ids: [...editor.get().selection].filter(id => !removed.has(id)) },
      ]
    },
  }
}
