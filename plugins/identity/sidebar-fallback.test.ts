// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mountThreadStatusFallback,
  replaceThreadStatuses,
  type ThreadStatus,
} from "./sidebar-fallback.js";

const status: ThreadStatus = {
  icon: "UsersRound",
  label: "1 other viewer",
  tone: "default",
  badge: "1",
  badgeColor: "var(--success, #22c55e)",
};

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

function renderReplacementRow(threadId = "thread-1") {
  const row = document.createElement("div");
  row.setAttribute("data-parent-card", "");
  const anchor = document.createElement("a");
  anchor.setAttribute("data-sidebar-thread-id", threadId);
  row.append(anchor);
  document.body.append(row);
  return { anchor, row };
}

async function settleObserver() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("replacement sidebar presence fallback", () => {
  it("adds, updates, and removes a dot while retaining the native setter", async () => {
    const nativeSetter = vi.fn();
    const { anchor } = renderReplacementRow();
    dispose = mountThreadStatusFallback({ document, setNativeStatus: nativeSetter });

    replaceThreadStatuses(new Map([["thread-1", status]]));
    await settleObserver();
    expect(nativeSetter).toHaveBeenCalledWith("thread-1", {
      icon: "UsersRound",
      label: "1 other viewer",
      tone: "default",
    });
    expect(anchor.querySelector("[data-bb-presence-badge]")?.getAttribute("aria-label"))
      .toBe("1 other viewer");
    const badge = anchor.querySelector<HTMLElement>("[data-bb-presence-badge]");
    expect(badge?.textContent).toBe("1");
    expect(badge?.style.right).toBe("24px");
    expect(badge?.style.left).toBe("");

    const typingStatus: ThreadStatus = {
      icon: "Edit",
      label: "2 other viewers · 1 typing",
      tone: "running",
      badge: "2",
      badgeColor: "var(--warning, #f59e0b)",
    };
    replaceThreadStatuses(new Map([["thread-1", typingStatus]]));
    await settleObserver();
    expect(nativeSetter).toHaveBeenLastCalledWith("thread-1", {
      icon: "Edit",
      label: "2 other viewers · 1 typing",
      tone: "running",
    });
    expect(anchor.querySelector("[data-bb-presence-badge]")?.textContent).toBe("2");
    expect(anchor.querySelector<HTMLElement>("[data-bb-presence-badge]")?.style.background)
      .toContain("#f59e0b");

    replaceThreadStatuses(new Map());
    await settleObserver();
    expect(nativeSetter).toHaveBeenCalledWith("thread-1", null);
    expect(anchor.querySelector("[data-bb-presence-badge]")).toBeNull();
  });

  it("follows replacement-list rerenders and yields to a native status", async () => {
    dispose = mountThreadStatusFallback({ document });
    replaceThreadStatuses(new Map([["thread-1", status]]));

    const first = renderReplacementRow();
    await settleObserver();
    expect(first.anchor.querySelector("[data-bb-presence-badge]")).not.toBeNull();

    first.row.remove();
    const second = renderReplacementRow();
    await settleObserver();
    expect(second.anchor.querySelector("[data-bb-presence-badge]")).not.toBeNull();

    const nativeStatus = document.createElement("span");
    nativeStatus.setAttribute("aria-label", status.label);
    second.row.append(nativeStatus);
    await settleObserver();
    expect(second.anchor.querySelector("[data-bb-presence-badge]")).toBeNull();

    dispose();
    dispose = undefined;
    expect(document.querySelector("[data-bb-presence-badge]")).toBeNull();
  });
});

describe("ownership badges", () => {
  it("renders a starter's initials in its own colour, with no viewer count", async () => {
    const { anchor } = renderReplacementRow();
    dispose = mountThreadStatusFallback({ document });
    replaceThreadStatuses(new Map([["thread-1", {
      icon: "User",
      label: "Started by David",
      tone: "default",
      badge: "D",
      badgeColor: "var(--muted-foreground, #6b7280)",
    }]]));
    await settleObserver();
    const badge = anchor.querySelector<HTMLElement>("[data-bb-presence-badge]");
    expect(badge?.textContent).toBe("D");
    expect(badge?.style.background).toContain("#6b7280");
    expect(badge?.getAttribute("aria-label")).toBe("Started by David");
  });
});

