// Public surface of the pure contracts module. Re-exports the vocabulary and
// aggregates every registered contract into ONE array both runners iterate.
// Registration = adding a declaration to CONTRACTS below (no mutable global —
// the array is the registry). Pilots append their declarations here.
export * from './types.js'
import type { Contract } from './types.js'

export const CONTRACTS: readonly Contract[] = [
  // Pilot declarations are added here, one per phase (B–F).
]
