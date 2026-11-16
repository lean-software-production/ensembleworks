import { describe, expect, it } from "vitest";
import { inheritedStarterRepair } from "./repair.js";
import type { StarterRecord } from "./attribution.js";

const source: StarterRecord = {
  threadId: "thr_source", starter: { person: "mattwynne", displayName: "Matt", github: "mattwynne" },
  email: "matt@example.com", via: "browser", origin: "app", originPluginId: null,
  inheritedFrom: null, recordedAt: 1, host: null,
};
const target: StarterRecord = {
  threadId: "thr_target", starter: null, email: null, via: "unknown", origin: "cli",
  originPluginId: null, inheritedFrom: null, recordedAt: 2,
  host: { id: "host_team", name: "team" },
};

describe("manual starter repair", () => {
  it("inherits a verified source while keeping target origin and host", () => {
    expect(inheritedStarterRepair({ targetId: "thr_target", sourceId: "thr_source", target, source, now: 3 }))
      .toMatchObject({ threadId: "thr_target", starter: source.starter, via: "agent",
        inheritedFrom: "thr_source", origin: "cli", host: target.host, recordedAt: 3 });
  });

  it("refuses to overwrite an identified target or copy an unknown source", () => {
    expect(inheritedStarterRepair({ targetId: "thr_target", sourceId: "thr_source",
      target: { ...target, starter: source.starter }, source, now: 3 })).toBeNull();
    expect(inheritedStarterRepair({ targetId: "thr_target", sourceId: "thr_source",
      target, source: { ...source, starter: null }, now: 3 })).toBeNull();
    expect(inheritedStarterRepair({ targetId: "thr_source", sourceId: "thr_source",
      target, source, now: 3 })).toBeNull();
  });
});
