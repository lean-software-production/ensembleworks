import { describe, expect, it } from "vitest";
import { forkHandler, joinHandler } from "../../handlers/parallel";

describe("parallel fork/join handlers", () => {
  it("the fork (component) node's own stage always succeeds — engine.ts does the actual fan-out afterwards", async () => {
    expect(await forkHandler.run({} as never)).toEqual({ status: "succeeded" });
  });

  it("the join (tripleoctagon) node's own stage always succeeds — engine.ts already merged parallel.results", async () => {
    expect(await joinHandler.run({} as never)).toEqual({ status: "succeeded" });
  });
});
