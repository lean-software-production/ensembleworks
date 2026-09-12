// Run: npx vitest run   (or `npm test`)
//
// The room transcript, driven through the REAL plugin factory: what the scribe
// service POSTs, what an agent or a panel can ask back, and what a resolved
// @transcript mention actually puts in an agent's context.
//
// No scribe service is involved and none is needed — the ingest contract is
// one HTTP route with a JSON body, so everything worth checking about it
// (what it accepts, what it rejects, what it stores, what it broadcasts) is
// checkable offline. Whether the VM's systemd unit is pointed at it is a
// deployment question, not a code one.
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { FakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  MENTION_CONTEXT_CAP,
  parseDuration,
  parseTranscriptArgs,
  transcriptBlock,
} from "../canvas/transcript.js";
import {
  appendEntry,
  formatClock,
  isPinnedToBottom,
  matchesSearch,
} from "../canvas/transcript-view.js";
import { TRANSCRIPT_CHANNEL, transcriptEntryFrom } from "../canvas/wire.js";
import type { TranscriptEntry } from "../canvas/wire.js";
import plugin from "../server.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const hosts: FakePluginHost[] = [];

async function bootHost() {
  const host = createFakePluginHost({ pluginId: "canvas" });
  hosts.push(host);
  await plugin(host.bb);
  return host;
}

