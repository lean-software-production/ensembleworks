import { describe, expect, it } from "vitest";
import type { KvLike } from "./kv.js";
import {
  MAX_TIME_ZONE_PEOPLE,
  TIME_ZONES_KEY,
  TIME_ZONE_MIN_WRITE_MS,
  TIME_ZONE_REFRESH_MS,
  ReportedTimeZones,
  describeReportedTimeZone,
  localTimeIn,
  normalizeTimeZone,
} from "./time-zones.js";

class FakeKv implements KvLike {
  readonly rows = new Map<string, unknown>();
  writes = 0;
  failWrites = false;
  async get<T>(key: string): Promise<T | undefined> { return this.rows.get(key) as T | undefined; }
  async set(key: string, value: unknown): Promise<void> {
    if (this.failWrites) throw new Error("kv down");
    this.writes += 1;
    this.rows.set(key, JSON.parse(JSON.stringify(value)) as unknown);
  }
  async delete(key: string): Promise<void> { this.rows.delete(key); }
  async list(prefix?: string): Promise<string[]> {
    return [...this.rows.keys()].filter((key) => prefix === undefined || key.startsWith(prefix));
  }
}

/** Wednesday 18 November 2026, 9:53 p.m. Pacific standard time: the kaizen's moment. */
const KAIZEN_MOMENT = Date.UTC(2026, 10, 19, 5, 53);

