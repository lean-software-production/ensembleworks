// An arrow drawn on one page must not be drawn on another page. Found on a
// live bb instance (2026-09-14): canvas-react's Arrows overlay drew every arrow
// in the room regardless of page, while ShapeLayer filtered shape bodies.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ARROW_TOOL_SELECTOR = '[data-canvas-tool="arrow"]'
const NEW_PAGE_SELECTOR = '[data-canvas-v2-new-page]'

export const arrowStaysOnItsPage: Contract = {
  name: 'arrow-stays-on-its-page',
  level: 'browser',
  when: 'at-end',
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'element', selector: ARROW_TOOL_SELECTOR } },
    { kind: 'up' },
    { kind: 'down', at: { ref: 'point', x: 480, y: 520 } },
    { kind: 'move', at: { ref: 'point', x: 700, y: 560 }, steps: 8 },
    { kind: 'up' },
    { kind: 'down', at: { ref: 'element', selector: NEW_PAGE_SELECTOR } },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const pages = obs.pageCount()
    if (pages !== 2) return `expected 2 pages after clicking "+ new page", got ${pages}`
    const ids = obs.listShapeIds()
    if (ids.length !== 1) return `expected exactly one drawn arrow in the doc, got listShapeIds() ${JSON.stringify(ids)}`
    const rendered = obs.renderedArrowIds()
    if (rendered.length !== 0) {
      return `expected no arrow drawn on the newly created page, got renderedArrowIds() ${JSON.stringify(rendered)}`
    }
    return null
  },
}
