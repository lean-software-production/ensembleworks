import { describe, expect, it } from "vitest";
import { createContext } from "../../engine/context";
import { conditionalHandler } from "../../handlers/conditional";

describe("conditional handler", () => {
  it("mirrors the previous stage's outcome (context.last_outcome) as its own outcome status", async () => {
    const context = createContext({ last_outcome: "failed" });
    const outcome = await conditionalHandler.run({ context } as never);
    expect(outcome).toEqual({ status: "failed" });
  });

  it("defaults to succeeded when nothing set last_outcome yet (e.g. a diamond node right after start)", async () => {
    const context = createContext({});
    const outcome = await conditionalHandler.run({ context } as never);
    expect(outcome).toEqual({ status: "succeeded" });
  });

  it("mirrors partially_succeeded and skipped too, not just succeeded/failed", async () => {
    const context = createContext({ last_outcome: "partially_succeeded" });
    expect(await conditionalHandler.run({ context } as never)).toEqual({ status: "partially_succeeded" });
    context.set("last_outcome", "skipped");
    expect(await conditionalHandler.run({ context } as never)).toEqual({ status: "skipped" });
  });
});
