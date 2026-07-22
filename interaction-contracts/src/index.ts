// Public surface of the pure contracts module. Re-exports the vocabulary and
// aggregates every registered contract into ONE array both runners iterate.
// Registration = adding a declaration to CONTRACTS below (no mutable global —
// the array is the registry). Pilots append their declarations here.
export * from './types.js'
import type { Contract } from './types.js'
import { armedStyleAppliesToCreatedShape } from './contracts/armed-style-applies-to-created-shape.js'
import { bringToFrontPaintsOnTop } from './contracts/bring-to-front-paints-on-top.js'
import { crossWidgetSelection } from './contracts/cross-widget-selection.js'
import { cursorLock } from './contracts/cursor-lock.js'
import { drawCreatesADrawShape } from './contracts/draw-creates-a-draw-shape.js'
import { droppingAnImageCreatesAnImageShape } from './contracts/dropping-an-image-creates-an-image-shape.js'
import { duplicateReidsAndOffsets } from './contracts/duplicate-reids-and-offsets.js'
import { editingIndicator } from './contracts/editing-indicator.js'
import { lineCreatesALineShape } from './contracts/line-creates-a-line-shape.js'
import { malformedClipboardRejected } from './contracts/malformed-clipboard-rejected.js'
import { modalityExclusivity } from './contracts/modality-exclusivity.js'
import { noTransformWhileTyping } from './contracts/no-transform-while-typing.js'
import { pastePlacesAndSelects } from './contracts/paste-places-and-selects.js'
import { scrollDirection } from './contracts/scroll-direction.js'
import { styleAppliesToSelection } from './contracts/style-applies-to-selection.js'

export const CONTRACTS: readonly Contract[] = [
  // Pilot declarations are added here, one per phase (B–F).
  scrollDirection,
  cursorLock,
  crossWidgetSelection,
  modalityExclusivity,
  noTransformWhileTyping,
  editingIndicator,
  styleAppliesToSelection,
  armedStyleAppliesToCreatedShape,
  duplicateReidsAndOffsets,
  pastePlacesAndSelects,
  malformedClipboardRejected,
  bringToFrontPaintsOnTop,
  drawCreatesADrawShape,
  lineCreatesALineShape,
  droppingAnImageCreatesAnImageShape,
]
