import { describe, expect, it } from "vitest";
import type { KvLike } from "./kv.js";
import type { StarterSummary } from "./attribution.js";
import {
  MAX_SENDERS_PER_THREAD,
  PREVIEW_CHARS,
  SenderLedger,
  digestMessageText,
  formatRecentSenders,
  senderInstructions,
  textOfBlocks,
} from "./senders.js";

const matt: StarterSummary = { person: "mattwynne", displayName: "Matt", github: "mattwynne" };
const aldric: StarterSummary = { person: "aldric", displayName: "Aldric", github: "aldric" };

class FakeKv implements KvLike {
  readonly rows = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.rows.get(key) as T | undefined; }
  async set(key: string, value: unknown): Promise<void> { this.rows.set(key, JSON.parse(JSON.stringify(value)) as unknown); }
  async delete(key: string): Promise<void> { this.rows.delete(key); }
  async list(prefix?: string): Promise<string[]> {
    return [...this.rows.keys()].filter((key) => prefix === undefined || key.startsWith(prefix));
  }
}

describe("digestMessageText", () => {
  it("is a stable sha256 of the text", () => {
    expect(digestMessageText("hello")).toBe(digestMessageText("hello"));
    expect(digestMessageText("hello")).not.toBe(digestMessageText("hello "));
    expect(digestMessageText("hello")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("SenderLedger", () => {
  it("records a named sender with a content digest and a short preview", async () => {
    const ledger = new SenderLedger(new FakeKv());
    expect(await ledger.record({ threadId: "thr_1", text: "ship the retry fix", person: aldric, email: "aldric@example.com", at: 1_000 })).toBe(true);
    expect(await ledger.recent("thr_1")).toEqual([
      { digest: digestMessageText("ship the retry fix"), person: aldric, email: "aldric@example.com", at: 1_000, preview: "ship the retry fix" },
    ]);
  });

  it("stores a null email when none is known, and reads an older row without the field as null", async () => {
    const kv = new FakeKv();
    const ledger = new SenderLedger(kv);
    await ledger.record({ threadId: "thr_1", text: "hi", person: matt, email: null, at: 1_000 });
    expect((await ledger.recent("thr_1"))[0]).toMatchObject({ email: null });
    kv.rows.set("senders:thr_2", { v: 1, threadId: "thr_2", entries: [{ digest: "a".repeat(64), person: matt, at: 1, preview: "old" }] });
    expect((await new SenderLedger(kv).recent("thr_2"))[0]).toMatchObject({ person: matt, email: null });
  });

  it("records nothing for an unidentified sender", async () => {
    const kv = new FakeKv();
    const ledger = new SenderLedger(kv);
    expect(await ledger.record({ threadId: "thr_1", text: "hi", person: null, email: null, at: 1_000 })).toBe(false);
    expect(await ledger.recent("thr_1")).toEqual([]);
    expect(kv.rows.size).toBe(0);
  });

  it("returns newest first and lets two people alternate", async () => {
    const ledger = new SenderLedger(new FakeKv());
    await ledger.record({ threadId: "thr_1", text: "what about the data model?", person: matt, email: null, at: 1_000 });
    await ledger.record({ threadId: "thr_1", text: "and the UI?", person: aldric, email: null, at: 2_000 });
    expect((await ledger.recent("thr_1")).map((e) => [e.person.displayName, e.preview])).toEqual([
      ["Aldric", "and the UI?"],
      ["Matt", "what about the data model?"],
    ]);
  });

  it("is idempotent for a re-run of the same dispatch (same text, same person, back to back)", async () => {
    const ledger = new SenderLedger(new FakeKv());
    await ledger.record({ threadId: "thr_1", text: "retry me", person: matt, email: null, at: 1_000 });
    expect(await ledger.record({ threadId: "thr_1", text: "retry me", person: matt, email: null, at: 1_500 })).toBe(false);
    expect(await ledger.recent("thr_1")).toHaveLength(1);
  });

  it("still records the same text when a different person sends it", async () => {
    const ledger = new SenderLedger(new FakeKv());
    await ledger.record({ threadId: "thr_1", text: "+1", person: matt, email: null, at: 1_000 });
    expect(await ledger.record({ threadId: "thr_1", text: "+1", person: aldric, email: null, at: 2_000 })).toBe(true);
    expect(await ledger.recent("thr_1")).toHaveLength(2);
  });

  it("truncates the preview to one line of bounded length", async () => {
    const ledger = new SenderLedger(new FakeKv());
    const long = `first line ${"x".repeat(200)}\nsecond line`;
    await ledger.record({ threadId: "thr_1", text: long, person: matt, email: null, at: 1_000 });
    const [entry] = await ledger.recent("thr_1");
    expect(entry!.preview.length).toBeLessThanOrEqual(PREVIEW_CHARS + 1);
    expect(entry!.preview).not.toContain("\n");
    expect(entry!.preview.endsWith("…")).toBe(true);
    expect(entry!.digest).toBe(digestMessageText(long));
  });

  it("keeps only the newest entries per thread", async () => {
    const ledger = new SenderLedger(new FakeKv());
    for (let i = 0; i < MAX_SENDERS_PER_THREAD + 5; i += 1) {
      await ledger.record({ threadId: "thr_1", text: `message ${i}`, person: i % 2 ? matt : aldric, email: null, at: i });
    }
    const entries = await ledger.recent("thr_1", 1_000);
    expect(entries).toHaveLength(MAX_SENDERS_PER_THREAD);
    expect(entries[0]!.preview).toBe(`message ${MAX_SENDERS_PER_THREAD + 4}`);
    expect(entries.at(-1)!.preview).toBe("message 5");
  });

  it("honours the requested limit", async () => {
    const ledger = new SenderLedger(new FakeKv());
    for (let i = 0; i < 5; i += 1) await ledger.record({ threadId: "thr_1", text: `m${i}`, person: matt, email: null, at: i });
    expect(await ledger.recent("thr_1", 2)).toHaveLength(2);
  });

  it("reads back what another ledger instance wrote (survives a restart)", async () => {
    const kv = new FakeKv();
    await new SenderLedger(kv).record({ threadId: "thr_1", text: "before restart", person: aldric, email: null, at: 1_000 });
    expect(await new SenderLedger(kv).recent("thr_1")).toMatchObject([{ person: aldric }]);
  });

  it("serialises concurrent records on one thread so none is lost", async () => {
    const ledger = new SenderLedger(new FakeKv());
    await Promise.all([
      ledger.record({ threadId: "thr_1", text: "a", person: matt, email: null, at: 1 }),
      ledger.record({ threadId: "thr_1", text: "b", person: aldric, email: null, at: 2 }),
      ledger.record({ threadId: "thr_1", text: "c", person: matt, email: null, at: 3 }),
    ]);
    expect((await ledger.recent("thr_1")).map((e) => e.preview)).toEqual(["c", "b", "a"]);
  });

  it("answers nothing, and never throws, when storage is broken", async () => {
    const broken: KvLike = {
      get: () => Promise.reject(new Error("boom")),
      set: () => Promise.reject(new Error("boom")),
      delete: () => Promise.reject(new Error("boom")),
      list: () => Promise.reject(new Error("boom")),
    };
    const ledger = new SenderLedger(broken);
    expect(await ledger.record({ threadId: "thr_1", text: "x", person: matt, email: null, at: 1 })).toBe(false);
    expect(await ledger.recent("thr_1")).toEqual([]);
  });

  it("ignores a corrupt stored row", async () => {
    const kv = new FakeKv();
    kv.rows.set("senders:thr_1", { v: 1, threadId: "thr_1", entries: [{ nope: true }] });
    expect(await new SenderLedger(kv).recent("thr_1")).toEqual([]);
  });

  describe("peopleOf (synchronous, for the instructions provider)", () => {
    it("knows the distinct people of a thread it has recorded, in first-seen order", async () => {
      const ledger = new SenderLedger(new FakeKv());
      await ledger.record({ threadId: "thr_1", text: "a", person: aldric, email: null, at: 1 });
      await ledger.record({ threadId: "thr_1", text: "b", person: matt, email: null, at: 2 });
      await ledger.record({ threadId: "thr_1", text: "c", person: aldric, email: null, at: 3 });
      expect(ledger.peopleOf("thr_1")).toEqual([aldric, matt]);
    });

    it("knows a person synchronously as soon as record() is called, before storage settles", () => {
      const ledger = new SenderLedger(new FakeKv());
      void ledger.record({ threadId: "thr_1", text: "a", person: aldric, email: null, at: 1 });
      expect(ledger.peopleOf("thr_1")).toEqual([aldric]);
    });

    it("answers nobody for an unseen thread, then warms from storage for the next call", async () => {
      const kv = new FakeKv();
      await new SenderLedger(kv).record({ threadId: "thr_1", text: "a", person: matt, email: null, at: 1 });
      const fresh = new SenderLedger(kv);
      expect(fresh.peopleOf("thr_1")).toEqual([]);
      await fresh.recent("thr_1");
      expect(fresh.peopleOf("thr_1")).toEqual([matt]);
    });
  });
});

describe("formatRecentSenders", () => {
  it("lists newest first with name, handle, age and preview, then ready-made co-author trailers", () => {
    const text = formatRecentSenders([
      { digest: "d2", person: aldric, email: "aldric@example.com", at: 120_000, preview: "and the UI?" },
      { digest: "d1", person: matt, email: "matt@example.com", at: 0, preview: "what about the data model?" },
      { digest: "d0", person: aldric, email: "aldric@example.com", at: 0, preview: "hello" },
    ], 180_000);
    expect(text).toBe([
      "Recent prompts on this thread, newest first:",
      "1. Aldric (@aldric, 1m ago): \"and the UI?\"",
      "2. Matt (@mattwynne, 3m ago): \"what about the data model?\"",
      "3. Aldric (@aldric, 3m ago): \"hello\"",
      "",
      "Commit trailers for these people:",
      "Co-authored-by: Aldric <aldric@example.com>",
      "Co-authored-by: Matt <matt@example.com>",
    ].join("\n"));
  });

  it("credits the directory's full name and current email when a lookup is supplied", () => {
    const text = formatRecentSenders([
      { digest: "d1", person: matt, email: "old@example.com", at: 0, preview: "hi" },
      { digest: "d0", person: aldric, email: null, at: 0, preview: "yo" },
    ], 0, (person) => person.person === "mattwynne" ? { fullName: "Matt Wynne", email: "matt@mattwynne.net" } : null);
    expect(text).toContain("1. Matt (@mattwynne, 0s ago): \"hi\"");
    expect(text).toContain("Co-authored-by: Matt Wynne <matt@mattwynne.net>");
    expect(text).toContain("Co-authored-by: Aldric <aldric@users.noreply.github.com>");
  });

  it("falls back to the GitHub noreply address for a trailer when no email is known", () => {
    const text = formatRecentSenders([{ digest: "d1", person: matt, email: null, at: 0, preview: "hi" }], 0);
    expect(text).toContain("Co-authored-by: Matt <mattwynne@users.noreply.github.com>");
  });

  it("says plainly when nothing is recorded", () => {
    expect(formatRecentSenders([], 0)).toBe("No identified senders are recorded for this thread yet.");
  });
});

describe("senderInstructions", () => {
  it("names the people and points at the tool", () => {
    expect(senderInstructions([matt, aldric])).toBe(
      "People who have sent prompts on this thread: Matt (@mattwynne), Aldric (@aldric). "
      + "More than one person may be prompting you here, so address them by name and keep each person's "
      + "questions distinct. Call identity_recent_senders to see who sent each recent prompt.",
    );
  });

  it("names a single person without the multi-person caveat", () => {
    expect(senderInstructions([matt])).toBe(
      "The person prompting you on this thread so far: Matt (@mattwynne). "
      + "Call identity_recent_senders if you need to check who sent a prompt.",
    );
  });

  it("contributes nothing when nobody is known", () => {
    expect(senderInstructions([])).toBeNull();
  });
});

describe("textOfBlocks", () => {
  it("concatenates the text blocks of a queued row's content, as the dispatch hook's input.text does", () => {
    expect(textOfBlocks([{ type: "text", text: "people directory?" }])).toBe("people directory?");
    expect(textOfBlocks([{ type: "text", text: "a" }, { type: "image", data: "…" }, { type: "text", text: "b" }])).toBe("a\nb");
  });

  it("answers null for content with no text, or that is not a block list at all", () => {
    expect(textOfBlocks([{ type: "image", data: "…" }])).toBeNull();
    expect(textOfBlocks("nope")).toBeNull();
    expect(textOfBlocks(null)).toBeNull();
  });
});