describe("normalizeTimeZone", () => {
  it("keeps an IANA zone exactly as the browser reported it", () => {
    expect(normalizeTimeZone("America/Vancouver")).toBe("America/Vancouver");
    // ICU would canonicalise this one to the older Asia/Calcutta; the browser's name is kept.
    expect(normalizeTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(normalizeTimeZone("UTC")).toBe("UTC");
  });

  it("refuses anything that is not a zone Intl knows", () => {
    for (const bad of [undefined, null, 7, "", "Mars/Olympus", "Etc/Unknown", "../../etc/passwd", "A".repeat(101)]) {
      expect(normalizeTimeZone(bad)).toBeNull();
    }
  });
});

describe("localTimeIn", () => {
  it("names the weekday, date, time and UTC offset in that zone", () => {
    expect(localTimeIn("America/Los_Angeles", KAIZEN_MOMENT)).toBe("Wednesday 18 November 2026, 21:53 (UTC-8)");
    expect(localTimeIn("Asia/Kolkata", KAIZEN_MOMENT)).toBe("Thursday 19 November 2026, 11:23 (UTC+5:30)");
    expect(localTimeIn("UTC", KAIZEN_MOMENT)).toBe("Thursday 19 November 2026, 05:53 (UTC)");
  });
});

describe("describeReportedTimeZone", () => {
  it("gives the zone, the local time now and how long ago it was reported", () => {
    expect(describeReportedTimeZone({ zone: "America/Los_Angeles", at: KAIZEN_MOMENT - 120_000 }, KAIZEN_MOMENT))
      .toBe("America/Los_Angeles, local time Wednesday 18 November 2026, 21:53 (UTC-8), reported 2m ago");
  });

  it("says plainly when no zone has been reported", () => {
    expect(describeReportedTimeZone(null, KAIZEN_MOMENT)).toBe("no time zone reported by their BB app");
  });
});

describe("ReportedTimeZones", () => {
  it("knows a reported zone straight away, before storage settles", () => {
    const zones = new ReportedTimeZones(new FakeKv());
    void zones.report("mattwynne", "America/Vancouver", 1_000);
    expect(zones.get("mattwynne")).toEqual({ zone: "America/Vancouver", at: 1_000 });
    expect(zones.get("aldric")).toBeNull();
  });

  it("ignores an invalid zone and keeps the last good one", async () => {
    const zones = new ReportedTimeZones(new FakeKv());
    expect(await zones.report("mattwynne", "Europe/Lisbon", 1_000)).toBe(true);
    expect(await zones.report("mattwynne", "Mars/Olympus", 2_000)).toBe(false);
    expect(zones.get("mattwynne")).toEqual({ zone: "Europe/Lisbon", at: 1_000 });
  });

  it("survives a restart through kv", async () => {
    const kv = new FakeKv();
    await new ReportedTimeZones(kv).report("mattwynne", "America/Vancouver", 1_000);
    const restarted = new ReportedTimeZones(kv);
    expect(restarted.get("mattwynne")).toBeNull();
    await restarted.load();
    expect(restarted.get("mattwynne")).toEqual({ zone: "America/Vancouver", at: 1_000 });
  });

  it("does not let an older stored report replace a newer one in memory", async () => {
    const kv = new FakeKv();
    kv.rows.set(TIME_ZONES_KEY, { mattwynne: { zone: "Europe/London", at: 1_000 } });
    const zones = new ReportedTimeZones(kv);
    void zones.report("mattwynne", "America/Vancouver", 5_000);
    await zones.load();
    expect(zones.get("mattwynne")).toEqual({ zone: "America/Vancouver", at: 5_000 });
  });

  it("writes an unchanged zone at most once per refresh window, however often it is reported", async () => {
    const kv = new FakeKv();
    const zones = new ReportedTimeZones(kv);
    for (let at = 0; at < TIME_ZONE_REFRESH_MS; at += 10_000) await zones.report("mattwynne", "America/Vancouver", at);
    expect(kv.writes).toBe(1);
    expect(zones.get("mattwynne")?.at).toBe(TIME_ZONE_REFRESH_MS - 10_000);
    await zones.report("mattwynne", "America/Vancouver", TIME_ZONE_REFRESH_MS);
    expect(kv.writes).toBe(2);
  });

  it("writes a changed zone once the minimum gap has passed", async () => {
    const kv = new FakeKv();
    const zones = new ReportedTimeZones(kv);
    await zones.report("mattwynne", "America/Vancouver", 0);
    await zones.report("mattwynne", "Europe/London", TIME_ZONE_MIN_WRITE_MS - 1);
    expect(kv.writes).toBe(1);
    expect(zones.get("mattwynne")?.zone).toBe("Europe/London");
    await zones.report("mattwynne", "Europe/London", TIME_ZONE_MIN_WRITE_MS);
    expect(kv.writes).toBe(2);
    const restarted = new ReportedTimeZones(kv);
    await restarted.load();
    expect(restarted.get("mattwynne")?.zone).toBe("Europe/London");
  });

  it("keeps every person's zone when several report at once", async () => {
    const kv = new FakeKv();
    const zones = new ReportedTimeZones(kv);
    await Promise.all([
      zones.report("mattwynne", "America/Vancouver", 1_000),
      zones.report("aldric", "Europe/London", 1_000),
    ]);
    const restarted = new ReportedTimeZones(kv);
    await restarted.load();
    expect(restarted.get("mattwynne")?.zone).toBe("America/Vancouver");
    expect(restarted.get("aldric")?.zone).toBe("Europe/London");
  });

  it("never drops other people's stored zones when a report arrives before the first load", async () => {
    const kv = new FakeKv();
    kv.rows.set(TIME_ZONES_KEY, { aldric: { zone: "Europe/London", at: 1_000 } });
    const zones = new ReportedTimeZones(kv);
    await zones.report("mattwynne", "America/Vancouver", 2_000);
    expect(kv.rows.get(TIME_ZONES_KEY)).toEqual({
      aldric: { zone: "Europe/London", at: 1_000 },
      mattwynne: { zone: "America/Vancouver", at: 2_000 },
    });
  });

  it("keeps only the most recently reported people past the cap", async () => {
    const kv = new FakeKv();
    const zones = new ReportedTimeZones(kv, { max: 2 });
    await zones.report("a", "UTC", 1);
    await zones.report("b", "UTC", 2);
    await zones.report("c", "UTC", 3);
    expect(zones.get("a")).toBeNull();
    expect(Object.keys(kv.rows.get(TIME_ZONES_KEY) as object).sort()).toEqual(["b", "c"]);
    expect(MAX_TIME_ZONE_PEOPLE).toBeGreaterThanOrEqual(64);
  });

  it("never throws when storage fails, and tries the write again on the next report", async () => {
    const kv = new FakeKv();
    kv.failWrites = true;
    const zones = new ReportedTimeZones(kv);
    expect(await zones.report("mattwynne", "America/Vancouver", 1_000)).toBe(true);
    expect(zones.get("mattwynne")?.zone).toBe("America/Vancouver");
    kv.failWrites = false;
    await zones.report("mattwynne", "America/Vancouver", 11_000);
    expect(kv.writes).toBe(1);
  });

  it("reads a corrupt stored row as empty and drops malformed entries", async () => {
    const kv = new FakeKv();
    kv.rows.set(TIME_ZONES_KEY, { good: { zone: "UTC", at: 5 }, bad: { zone: "Mars/Olympus", at: 5 }, worse: "UTC" });
    const zones = new ReportedTimeZones(kv);
    await zones.load();
    expect(zones.get("good")).toEqual({ zone: "UTC", at: 5 });
    expect(zones.get("bad")).toBeNull();
    expect(zones.get("worse")).toBeNull();
    kv.rows.set(TIME_ZONES_KEY, ["not", "a", "row"]);
    const fresh = new ReportedTimeZones(kv);
    await fresh.load();
    expect(fresh.get("good")).toBeNull();
  });
});
