import { afterEach, describe, expect, it } from "vitest";
import { createContext } from "../engine/context";

describe("engine/context: dot-path key-value context", () => {
  it("get/set round-trips a top-level key", () => {
    const ctx = createContext();
    ctx.set("last_stage", "plan");
    expect(ctx.get("last_stage")).toBe("plan");
  });

  it("set builds intermediate objects for a dotted path", () => {
    const ctx = createContext();
    ctx.set("response.plan", "the plan text");
    expect(ctx.toObject()).toEqual({ response: { plan: "the plan text" } });
    expect(ctx.get("response.plan")).toBe("the plan text");
  });

  it("set overwrites a non-object intermediate value rather than throwing", () => {
    const ctx = createContext({ response: "not an object yet" });
    ctx.set("response.plan", "now it is");
    expect(ctx.toObject()).toEqual({ response: { plan: "now it is" } });
  });

  it("get returns undefined for a missing path, including through a non-object", () => {
    const ctx = createContext({ foo: "bar" });
    expect(ctx.get("missing")).toBeUndefined();
    expect(ctx.get("foo.bar")).toBeUndefined();
  });

  it("get does not resolve inherited Object.prototype members", () => {
    const ctx = createContext();
    expect(ctx.get("constructor")).toBeUndefined();
    expect(ctx.get("toString")).toBeUndefined();
  });

  it("merge shallow-overwrites top-level keys, deep-cloning the incoming value", () => {
    const ctx = createContext({ a: 1, keep: "me" });
    const updates: Record<string, unknown> = { a: 2, nested: { b: 1 } };
    ctx.merge(updates as never);
    expect(ctx.toObject()).toEqual({ a: 2, keep: "me", nested: { b: 1 } });
    // Mutating the caller's object afterwards must not affect the context (deep clone on the way in).
    (updates.nested as Record<string, unknown>).b = 999;
    expect(ctx.toObject().nested).toEqual({ b: 1 });
  });

  it("merge dot-traverses a key containing a dot, so it is readable the same way an edge condition would read it", () => {
    const ctx = createContext({});
    ctx.merge({ "build.status": "green" } as never);
    expect(ctx.toObject()).toEqual({ build: { status: "green" } });
    expect(ctx.get("build.status")).toBe("green");
  });

  it("merge with undefined is a no-op", () => {
    const ctx = createContext({ a: 1 });
    ctx.merge(undefined);
    expect(ctx.toObject()).toEqual({ a: 1 });
  });

  it("toObject returns a deep-cloned snapshot decoupled from later mutation", () => {
    const ctx = createContext();
    ctx.set("response.plan", "v1");
    const snap = ctx.toObject();
    ctx.set("response.plan", "v2");
    expect(snap).toEqual({ response: { plan: "v1" } });
  });

  it("clone produces an independent Context seeded from the current snapshot", () => {
    const ctx = createContext();
    ctx.set("shared.value", 1);
    const branch = ctx.clone();
    branch.set("shared.value", 2);
    branch.set("branch_only", true);
    expect(ctx.toObject()).toEqual({ shared: { value: 1 } });
    expect(branch.toObject()).toEqual({ shared: { value: 2 }, branch_only: true });
  });

  it("constructor deep-clones the initial object so later external mutation cannot leak in", () => {
    const initial: Record<string, unknown> = { nested: { a: 1 } };
    const ctx = createContext(initial as never);
    (initial.nested as Record<string, unknown>).a = 999;
    expect(ctx.toObject()).toEqual({ nested: { a: 1 } });
  });

  describe("set does not pollute Object.prototype", () => {
    afterEach(() => {
      // Belt-and-braces: if a defect lets a test leak a pollution, don't let
      // it poison every other test file that runs in this process afterwards.
      delete (Object.prototype as Record<string, unknown>).polluted;
      delete (Object.prototype as Record<string, unknown>).polluted2;
    });

    it("rejects a leading __proto__ segment instead of writing through to Object.prototype", () => {
      const ctx = createContext({});
      expect(() => ctx.set("__proto__.polluted", "yes")).toThrow();
      const probe = {} as Record<string, unknown>;
      expect(probe.polluted).toBeUndefined();
    });

    it("rejects a __proto__ segment nested under an existing intermediate key", () => {
      const ctx = createContext({});
      expect(() => ctx.set("response.__proto__.polluted2", "pwned")).toThrow();
      const probe = {} as Record<string, unknown>;
      expect(probe.polluted2).toBeUndefined();
    });

    it("rejects constructor/prototype segments the same way", () => {
      const ctx = createContext({});
      expect(() => ctx.set("constructor.prototype.polluted", "yes")).toThrow();
      const probe = {} as Record<string, unknown>;
      expect(probe.polluted).toBeUndefined();
    });
  });
});
