// Run: npx vitest run tests/tab-id.test.ts
//
// ONE ADDRESS PER TAB, shared by the canvas panel and the presence strip.
//
// Before this existed the panel minted its own clientId in `useState` and the
// strip had none at all — so a canvas tab was one room member, and a tab on a
// thread was nobody. Giving the strip its own separate id would have made a
// canvas tab count TWICE in the roster (once as a sync member, once as a
// reporter) and shown one person as two. This module is the fix, and it is
// deliberately the smallest possible one: the same `newClientId()` the
// transport already mints, remembered.
import { describe, expect, it } from "vitest";
import { tabClientId } from "../canvas/tab-id.js";

describe("tabClientId", () => {
  it("is the same address every time it is asked", () => {
    // The panel asks on mount, the strip asks on every poll, and they must be
    // asking about the same tab.
    expect(tabClientId()).toBe(tabClientId());
  });

  it("looks like a client address", () => {
    expect(tabClientId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("survives a panel unmounting and remounting", () => {
    // A canvas panel that is closed and reopened is the same tab in the same
    // place; re-minting would leave a ghost member behind until the sweep.
    const first = tabClientId();
    expect(tabClientId()).toBe(first);
  });
});
