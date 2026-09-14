// Public surface of the pure contracts module. Re-exports the vocabulary and
// aggregates every registered contract into ONE array both runners iterate.
// Registration = adding a declaration to CONTRACTS below (no mutable global —
// the array is the registry). Pilots append their declarations here.
export * from './types.js'
import type { Contract } from './types.js'
import { armedStyleAppliesToCreatedShape } from './contracts/armed-style-applies-to-created-shape.js'
import { arrowBindsToTargetShape } from './contracts/arrow-binds-to-target-shape.js'
import { arrowNudgeMovesSelection } from './contracts/arrow-nudge-moves-selection.js'
import { bringToFrontPaintsOnTop } from './contracts/bring-to-front-paints-on-top.js'
import { crossWidgetSelection } from './contracts/cross-widget-selection.js'
import { cursorLock } from './contracts/cursor-lock.js'
import { drawCreatesADrawShape } from './contracts/draw-creates-a-draw-shape.js'
import { droppingAnImageCreatesAnImageShape } from './contracts/dropping-an-image-creates-an-image-shape.js'
import { duplicateReidsAndOffsets } from './contracts/duplicate-reids-and-offsets.js'
import { editingIndicator } from './contracts/editing-indicator.js'
import { enterKeyEditPreservesText } from './contracts/enter-key-edit-preserves-text.js'
import { enterKeyEditsSelection } from './contracts/enter-key-edits-selection.js'
import { frameHeaderDoubleClickRenames } from './contracts/frame-header-double-click-renames.js'
import { frameInteriorIsHollow } from './contracts/frame-interior-is-hollow.js'
import { lineCreatesALineShape } from './contracts/line-creates-a-line-shape.js'
import { malformedClipboardRejected } from './contracts/malformed-clipboard-rejected.js'
import { modalityExclusivity } from './contracts/modality-exclusivity.js'
import { noTransformWhileTyping } from './contracts/no-transform-while-typing.js'
import { noteCreateBeginsEditing } from './contracts/note-create-begins-editing.js'
import { noteResizeHandlesSuppressed } from './contracts/note-resize-handles-suppressed.js'
import { pastePlacesAndSelects } from './contracts/paste-places-and-selects.js'
import { scrollDirection } from './contracts/scroll-direction.js'
import { selectAllSelectsEveryShapeOnPage } from './contracts/select-all-selects-every-shape-on-page.js'
import { shapeGrowsToFitTypedText } from './contracts/shape-grows-to-fit-typed-text.js'
import { shiftDragConstrainsToAxis } from './contracts/shift-drag-constrains-to-axis.js'
import { styleAppliesToSelection } from './contracts/style-applies-to-selection.js'
import { styleEditArmsNextShape } from './contracts/style-edit-arms-next-shape.js'
import { switchingPageChangesRenderedShapes } from './contracts/switching-page-changes-rendered-shapes.js'
import { toolShortcutSwitchesAndArmsTool } from './contracts/tool-shortcut-switches-and-arms-tool.js'

export const CONTRACTS: readonly Contract[] = [
  // Pilot declarations are added here, one per phase (B–F).
  scrollDirection,
  cursorLock,
  crossWidgetSelection,
  modalityExclusivity,
  noTransformWhileTyping,
  noteResizeHandlesSuppressed,
  editingIndicator,
  styleAppliesToSelection,
  armedStyleAppliesToCreatedShape,
  styleEditArmsNextShape,
  duplicateReidsAndOffsets,
  pastePlacesAndSelects,
  malformedClipboardRejected,
  bringToFrontPaintsOnTop,
  drawCreatesADrawShape,
  lineCreatesALineShape,
  droppingAnImageCreatesAnImageShape,
  switchingPageChangesRenderedShapes,
  enterKeyEditsSelection,
  noteCreateBeginsEditing,
  enterKeyEditPreservesText,
  arrowBindsToTargetShape,
  frameInteriorIsHollow,
  frameHeaderDoubleClickRenames,
  arrowNudgeMovesSelection,
  shiftDragConstrainsToAxis,
  toolShortcutSwitchesAndArmsTool,
  selectAllSelectsEveryShapeOnPage,
  shapeGrowsToFitTypedText,
]
