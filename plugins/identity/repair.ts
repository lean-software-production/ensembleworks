import type { StarterRecord } from "./attribution.js";

/** Construct a manual lineage repair only when the target is still unidentified. */
export function inheritedStarterRepair(input: {
  targetId: string;
  sourceId: string;
  target: StarterRecord | null;
  source: StarterRecord | null;
  now: number;
}): StarterRecord | null {
  const { targetId, sourceId, target, source, now } = input;
  if (targetId === sourceId || target?.starter || !source?.starter) return null;
  return {
    threadId: targetId,
    starter: source.starter,
    email: source.email,
    via: "agent",
    origin: target?.origin ?? "cli",
    originPluginId: target?.originPluginId ?? null,
    inheritedFrom: sourceId,
    recordedAt: now,
    host: target?.host ?? null,
    ...(source.provenance ? { provenance: source.provenance } : {}),
  };
}
