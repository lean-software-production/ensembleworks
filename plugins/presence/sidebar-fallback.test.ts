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
  viewers: 1,
  typing: 0,
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
    expect(badge?.style.left).toBe("-7px");

    const typingStatus: ThreadStatus = {
      icon: "Edit",
      label: "2 other viewers · 1 typing",
      tone: "running",
      viewers: 2,
      typing: 1,
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
