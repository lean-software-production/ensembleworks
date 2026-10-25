import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { identityMutationAllowed, mintSelection, SelectionCommitStore, verifySelection, selectionCookie, selectionCookieName, readNamedCookie, SELECTION_COOKIE } from "./selection.js";

describe("browser selection", () => {
  const key = randomBytes(32);
  const origin = "https://bb.example.test";
  it("round trips only for the issuing origin and current time", () => {
    const token = mintSelection("matt", origin, key, 1000);
    expect(verifySelection(token, origin, key, 1001)).toEqual({ personId: "matt", status: "valid" });
    expect(verifySelection(token, "https://other.example.test", key, 1001).status).not.toBe("valid");
    expect(verifySelection(token, origin, key, 1000 + 31 * 86400_000).status).toBe("expired");
  });
  it("rejects tampering and oversized tokens", () => {
    const token = mintSelection("matt", origin, key, 1000);
    expect(verifySelection(token.slice(0, -1) + (token.endsWith("a") ? "b" : "a"), origin, key, 1001).status).not.toBe("valid");
    expect(verifySelection("x".repeat(1025), origin, key, 1001).status).toBe("invalid");
  });
  it("issues HttpOnly host cookies and clears them", () => {
    expect(selectionCookie("token", true)).toMatch(/HttpOnly; SameSite=Lax; Secure/);
    expect(selectionCookie(null, false)).toMatch(/Max-Age=0/);
  });
  it("keeps distinct local ports in distinct cookie namespaces", () => {
    const a = selectionCookieName("http://127.0.0.1:39976");
    const b = selectionCookieName("http://127.0.0.1:39977");
    expect(a).not.toBe(b);
    expect(selectionCookie("token", false, "http://127.0.0.1:39976")).toContain(`${a}=token`);
  });
  it("captures exactly one named cookie and rejects duplicate or oversized values", () => {
    expect(readNamedCookie(`other=1; ${SELECTION_COOKIE}=abc; tail=2`)).toBe("abc");
    expect(readNamedCookie(`${SELECTION_COOKIE}=a; ${SELECTION_COOKIE}=b`)).toBeNull();
    expect(readNamedCookie(`${SELECTION_COOKIE}=${"a".repeat(1025)}`)).toBeNull();
  });

  it("accepts JSON mutations when an iOS WebView omits Origin, but rejects a foreign Origin", () => {
    expect(identityMutationAllowed("application/json", undefined, origin)).toBe(true);
    expect(identityMutationAllowed("application/json; charset=utf-8", origin, origin)).toBe(true);
    expect(identityMutationAllowed("application/json", "https://evil.example", origin)).toBe(false);
    expect(identityMutationAllowed("text/plain", undefined, origin)).toBe(false);
  });

  it("issues bounded, one-time, expiring commit capabilities", () => {
    const commits = new SelectionCommitStore();
    const select = commits.issue({ action: "select", personId: "matt" }, 1_000);
    expect(commits.consume(select, 1_001)).toEqual({ action: "select", personId: "matt" });
    expect(commits.consume(select, 1_002)).toBeNull();
    const forget = commits.issue({ action: "forget" }, 2_000);
    expect(commits.consume(forget, 62_000)).toBeNull();
    expect(commits.consume("not-a-capability", 2_001)).toBeNull();
  });
});