afterEach(async () => {
  // Releases the room host's database handle; a leaked one keeps the process
  // alive after the suite.
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

/** POST a body to the scribe route exactly as the VM service would. */
function postScribe(host: FakePluginHost, body: unknown): Promise<Response> {
  return host.harness.behavior.fetchHttp("POST", "/scribe", {
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Every entry the room has, oldest first. */
async function queryAll(
  host: FakePluginHost,
  input: Record<string, unknown> = {},
): Promise<TranscriptEntry[]> {
  const result = (await host.harness.behavior.callRpc(
    "canvas_transcript_query",
    input,
  )) as { entries: TranscriptEntry[] };
  return result.entries;
}

/** Seed a fixed, known conversation. Timestamps are relative to `now` so the
 * "--since"/window cases are exact without freezing the clock. */
async function seed(host: FakePluginHost, now: number): Promise<void> {
  const response = await postScribe(host, [
    { ts: now - 3 * HOUR, speaker: "alice", text: "morning, shipping the parser today" },
    { ts: now - 90 * MINUTE, speaker: "bob", text: "the rate limit bit us again" },
    { ts: now - 30 * MINUTE, speaker: "Alice", text: "let's cap it at 100% of budget" },
    { ts: now - 5 * MINUTE, speaker: "carol", text: "agreed, capping it" },
  ]);
  expect(response.status).toBe(200);
}

describe("scribe ingest", () => {
  it("accepts one utterance, stores it, and broadcasts it live", async () => {
    const host = await bootHost();
    const response = await postScribe(host, {
      ts: 1_700_000_000_000,
      speaker: "alice",
      text: "let's ship it",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, inserted: 1 });
    await expect(queryAll(host)).resolves.toEqual([
      { ts: 1_700_000_000_000, speaker: "alice", text: "let's ship it" },
    ]);

    // Durable first, then live — and on its OWN channel, so a panel tailing
    // the conversation is not decoding CRDT frame envelopes.
    expect(host.harness.inspection.realtimeSignals).toContainEqual({
      channel: TRANSCRIPT_CHANNEL,
      payload: { ts: 1_700_000_000_000, speaker: "alice", text: "let's ship it" },
    });
  });

  it("accepts a batch and publishes one message per utterance", async () => {
    // The VM service batches when it catches up after a network blip, so a
    // batch is the normal path, not an exotic one.
    const host = await bootHost();
    const response = await postScribe(host, [
      { ts: 1_000, speaker: "alice", text: "one" },
      { ts: 2_000, speaker: "bob", text: "two" },
      { ts: 3_000, speaker: "alice", text: "three" },
    ]);

    await expect(response.json()).resolves.toEqual({ ok: true, inserted: 3 });
    expect((await queryAll(host)).map((entry) => entry.text)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(
      host.harness.inspection.realtimeSignals.filter(
        (signal) => signal.channel === TRANSCRIPT_CHANNEL,
      ),
    ).toHaveLength(3);
  });

  it("times an untimed utterance by when it arrived", async () => {
    const host = await bootHost();
    const before = Date.now();
    await postScribe(host, { speaker: "alice", text: "no timestamp here" });
    const after = Date.now();

    const [entry] = await queryAll(host);
    expect(entry!.ts).toBeGreaterThanOrEqual(before);
    expect(entry!.ts).toBeLessThanOrEqual(after);
  });

  it.each([
    ["a missing speaker", { text: "orphaned" }],
    ["a missing text", { speaker: "alice" }],
    ["an empty speaker", { speaker: "   ", text: "hi" }],
    ["a whitespace-only text", { speaker: "alice", text: "   " }],
    ["a non-string text", { speaker: "alice", text: 42 }],
    ["a non-finite ts", { ts: Number.POSITIVE_INFINITY, speaker: "a", text: "b" }],
    ["an empty batch", []],
    ["a batch with one bad member", [{ speaker: "a", text: "ok" }, { text: "bad" }]],
    ["a bare string", "hello"],
    ["null", null],
  ])("rejects %s with a 400 and stores nothing", async (_label, body) => {
    const host = await bootHost();
    const response = await postScribe(host, body);

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBeTypeOf("string");
    // The whole POST is refused, not partially applied: the batch case above
    // has one good member, and half a minute of conversation is worse than
    // none because nobody can tell it is half.
    await expect(queryAll(host)).resolves.toEqual([]);
    expect(
      host.harness.inspection.realtimeSignals.filter(
        (signal) => signal.channel === TRANSCRIPT_CHANNEL,
      ),
    ).toHaveLength(0);
  });

  it("names the offending field, so an operator can fix the VM service", async () => {
    // A union would report every one of these at the root as "Invalid input",
    // which tells the person wiring up the systemd unit nothing at all.
    const host = await bootHost();

    const single = await postScribe(host, { ts: 1, text: "no speaker" });
    await expect(single.json()).resolves.toMatchObject({
      error: expect.stringContaining("at speaker"),
    });

    const batch = await postScribe(host, [
      { speaker: "a", text: "fine" },
      { speaker: "b", text: "" },
    ]);
    await expect(batch.json()).resolves.toMatchObject({
      error: expect.stringContaining("at 1.text"),
    });
  });

  it("rejects a body that is not JSON at all, without a 500", async () => {
    const host = await bootHost();
    const response = await postScribe(host, "{not json");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });

  it("tolerates fields the scribe service grows later", async () => {
    // The producer is a service on another machine this repo does not own.
    // When it starts sending `confidence`, the right outcome is that the room
    // keeps working — not that every utterance is refused until both sides
    // ship together.
    const host = await bootHost();
    const response = await postScribe(host, {
      ts: 5_000,
      speaker: "alice",
      text: "still fine",
      confidence: 0.92,
      durationMs: 1_400,
    });

    expect(response.status).toBe(200);
    await expect(queryAll(host)).resolves.toEqual([
      { ts: 5_000, speaker: "alice", text: "still fine" },
    ]);
  });

  it("is mounted for machines, not browsers: POST /scribe with token auth", async () => {
    // "local" would reject the VM service (it is not a bb app origin) and
    // "none" would let anything on the box write into the room's memory.
    const host = await bootHost();
    expect(host.harness.registrations.httpRoutes).toContainEqual(
      expect.objectContaining({ method: "POST", path: "/scribe", auth: "token" }),
    );
  });
});

describe("canvas_transcript_query", () => {
  it("returns the window oldest first", async () => {
    const host = await bootHost();
    await seed(host, Date.now());

    expect((await queryAll(host)).map((entry) => entry.speaker)).toEqual([
      "alice",
      "bob",
      "Alice",
      "carol",
    ]);
  });

  it("narrows by sinceMs, an absolute bound", async () => {
    const host = await bootHost();
    const now = Date.now();
    await seed(host, now);

    const recent = await queryAll(host, { sinceMs: now - HOUR });
    expect(recent.map((entry) => entry.text)).toEqual([
      "let's cap it at 100% of budget",
      "agreed, capping it",
    ]);
  });

  it("searches the utterance text, case-insensitively", async () => {
    const host = await bootHost();
    await seed(host, Date.now());

    const hits = await queryAll(host, { search: "RATE LIMIT" });
    expect(hits.map((entry) => entry.speaker)).toEqual(["bob"]);
  });

  it("treats the search as a substring, not a LIKE pattern", async () => {
    // A search for "100%" must find the one line that says it, not every line
    // in the room — `%` is a wildcard to SQLite and a character to a human.
    const host = await bootHost();
    await seed(host, Date.now());

    const hits = await queryAll(host, { search: "100%" });
    expect(hits.map((entry) => entry.text)).toEqual([
      "let's cap it at 100% of budget",
    ]);
    // A bare "%" is a wildcard to SQLite and a character to a human: it must
    // find the one line that contains one, not the whole room.
    const wildcard = await queryAll(host, { search: "%" });
    expect(wildcard.map((entry) => entry.text)).toEqual([
      "let's cap it at 100% of budget",
    ]);
    await expect(queryAll(host, { search: "_" })).resolves.toEqual([]);
  });

  it("filters by speaker exactly, ignoring case", async () => {
    // The diariser is not consistent about capitalisation between sessions;
    // "alice" and "Alice" are one person, and asking for either gets both.
    const host = await bootHost();
    await seed(host, Date.now());

    const said = await queryAll(host, { speaker: "ALICE" });
    expect(said.map((entry) => entry.text)).toEqual([
      "morning, shipping the parser today",
      "let's cap it at 100% of budget",
    ]);
  });

  it("ANDs its filters", async () => {
    const host = await bootHost();
    const now = Date.now();
    await seed(host, now);

    await expect(
      queryAll(host, { speaker: "alice", sinceMs: now - HOUR }),
    ).resolves.toHaveLength(1);
    await expect(
      queryAll(host, { speaker: "bob", search: "parser" }),
    ).resolves.toEqual([]);
  });

  it("takes the TAIL when limited, still oldest first", async () => {
    // A limit on a transcript means "the last N", never "the first N": a
    // reader asking for two lines of a four-hour day wants the end of it.
    const host = await bootHost();
    await seed(host, Date.now());

    expect((await queryAll(host, { limit: 2 })).map((entry) => entry.text)).toEqual([
      "let's cap it at 100% of budget",
      "agreed, capping it",
    ]);
  });

  it("refuses a limit past the contract's ceiling", async () => {
    const host = await bootHost();
    await expect(
      host.harness.behavior.callRpc("canvas_transcript_query", { limit: 5_000 }),
    ).rejects.toThrow();
  });
});

describe("the @transcript mention", () => {
  function providerOf(host: FakePluginHost) {
    const provider = host.harness.registrations.mentionProviders.find(
      (candidate) => candidate.id === "transcript",
    );
    expect(provider, "the transcript mention provider is registered").toBeDefined();
    return provider!;
  }

  it("offers the three fixed windows, with live counts", async () => {
    const host = await bootHost();
    await seed(host, Date.now());

    const items = await providerOf(host).search({
      trigger: "@",
      query: "",
      projectId: null,
      threadId: null,
    });

    expect(items.map((item) => item.id)).toEqual(["15m", "60m", "today"]);
    // Counts before the pick, so an empty window is visible without spending a
    // send to find out.
    expect(items.map((item) => item.subtitle)).toEqual([
      "1 entry",
      "2 entries",
      expect.any(String),
    ]);
  });

  it("adds a matches row once there is something to match", async () => {
    const host = await bootHost();
    await seed(host, Date.now());

    const items = await providerOf(host).search({
      trigger: "@",
      query: "rate limit",
      projectId: null,
      threadId: null,
    });

    expect(items).toHaveLength(4);
    expect(items[3]).toMatchObject({
      id: "search:rate limit",
      title: "matches for rate limit",
      subtitle: "1 entry",
    });
  });

  it("resolves a window to a formatted block of exactly that window", async () => {
    const host = await bootHost();
    const now = Date.now();
    await seed(host, now);

    const { context } = await providerOf(host).resolve("60m");

    expect(context).toContain("Room transcript — the last hour (2 entries");
    expect(context).toContain("Alice: let's cap it at 100% of budget");
    expect(context).toContain("carol: agreed, capping it");
    // Same HH:MM gutter a human read on screen.
    expect(context).toMatch(/\n\d{2}:\d{2} Alice: /);
    // Outside the window, so out of the block.
    expect(context).not.toContain("shipping the parser");
  });

  it("resolves a search item across the whole room", async () => {
    const host = await bootHost();
    await seed(host, Date.now());

    const { context } = await providerOf(host).resolve("search:parser");
    expect(context).toContain("matches for “parser”");
    expect(context).toContain("alice: morning, shipping the parser today");
  });

  it("says so plainly when the window is empty, rather than throwing", async () => {
    // A throw here BLOCKS the user's send, over a message they have already
    // written. An empty window is not an error.
    const host = await bootHost();
    const { context } = await providerOf(host).resolve("15m");
    expect(context).toBe("Room transcript — the last 15 minutes: no entries.");
  });

  it("does not throw on an item id it cannot decode", async () => {
    const host = await bootHost();
    await expect(
      Promise.resolve(providerOf(host).resolve("nonsense")),
    ).resolves.toMatchObject({
      context: expect.stringContaining("unknown window"),
    });
  });

  it("caps the block, dropping the OLDEST lines and saying it did", async () => {
    const host = await bootHost();
    const now = Date.now();
    // ~400 chars each, so ~60 of them blow the 8000-character budget.
    const entries = Array.from({ length: 120 }, (_, index) => ({
      ts: now - (120 - index) * 1_000,
      speaker: "alice",
      text: `line ${index} ${"x".repeat(380)}`,
    }));
    expect((await postScribe(host, entries)).status).toBe(200);

    const { context } = await providerOf(host).resolve("15m");

    expect(context.length).toBeLessThanOrEqual(MENTION_CONTEXT_CAP);
    // The tail survives; the head is what goes. An agent catching up needs the
    // END of the conversation.
    expect(context).toContain("line 119 ");
    expect(context).not.toContain("line 0 ");
    expect(context).toMatch(
      /Room transcript — the last 15 minutes \(\d+ of 120 entries, .*; \d+ earlier entries dropped to fit the 8000-character cap\):/,
    );
  });
});

describe("bb canvas transcript", () => {
  it("prints HH:MM speaker: text, oldest first", async () => {
    const host = await bootHost();
    await seed(host, Date.now());

    const result = await host.harness.behavior.runCli(["transcript"]);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^\d{2}:\d{2} alice: morning, shipping the parser today$/);
    expect(lines[3]).toMatch(/^\d{2}:\d{2} carol: agreed, capping it$/);
  });

  it("narrows with --since, --search and --speaker", async () => {
    const host = await bootHost();
    await seed(host, Date.now());

    await expect(
      host.harness.behavior.runCli(["transcript", "--since", "1h"]),
    ).resolves.toMatchObject({ exitCode: 0 });
    const recent = await host.harness.behavior.runCli([
      "transcript",
      "--since",
      "1h",
    ]);
    expect(recent.stdout.trim().split("\n")).toHaveLength(2);

    const searched = await host.harness.behavior.runCli([
      "transcript",
      "--search",
      "rate limit",
    ]);
    expect(searched.stdout).toContain("bob: the rate limit bit us again");

    const spoken = await host.harness.behavior.runCli([
      "transcript",
      "--speaker",
      "alice",
    ]);
    expect(spoken.stdout.trim().split("\n")).toHaveLength(2);
  });

  it("answers --json with the raw entries", async () => {
    const host = await bootHost();
    await seed(host, Date.now());

    const result = await host.harness.behavior.runCli([
      "transcript",
      "--speaker",
      "carol",
      "--json",
    ]);
    expect(JSON.parse(result.stdout)).toEqual([
      { ts: expect.any(Number), speaker: "carol", text: "agreed, capping it" },
    ]);
  });

  it("says so when the room has said nothing", async () => {
    const host = await bootHost();
    const result = await host.harness.behavior.runCli(["transcript"]);
    expect(result.stdout).toBe("No transcript entries.");
  });

  it("fails loudly on a flag it does not understand", async () => {
    const host = await bootHost();
    const bad = await host.harness.behavior.runCli([
      "transcript",
      "--since",
      "soon",
    ]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("--since wants a duration");

    const dangling = await host.harness.behavior.runCli(["transcript", "--speaker"]);
    expect(dangling.exitCode).toBe(1);
    expect(dangling.stderr).toContain("--speaker needs a value");
  });

  it("lists itself in the plugin-commands skill agents read", async () => {
    const host = await bootHost();
    expect(host.harness.registrations.cli?.commands).toContainEqual(
      expect.objectContaining({ name: "transcript" }),
    );
  });
});

describe("the pure pieces", () => {
  it("formats a clock in the reader's own local time", () => {
    // Constructed AND read in local time, so this is true in every timezone.
    const at = new Date(2024, 0, 15, 9, 5).getTime();
    expect(formatClock(at)).toBe("09:05");
  });

  it("parses the durations the CLI advertises", () => {
    expect(parseDuration("45s")).toBe(45_000);
    expect(parseDuration("10m")).toBe(10 * MINUTE);
    expect(parseDuration("2h")).toBe(2 * HOUR);
    expect(parseDuration("1d")).toBe(24 * HOUR);
    // No bare-number form: "--since 10" never silently means something.
    expect(parseDuration("10")).toBeNull();
    expect(parseDuration("0m")).toBeNull();
    expect(parseDuration("-5m")).toBeNull();
  });

  it("turns a duration flag into an absolute bound", () => {
    const now = 1_000_000;
    const parsed = parseTranscriptArgs(["--since", "10m", "--json"], now);
    expect(parsed).toMatchObject({
      ok: true,
      json: true,
      filter: { sinceMs: now - 10 * MINUTE },
    });
  });

  it("keeps one line under the cap even when that line is longer than it", () => {
    const block = transcriptBlock(
      "today",
      [{ ts: new Date(2024, 0, 1, 12, 0).getTime(), speaker: "a", text: "y".repeat(900) }],
      300,
    );
    expect(block.length).toBeLessThanOrEqual(300);
    expect(block).toContain("12:00 a: yyy");
    expect(block.endsWith("…")).toBe(true);
  });

  it("dedupes the entry that arrives down both the seed and the live path", () => {
    const entry = { ts: 1_000, speaker: "alice", text: "hi" };
    const seeded = [entry];
    // The same array back, so React skips the re-render.
    expect(appendEntry(seeded, { ...entry }, 10)).toBe(seeded);
    expect(appendEntry(seeded, { ...entry, text: "hi!" }, 10)).toHaveLength(2);
  });

  it("caps the rendered tail, dropping the oldest rows", () => {
    let rows: readonly TranscriptEntry[] = [];
    for (let i = 0; i < 10; i++) {
      rows = appendEntry(rows, { ts: i, speaker: "a", text: `t${i}` }, 3);
    }
    expect(rows.map((row) => row.text)).toEqual(["t7", "t8", "t9"]);
  });

  it("applies the same match test the server does", () => {
    const entry = { ts: 0, speaker: "alice", text: "the Rate Limit again" };
    expect(matchesSearch(entry, "")).toBe(true);
    expect(matchesSearch(entry, "rate limit")).toBe(true);
    // Text only — the speaker has its own filter.
    expect(matchesSearch(entry, "alice")).toBe(false);
  });

  it("keeps a sub-pixel-short scroll position pinned", () => {
    expect(
      isPinnedToBottom({ scrollTop: 999.6, scrollHeight: 1_400, clientHeight: 400 }),
    ).toBe(true);
    expect(
      isPinnedToBottom({ scrollTop: 200, scrollHeight: 1_400, clientHeight: 400 }),
    ).toBe(false);
  });

  it("refuses a realtime payload that is not an entry", () => {
    expect(transcriptEntryFrom({ ts: 1, speaker: "a", text: "b" })).toEqual({
      ts: 1,
      speaker: "a",
      text: "b",
    });
    expect(transcriptEntryFrom({ speaker: "a", text: "b" })).toBeNull();
    expect(transcriptEntryFrom({ ts: 1, speaker: "", text: "b" })).toBeNull();
    expect(transcriptEntryFrom("nope")).toBeNull();
  });
});

describe("durable transcript feed", () => {
  it("pages by insertion id across tied and late speech, and preserves stream identity on reload", async () => {
    const host = await bootHost();
    await postScribe(host, [
      { ts: 2000, speaker: "A", text: "first" },
      { ts: 2000, speaker: "A", text: "second" },
      { ts: 1000, speaker: "B", text: "late" },
    ]);
    const page = await host.harness.behavior.callRpc("canvas_transcript_feed", { after: 0, limit: 2 }) as {streamId:string; nextCursor:number; entries:TranscriptEntry[]; hasMore:boolean};
    expect(page.entries.map(e => e.text)).toEqual(["first", "second"]);
    expect(page.hasMore).toBe(true);
    const reloaded = await host.harness.lifecycle.reload(plugin);
    hosts.push(reloaded);
    const tail = await reloaded.harness.behavior.callRpc("canvas_transcript_feed", { after: page.nextCursor, limit: 2 });
    expect(tail).toMatchObject({streamId:page.streamId, entries:[{text:"late"}],hasMore:false});
    await expect(reloaded.harness.behavior.callRpc("canvas_transcript_feed", { after: -1, limit: 100 })).rejects.toThrow();
  });
});
