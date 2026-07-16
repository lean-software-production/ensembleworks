// Public surface of the pure contracts module. Re-exports the vocabulary and
// aggregates every registered contract into ONE array both runners iterate.
// Registration = adding a declaration to CONTRACTS below (no mutable global —
// the array is the registry). Pilots append their declarations here.
export * from './types.js'
import type { Contract } from './types.js'
import { crossWidgetSelection } from './contracts/cross-widget-selection.js'
import { cursorLock } from './contracts/cursor-lock.js'
import { scrollDirection } from './contracts/scroll-direction.js'

export const CONTRACTS: readonly Contract[] = [
  // Pilot declarations are added here, one per phase (B–F).
  scrollDirection,
  cursorLock,
  crossWidgetSelection,
]
