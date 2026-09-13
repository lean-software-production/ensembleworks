/**
 * A single leading "[K] ", "K) " or "K - " accelerator prefix on an edge
 * label, K being one non-space character. Shared by `handlers/human.ts`
 * (building a human gate's option list) and `ui/active-runs-banner.tsx`
 * (deriving the same options straight from a `GraphView`'s edges, since the
 * banner has no server-side `HumanGateOption[]` to read) — both need the
 * *parsed* key, not just the stripped display text, which is why this is a
 * separate small module rather than reusing `engine/router.ts`'s own
 * accelerator-stripping regex (that one only strips, for comparing a
 * `preferred_label` to an edge label, and deliberately stays independent of
 * this module — see its own comment).
 */

const ACCELERATOR_RE = /^(?:\[([^\]]*)\]|(\S)\)|(\S)\s-)\s*/;

export function parseAcceleratorLabel(label: string): { key: string | null; text: string } {
  const match = ACCELERATOR_RE.exec(label);
  if (!match) return { key: null, text: label };
  const key = match[1] ?? match[2] ?? match[3] ?? null;
  return { key, text: label.slice(match[0].length) };
}
