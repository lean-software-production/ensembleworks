// Run: npx vitest run tests/agent-project.test.ts
//
// TASK 2d: an unset project setting must SURFACE, not guess. The guessing
// version of this rule shipped and bit the owner — every canvas thread spawned
// into whichever project bb listed first, while the owner watched a different
// project's sidebar and reasonably concluded the threads did not exist.
import { describe, expect, it } from "vitest";
import {
  PROJECT_NOT_SET_DETAIL,
  resolveCanvasProjectId,
} from "../canvas/agent-project.js";

describe("resolveCanvasProjectId", () => {
  it("is the configured project", () => {
    expect(resolveCanvasProjectId("proj_h2xheu2hs7")).toBe("proj_h2xheu2hs7");
  });

  it("throws, naming the setting, when nothing is configured", () => {
    // The message is the whole product surface of this refusal: it reaches the
    // user as a toast, so it has to say what to do rather than what went wrong.
    for (const unset of [undefined, null, "", "   "]) {
      expect(() => resolveCanvasProjectId(unset)).toThrow(PROJECT_NOT_SET_DETAIL);
    }
    expect(PROJECT_NOT_SET_DETAIL).toMatch(/Canvas plugin's project setting/);
  });

  it("throws for a value that is not a string", () => {
    // `bb.settings.get()` is typed loosely enough that a mis-declared
    // descriptor could hand back a number; a project id that is not a string
    // is not a project id.
    for (const wrong of [42, true, {}, []]) {
      expect(() => resolveCanvasProjectId(wrong)).toThrow(PROJECT_NOT_SET_DETAIL);
    }
  });

  it("trims, so a pasted id with stray whitespace still works", () => {
    expect(resolveCanvasProjectId("  proj_x  ")).toBe("proj_x");
  });
});
