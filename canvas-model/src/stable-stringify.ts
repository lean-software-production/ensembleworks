/**
 * Deterministic, key-order-INSENSITIVE serialization: object keys are sorted
 * recursively; arrays keep their order (element order is data — richText
 * content, line points, …); undefined-valued keys are skipped (JSON
 * semantics). Lives in its own module because BOTH repair.ts (the dedupe
 * winner rule) and document.ts (makeDocument's byId winner under duplicate
 * ids) need it, and repair.ts already imports document.ts — a re-export from
 * repair.ts keeps the public surface there.
 *
 * This is the dedupe winner rule's foundation: the winner among duplicate
 * shape entries is the entry with the SMALLEST stableStringify — a pure
 * function of CONTENT, so canvas-doc's repair() and applyRepairToModel
 * independently compute the identical winner on every peer. Two candidate
 * tiebreaks are deliberately FORBIDDEN:
 * - plain JSON.stringify: Loro reorders map keys, so the same shape can
 *   serialize differently on two converged peers (that lesson already cost
 *   one bug — the order-independent shape comparison fix in ShadowMirror).
 * - traversal/array order: probe-proven unstable across peers — the E1
 *   convergence rig caught two converged peers (identical versionBytes)
 *   returning the same duplicate multiset in OPPOSITE orders.
 * Exact content ties: either entry wins — the model result is identical by
 * definition. (The engine layer additionally needs a consistent PHYSICAL
 * choice for ties; LoroCanvasDoc's dedupe breaks them by TreeID, which
 * converged peers share.)
 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return '[' + v.map((x) => stableStringify(x)).join(',') + ']'
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}'
}
