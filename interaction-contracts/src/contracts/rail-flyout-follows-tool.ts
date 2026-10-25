// The armed next-shape style flyout follows the active rail tool: switching
// from one style-bearing tool to another moves the single flyout to the new
// tool's button rather than leaving it on (or duplicating it beside) the old.
//
// Browser-only: the rail and its flyout are rendered chrome.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const NOTE_TOOL = '[data-canvas-tool="note"]'
const GEO_TOOL = '[data-canvas-tool="geo"]'

export const railFlyoutFollowsTool: Contract = {
  name: 'rail-flyout-follows-tool',
  level: 'browser',
  tool: 'select',
  when: 'at-end',
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'element', selector: NOTE_TOOL } },
    { kind: 'up' },
    { kind: 'down', at: { ref: 'element', selector: GEO_TOOL } },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const tools = obs.armedFlyoutTools()
    if (tools.length !== 1 || tools[0] !== 'geo') {
      return `expected exactly one armed flyout, attached to the geo tool, got ${JSON.stringify(tools)}`
    }
    return null
  },
}