describe("where the badge sits", () => {
  it("keeps the badge on-screen immediately before the host's trailing working glyph", async () => {
    const { anchor } = renderReplacementRow();
    dispose = mountThreadStatusFallback({ document });
    replaceThreadStatuses(new Map([["thread-1", status]]));
    await settleObserver();

    const badge = anchor.querySelector<HTMLElement>("[data-bb-presence-badge]");
    expect(badge).not.toBeNull();
    expect(badge?.style.right).toBe("24px");
    expect(Number.parseFloat(badge?.style.right ?? "NaN")).toBeGreaterThanOrEqual(0);
    expect(badge?.style.left).toBe("");
  });

  it("keeps the ownership colour in the badge without drawing a leading row bracket", async () => {
    const { anchor, row } = renderReplacementRow();
    dispose = mountThreadStatusFallback({ document });
    replaceThreadStatuses(new Map([["thread-1", { ...status, badgeColor: "hsl(210 55% 38%)" }]]));
    await settleObserver();
    expect(anchor.querySelector<HTMLElement>("[data-bb-presence-badge]")?.style.background)
      .toBe("rgb(44, 97, 150)");
    expect(row.style.boxShadow).toBe("");
    expect(row.hasAttribute("data-bb-ownership-tint")).toBe(false);
  });
});

describe("the badge must not sit on the title", () => {
  it("reserves trailing room for itself, leaving the title's beginning untouched", async () => {
    const { anchor, row } = renderReplacementRow();
    anchor.style.paddingRight = "6px";
    dispose = mountThreadStatusFallback({ document });
    replaceThreadStatuses(new Map([["thread-1", status]]));
    await settleObserver();

    const reserved = Number.parseFloat(anchor.style.paddingRight || "0");
    const badge = anchor.querySelector<HTMLElement>("[data-bb-presence-badge]");
    expect(reserved).toBeGreaterThanOrEqual(48);
    expect(anchor.style.paddingLeft).toBe("");

    replaceThreadStatuses(new Map());
    await settleObserver();
    // Not left behind on a row we do not own.
    expect(anchor.style.paddingRight).toBe("6px");
    expect(row.style.boxShadow).toBe("");
  });

  it("leaves a row the native glyph already handles alone", async () => {
    // Native rendering means bb positioned its own glyph properly; adding padding for a
    // badge we are not drawing would indent the row for nothing.
    const { anchor } = renderReplacementRow();
    const native = document.createElement("span");
    native.setAttribute("aria-label", status.label);
    anchor.append(native);
    dispose = mountThreadStatusFallback({ document });
    replaceThreadStatuses(new Map([["thread-1", status]]));
    await settleObserver();

    expect(anchor.querySelector("[data-bb-presence-badge]")).toBeNull();
    expect(anchor.style.paddingRight).toBe("");
  });
});

describe("badge ink follows the badge colour", () => {
  async function renderWith(badgeColor: string, badgeInk?: string) {
    const { anchor } = renderReplacementRow();
    dispose = mountThreadStatusFallback({ document });
    replaceThreadStatuses(new Map([["thread-1", {
      icon: "User", label: "Started by David", tone: "default" as const,
      badge: "D", badgeColor, ...(badgeInk === undefined ? {} : { badgeInk }),
    }]]));
    await settleObserver();
    return anchor.querySelector<HTMLElement>("[data-bb-presence-badge]");
  }

  it("uses the ink it was given, so a light chosen colour is still readable", async () => {
    // The real failure this prevents: initials in hardcoded white on a pale colour
    // somebody chose are invisible. The ink is decided from the fill (person-colors.ts)
    // and carried here rather than re-derived.
    const badge = await renderWith("#ffff99", "#111827");
    expect(badge?.style.color).toBe("rgb(17, 24, 39)");
  });

  it("uses white on a dark chosen colour", async () => {
    const badge = await renderWith("#111111", "#ffffff");
    expect(badge?.style.color).toBe("rgb(255, 255, 255)");
  });

  it("falls back to white when no ink was supplied, as presence badges always were", async () => {
    const badge = await renderWith("var(--success, #22c55e)");
    expect(badge?.style.color).toBe("white");
  });

  it("repaints the ink when the status changes colour, rather than keeping the old one", async () => {
    const { anchor } = renderReplacementRow();
    dispose = mountThreadStatusFallback({ document });
    const base = { icon: "User", label: "Started by David", tone: "default" as const, badge: "D" };
    replaceThreadStatuses(new Map([["thread-1", { ...base, badgeColor: "#111111", badgeInk: "#ffffff" }]]));
    await settleObserver();
    replaceThreadStatuses(new Map([["thread-1", { ...base, badgeColor: "#ffff99", badgeInk: "#111827" }]]));
    await settleObserver();
    expect(anchor.querySelector<HTMLElement>("[data-bb-presence-badge]")?.style.color)
      .toBe("rgb(17, 24, 39)");
  });
});
