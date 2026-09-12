import { describe, expect, it, vi } from "vitest";
import { createThreadExcerptReader } from "../canvas/thread-excerpts.js";

function threads(output: (args: { threadId: string; signal?: AbortSignal }) => Promise<{ output: string | null }>) {
  return { output };
}

describe("createThreadExcerptReader", () => {
  it("preserves Markdown whitespace and truncates latest output, with a stable label", async () => {
    const read = createThreadExcerptReader(
      threads(async () => ({ output: `  one\n two\t${"x".repeat(400)}  ` })),
      () => true,
    );

    const result = await read(["th_1"]);

    expect(result.th_1?.label).toBe("Latest response");
    expect(result.th_1?.text).toHaveLength(320);
    expect(result.th_1?.text).toMatch(/^one\n two\tx/);
    expect(result.th_1?.text.endsWith("…")).toBe(true);
  });

  it("reads only linked, deduplicated ids and caps the request at 20", async () => {
    const calls: string[] = [];
    const linked = new Set(["th_linked"]);
    const output = vi.fn(async ({ threadId }: { threadId: string }) => {
      calls.push(threadId);
      return { output: threadId };
    });
    const read = createThreadExcerptReader(threads(output), (id) => linked.has(id));

    const result = await read(["th_unlinked", "th_linked", "th_linked", ...Array.from({ length: 25 }, (_, i) => `th_${i}`)]);

    expect(calls).toEqual(["th_linked"]);
    expect(result).toEqual({ th_linked: { text: "th_linked", label: "Latest response" } });
  });

  it("drops a response if the link disappears while reading", async () => {
    let linked = true;
    let release!: () => void;
    const output = vi.fn(() => new Promise<{ output: string }>((resolve) => {
      release = () => resolve({ output: "private response" });
    }));
    const read = createThreadExcerptReader(threads(output), () => linked);
    const pending = read(["th_1"]);
    linked = false;
    release();

    await expect(pending).resolves.toEqual({});
  });

  it("isolates failed and empty outputs", async () => {
    const output = vi.fn(async ({ threadId }: { threadId: string }) => {
      if (threadId === "th_fail") throw new Error("offline");
      return { output: threadId === "th_empty" ? null : "ok" };
    });
    const read = createThreadExcerptReader(threads(output), () => true);

    await expect(read(["th_fail", "th_empty", "th_ok"])).resolves.toEqual({
      th_ok: { text: "ok", label: "Latest response" },
    });
  });
});

