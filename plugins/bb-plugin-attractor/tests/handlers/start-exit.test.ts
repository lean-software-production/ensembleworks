import { describe, expect, it } from "vitest";
import { exitHandler, startHandler } from "../../handlers/start-exit";

describe("start/exit handlers", () => {
  it("start always succeeds with no side effects", async () => {
    const outcome = await startHandler.run({} as never);
    expect(outcome).toEqual({ status: "succeeded" });
  });

  it("exit always succeeds — reaching it at all means the walk got there", async () => {
    const outcome = await exitHandler.run({} as never);
    expect(outcome).toEqual({ status: "succeeded" });
  });
});
