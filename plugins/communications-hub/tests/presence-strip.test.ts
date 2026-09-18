// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPresenceStrip, isSidebarShown, type MountedPresenceStrip } from "../src/presence/ui/mount.js";
import type { ParticipantView, PresenceView } from "../src/presence/view.js";

const NOW = 1_800_000_000_000;

function participant(overrides: Partial<ParticipantView> = {}): ParticipantView {
  return {
    id: "conversation-1:1",
    label: "Ada",
    initials: "AD",
    speaking: false,
    speakingMsRemaining: 0,
    camera: "unknown",
    portraitAt: null,
    ...overrides,
  };
}

function view(overrides: Partial<NonNullable<PresenceView["room"]>> = {}, rooms = [{ id: "room-1", name: "Team room" }]): PresenceView {
  return {
    rooms,
    selectedRoomId: rooms[0]?.id ?? null,
    room: {
      roomId: "room-1",
      roomName: "Team room",
      joinUrl: "https://zoom.us/j/12345",
      joinable: true,
      conversationId: "conversation-1",
      conversationTitle: "Team room · 2026-09-18 09:00Z",
      availability: "live",
      completeness: "partial",
      participants: [
        participant(),
        participant({ id: "conversation-1:2", label: "Sam", initials: "SA", speaking: true, speakingMsRemaining: 3_000 }),
        participant({ id: "conversation-1:3", label: "Ines", initials: "IN" }),
        participant({ id: "conversation-1:4", label: "Ravi", initials: "RA" }),
      ],
      knownCount: 4,
      portraits: false,
      updatedAt: NOW,
      status: "4 people seen here · list may be incomplete",
      ...overrides,
    },
    reason: "ok",
    generatedAt: NOW,
  };
}

/** bb's sidebar, reduced to the parts this feature actually depends on. */
function sidebar(options: { mobile?: boolean; visible?: boolean } = {}): HTMLElement {
  const wrapper = document.createElement("div");
  if (options.mobile) {
    wrapper.setAttribute("data-sidebar", "panel");
    wrapper.setAttribute("data-state", options.visible === false ? "closed" : "open");
  }
  const root = document.createElement("div");
  root.setAttribute("data-sidebar", "sidebar");
  const content = document.createElement("div");
  content.setAttribute("data-sidebar", "content");
  content.textContent = "thread list";
  const footer = document.createElement("div");
  footer.setAttribute("data-sidebar", "footer");
  footer.append(document.createElement("button"));
  root.append(content, footer);
  wrapper.append(root);
  document.body.append(wrapper);
  return wrapper;
}

interface Harness {
  strip: MountedPresenceStrip;
  controller: AbortController;
  calls: { method: string; input: unknown }[];
  answer(next: PresenceView): void;
  /** Make every later rpc call fail, as a dropped backend would. */
  breakRpc(): void;
  /** Let rpc answer again. */
  fixRpc(): void;
  /** Move the strip's own clock; nothing else advances it. */
  advance(ms: number): void;
}

const mounted: Harness[] = [];

function mount(options: {
  view?: PresenceView;
  width?: number;
  viewport?: { width: number; height: number };
  portrait?: { participantId: string; capturedAt: number; dataUrl: string } | null;
} = {}): Harness {
  let current = options.view ?? view();
  let broken = false;
  let clock = NOW;
  const calls: { method: string; input: unknown }[] = [];
  const controller = new AbortController();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    calls.push({ method, input: init?.body ? JSON.parse(String(init.body)) : null });
    if (broken) throw new Error("presence rpc is down");
    const result = method === "presence.portrait" ? options.portrait ?? null : current;
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result }),
    } as unknown as Response;
  }) as typeof fetch;
  const strip = mountPresenceStrip({
    document,
    pluginId: "communications-hub",
    signal: controller.signal,
    fetchImpl,
    now: () => clock,
    measure: () => options.width ?? 240,
    viewport: () => options.viewport ?? { width: 1_280, height: 900 },
    pollMs: 10_000,
  });
  const harness: Harness = {
    strip,
    controller,
    calls,
    answer(next) {
      current = next;
    },
    breakRpc() {
      broken = true;
    },
    fixRpc() {
      broken = false;
    },
    advance(ms) {
      clock += ms;
    },
  };
  mounted.push(harness);
  return harness;
}

/** Let the portrait fetch's promise chain settle. */
const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const row = () => document.querySelector<HTMLButtonElement>("#ewzp-row-root .ewzp-row");
const popover = () => document.querySelector<HTMLElement>("#ewzp-popover");

afterEach(() => {
  for (const harness of mounted.splice(0)) {
    harness.controller.abort();
    harness.strip.dispose();
  }
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  vi.restoreAllMocks();
});

describe("the presence row in bb's sidebar", () => {
  it("lands immediately above the footer, exactly once", async () => {
    sidebar();
    const harness = mount();
    await harness.strip.refresh();

    const footer = document.querySelector('[data-sidebar="footer"]')!;
    expect(footer.previousElementSibling?.id).toBe("ewzp-row-root");
    expect(document.querySelectorAll("#ewzp-row-root")).toHaveLength(1);
    // It is NOT inside the scrolling thread list, so the list keeps its own
    // scroll and its own height.
    expect(document.querySelector('[data-sidebar="content"]')!.contains(footer.previousElementSibling)).toBe(false);
  });

  it("lets the speaking ring expire without waiting for another answer", async () => {
    sidebar();
    const harness = mount();
    await harness.strip.refresh();
    expect(row()!.querySelector('.ewzp-face[data-speaking="true"]')).not.toBeNull();

    // No new poll, no new answer: just time passing past the hold the server
    // reported. The ring has to go out on the client's own clock, because the
    // server only ever sends a boolean that was true when it was asked.
    harness.advance(4_000);
    harness.strip.paint();
    expect(document.querySelector('#ewzp-row-root .ewzp-face[data-speaking="true"]')).toBeNull();
    // The person is still there — only the claim that they are talking expired.
    expect(row()!.querySelectorAll(".ewzp-face:not(.ewzp-more)")).toHaveLength(3);
  });

  it("stops showing people once polling has been failing for long enough", async () => {
    sidebar();
    const harness = mount();
    await harness.strip.refresh();
    expect(row()!.querySelectorAll(".ewzp-face:not(.ewzp-more)")).toHaveLength(3);

    harness.breakRpc();
    harness.advance(60_000);
    await harness.strip.refresh();

    // A minute of failed polls is not evidence that Ada is still in the room,
    // and a ring left glowing through it would be a lie.
    expect(document.querySelector('#ewzp-row-root .ewzp-face[data-speaking="true"]')).toBeNull();
    expect(row()!.querySelectorAll(".ewzp-face:not(.ewzp-more)")).toHaveLength(0);
    expect(row()!.getAttribute("aria-label")).toContain("Presence unavailable");
    expect(row()!.textContent).toContain("No updates");
    // The row stays put and the way into the room stays open.
    expect(row()!.textContent).toContain("Team room");
  });

  it("recovers the moment an answer arrives again", async () => {
    sidebar();
    const harness = mount();
    await harness.strip.refresh();
    harness.breakRpc();
    harness.advance(60_000);
    await harness.strip.refresh();
    expect(row()!.querySelectorAll(".ewzp-face:not(.ewzp-more)")).toHaveLength(0);

    harness.fixRpc();
    await harness.strip.refresh();
    expect(row()!.querySelectorAll(".ewzp-face:not(.ewzp-more)")).toHaveLength(3);
    expect(row()!.textContent).not.toContain("No updates");
  });

  it("is one line, one button, and holds no nested controls", async () => {
    sidebar();
    const harness = mount();
    await harness.strip.refresh();

    const control = row()!;
    expect(control.tagName).toBe("BUTTON");
    expect(control.type).toBe("button");
    expect(control.querySelectorAll("button, a, select, input")).toHaveLength(0);
    const sheet = document.querySelector("#ewzp-styles")!.textContent!;
    expect(sheet).toContain("height: 36px");
    expect(sheet).toContain("max-height: 36px");
  });

  it("shows three faces and an overflow count, marking the active speaker", async () => {
    sidebar();
    const harness = mount();
    await harness.strip.refresh();

    // Order is the hub's (speaker first — see presence-view.test.ts); the row
    // draws what it is given and truncates the tail into "+N".
    const faces = Array.from(row()!.querySelectorAll(".ewzp-face"));
    expect(faces.map((face) => face.textContent)).toEqual(["AD", "SA", "IN", "+1"]);
    expect(faces[1]!.getAttribute("data-speaking")).toBe("true");
    expect(faces[0]!.getAttribute("data-speaking")).toBe("false");
  });

  it("drops the room name in a narrow sidebar and the faces in bb's collapsed rail", async () => {
    sidebar();
    const narrow = mount({ width: 150 });
    await narrow.strip.refresh();
    expect(row()!.querySelector(".ewzp-name")!.hasAttribute("hidden")).toBe(true);
    expect(row()!.querySelectorAll(".ewzp-face")).toHaveLength(3); // two faces plus "+2"

    narrow.controller.abort();
    document.body.innerHTML = "";
    sidebar();
    const rail = mount({ width: 64 });
    await rail.strip.refresh();
    expect(row()!.querySelectorAll(".ewzp-face:not(.ewzp-more)")).toHaveLength(0);
    // A bare count, and no "+": with no faces beside it there is nothing to add to.
    expect(row()!.querySelector(".ewzp-count")!.textContent).toBe("4");
    expect(row()!.getAttribute("aria-label")).toContain("Team room");
  });

  it("names itself honestly for a screen reader", async () => {
    sidebar();
    const harness = mount();
    await harness.strip.refresh();

    expect(row()!.getAttribute("aria-label"))
      .toBe("Team room. 4 people seen here · list may be incomplete. Opens room details.");
    expect(row()!.getAttribute("aria-haspopup")).toBe("dialog");
    expect(row()!.getAttribute("aria-expanded")).toBe("false");
  });

  it("says what it knows when the stream is down, and shows nobody", async () => {
    sidebar();
    const harness = mount({
      view: view({
        availability: "interrupted",
        completeness: "unknown",
        participants: [],
        knownCount: 0,
        status: "Reconnecting — presence unavailable",
      }),
    });
    await harness.strip.refresh();

    expect(row()!.querySelectorAll(".ewzp-face:not(.ewzp-more)")).toHaveLength(0);
    expect(row()!.querySelector(".ewzp-note")!.textContent).toBe("Reconnecting");
    row()!.click();
    expect(popover()!.querySelector(".ewzp-empty")!.textContent)
      .toBe("Reconnecting. The last known participants are hidden until presence can be refreshed.");
  });

  it("offers the door rather than a count when there is no stream", async () => {
    sidebar();
    const harness = mount({
      view: view({
        availability: "unavailable",
        completeness: "unknown",
        participants: [],
        knownCount: 0,
        status: "No active stream — BB cannot tell who is here",
      }),
    });
    await harness.strip.refresh();

    expect(row()!.querySelector(".ewzp-note")!.textContent).toBe("Open Zoom");
    row()!.click();
    expect(popover()!.querySelector(".ewzp-empty")!.textContent)
      .toContain("without a live stream BB cannot tell who is here");
  });

  it("removes itself entirely when there is no room to show", async () => {
    sidebar();
    const harness = mount({
      view: { rooms: [], selectedRoomId: null, room: null, reason: "no-rooms", generatedAt: NOW },
    });
    await harness.strip.refresh();

    expect(document.querySelector("#ewzp-row-root")).toBeNull();
  });
});

describe("the presence popover", () => {
  it("opens with the keyboard, moves focus in, and returns it on Escape", async () => {
    sidebar();
    const harness = mount();
    await harness.strip.refresh();
    row()!.focus();

    // A <button> turns Enter and Space into a click; the strip adds nothing of
    // its own, which is why activation works for keyboard users at all.
    row()!.click();
    expect(popover()!.hidden).toBe(false);
    expect(row()!.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(popover()!.querySelector(".ewzp-close"));

    popover()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(popover()!.hidden).toBe(true);
    expect(document.activeElement).toBe(row());
  });

  it("closes on the close button and on a click elsewhere", async () => {
    sidebar();
    const harness = mount();
    await harness.strip.refresh();

    row()!.click();
    popover()!.querySelector<HTMLButtonElement>(".ewzp-close")!.click();
    expect(popover()!.hidden).toBe(true);
    expect(document.activeElement).toBe(row());

    row()!.click();
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(popover()!.hidden).toBe(true);
  });

  it("lists people with status that never invents a mute", async () => {
    sidebar();
    const harness = mount({
      view: view({
        participants: [
          participant({ label: "Ada", speaking: true, speakingMsRemaining: 3_000 }),
          participant({ id: "conversation-1:2", label: "Sam", camera: "off" }),
          participant({ id: "conversation-1:3", label: "Ines" }),
        ],
        knownCount: 3,
      }),
    });
    await harness.strip.refresh();
    row()!.click();

    const people = Array.from(popover()!.querySelectorAll(".ewzp-person"));
    expect(people.map((item) => item.querySelector(".ewzp-person-status")!.textContent))
      .toEqual(["Active speaker", "Camera off", "In room"]);
    expect(popover()!.textContent).not.toContain("Muted");
    expect(popover()!.querySelector(".ewzp-people")!.getAttribute("aria-label"))
      .toBe("People seen in Team room");
  });

  it("is bounded and scrollable rather than growing with the meeting", async () => {
    sidebar();
    const many = Array.from({ length: 40 }, (_, index) =>
      participant({ id: `conversation-1:${index}`, label: `Person ${index}` }));
    const harness = mount({ view: view({ participants: many, knownCount: many.length }) });
    await harness.strip.refresh();
    row()!.click();

    expect(popover()!.querySelectorAll(".ewzp-person")).toHaveLength(40);
    expect(Number.parseInt(popover()!.style.maxHeight, 10)).toBeLessThanOrEqual(340);
    const sheet = document.querySelector("#ewzp-styles")!.textContent!;
    expect(sheet).toContain("overflow-y: auto");
  });

  it("opens Zoom with the saved room link, in the user's own client", async () => {
    sidebar();
    const harness = mount();
    await harness.strip.refresh();
    row()!.click();

    const join = popover()!.querySelector<HTMLAnchorElement>(".ewzp-join")!;
    expect(join.getAttribute("href")).toBe("https://zoom.us/j/12345");
    expect(join.target).toBe("_blank");
    expect(join.rel).toBe("noopener noreferrer");
    // A link, not an embedded meeting: nothing here joins through a Meeting SDK.
    expect(join.tagName).toBe("A");
  });

  it("disables the Zoom link for a meeting that was deleted at the source", async () => {
    sidebar();
    const harness = mount({ view: view({ joinable: false }) });
    await harness.strip.refresh();
    row()!.click();

    const join = popover()!.querySelector<HTMLAnchorElement>(".ewzp-join")!;
    expect(join.hasAttribute("href")).toBe(false);
    expect(join.getAttribute("aria-disabled")).toBe("true");
    expect(popover()!.querySelector(".ewzp-footnote")!.textContent)
      .toContain("deleted at Zoom");
  });

  it("links to the current conversation when there is one, and hides the link otherwise", async () => {
    sidebar();
    const harness = mount();
    await harness.strip.refresh();
    row()!.click();

    const transcript = popover()!.querySelector<HTMLAnchorElement>(".ewzp-transcript")!;
    expect(transcript.getAttribute("href"))
      .toBe("/plugins/communications-hub/communications/conversation-1");
    expect(transcript.getAttribute("aria-label")).toContain("Team room · 2026-09-18 09:00Z");

    harness.answer(view({ conversationId: null, conversationTitle: null }));
    await harness.strip.refresh();
    expect(popover()!.querySelector<HTMLAnchorElement>(".ewzp-transcript")!.hidden).toBe(true);
  });

  it("keeps several rooms inside the popover rather than on the sidebar", async () => {
    sidebar();
    const harness = mount({
      view: view({}, [{ id: "room-1", name: "Team room" }, { id: "room-2", name: "Design review" }]),
    });
    await harness.strip.refresh();
    row()!.click();

    const select = popover()!.querySelector<HTMLSelectElement>("select")!;
    expect(Array.from(select.options).map((option) => option.textContent))
      .toEqual(["Team room", "Design review"]);
    expect(select.getAttribute("aria-label")).toBe("Room shown in the sidebar");
    // Two rooms, still one 36px row.
    expect(document.querySelectorAll("#ewzp-row-root .ewzp-row")).toHaveLength(1);

    select.value = "room-2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    expect(harness.calls.some((call) => call.method === "presence.select")).toBe(true);
  });

  it("hides the picker when there is only one room to pick", async () => {
    sidebar();
    const harness = mount();
    await harness.strip.refresh();
    row()!.click();
    expect(popover()!.querySelector(".ewzp-room-picker")!.hasAttribute("hidden")).toBe(true);
  });

  it("holds no nested buttons and cycles focus while it is open", async () => {
    sidebar();
    const harness = mount();
    await harness.strip.refresh();
    row()!.click();

    expect(popover()!.querySelectorAll("button button, a button, button a")).toHaveLength(0);
    const focusable = Array.from(popover()!.querySelectorAll<HTMLElement>('a[href], button, select'));
    focusable.at(-1)!.focus();
    popover()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(focusable[0]);
  });

  it("presents a portrait as the cached still it is", async () => {
    sidebar();
    const harness = mount({
      view: view({ portraits: true, participants: [participant({ portraitAt: NOW - 12_000 })], knownCount: 1 }),
      portrait: { participantId: "conversation-1:1", capturedAt: NOW - 12_000, dataUrl: "data:image/jpeg;base64,AA==" },
    });
    await harness.strip.refresh();
    await flush();
    row()!.click();

    const image = popover()!.querySelector<HTMLImageElement>(".ewzp-person img");
    expect(image?.getAttribute("alt")).toBe("Still image of Ada, captured 12s ago");
    expect(popover()!.querySelector(".ewzp-footnote")!.textContent)
      .toBe("Still images, captured while someone was speaking — not live video.");
  });

  it("drops a held still as soon as the feed behind it stops", async () => {
    sidebar();
    const harness = mount({
      view: view({ portraits: true, participants: [participant({ portraitAt: NOW - 1_000 })], knownCount: 1 }),
      portrait: { participantId: "conversation-1:1", capturedAt: NOW - 1_000, dataUrl: "data:image/jpeg;base64,AA==" },
    });
    await harness.strip.refresh();
    await flush();
    row()!.click();
    expect(popover()!.querySelector(".ewzp-person img")).not.toBeNull();

    // Video retired mid-sitting: a face must not keep showing a picture whose
    // feed has gone.
    harness.answer(view({ portraits: false, participants: [participant({ portraitAt: null })], knownCount: 1 }));
    await harness.strip.refresh();
    await flush();
    expect(popover()!.querySelector(".ewzp-person img")).toBeNull();
    expect(popover()!.querySelector(".ewzp-person .ewzp-face")!.textContent).toBe("AD");
  });

  it("never asks for an image when portraits are not running", async () => {
    sidebar();
    const harness = mount({ view: view({ participants: [participant({ portraitAt: NOW })], portraits: false }) });
    await harness.strip.refresh();
    await Promise.resolve();

    expect(harness.calls.some((call) => call.method === "presence.portrait")).toBe(false);
  });
});

describe("the strip's life in someone else's app", () => {
  it("re-attaches to a sidebar bb rebuilt, without leaving a second row", async () => {
    const first = sidebar();
    const harness = mount();
    await harness.strip.refresh();
    expect(document.querySelectorAll("#ewzp-row-root")).toHaveLength(1);

    // A route change: bb tears the sidebar down and builds a new one.
    first.remove();
    sidebar();
    harness.strip.syncAnchor();

    expect(document.querySelectorAll("#ewzp-row-root")).toHaveLength(1);
    expect(document.querySelector('[data-sidebar="footer"]')!.previousElementSibling!.id)
      .toBe("ewzp-row-root");
  });

  it("moves into the mobile drawer while it is open, and back out again", async () => {
    sidebar();
    const harness = mount();
    await harness.strip.refresh();

    const drawer = sidebar({ mobile: true });
    harness.strip.syncAnchor();
    expect(document.querySelectorAll("#ewzp-row-root")).toHaveLength(1);
    expect(drawer.contains(document.querySelector("#ewzp-row-root"))).toBe(true);

    drawer.setAttribute("data-state", "closed");
    harness.strip.syncAnchor();
    expect(drawer.contains(document.querySelector("#ewzp-row-root"))).toBe(false);
    expect(document.querySelectorAll("#ewzp-row-root")).toHaveLength(1);
  });

  it("returns to the position React shuffled it out of", async () => {
    sidebar();
    const harness = mount();
    await harness.strip.refresh();

    const footer = document.querySelector('[data-sidebar="footer"]')!;
    footer.parentElement!.append(document.querySelector("#ewzp-row-root")!);
    expect(footer.previousElementSibling!.id).not.toBe("ewzp-row-root");

    harness.strip.syncAnchor();
    expect(footer.previousElementSibling!.id).toBe("ewzp-row-root");
    expect(document.querySelectorAll("#ewzp-row-root")).toHaveLength(1);
  });

  it("leaves the document entirely on a route with no sidebar", async () => {
    const only = sidebar();
    const harness = mount();
    await harness.strip.refresh();

    only.remove();
    harness.strip.syncAnchor();
    expect(document.querySelector("#ewzp-row-root")).toBeNull();
    expect(popover()!.hidden).toBe(true);
  });

  it("takes its row, its popover and its stylesheet away when disposed", async () => {
    sidebar();
    const harness = mount();
    await harness.strip.refresh();
    row()!.click();

    harness.strip.dispose();
    expect(document.querySelector("#ewzp-row-root")).toBeNull();
    expect(document.querySelector("#ewzp-popover")).toBeNull();
    expect(document.querySelector("#ewzp-styles")).toBeNull();
  });

  it("stops polling once the host aborts the content-script generation", async () => {
    sidebar();
    const harness = mount();
    await harness.strip.refresh();
    const before = harness.calls.length;

    harness.controller.abort();
    await harness.strip.refresh();
    expect(harness.calls).toHaveLength(before);
  });

  it("keeps the last honest answer when a poll fails", async () => {
    sidebar();
    const harness = mount();
    await harness.strip.refresh();
    const label = row()!.getAttribute("aria-label");

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await harness.strip.refresh();
    expect(row()!.getAttribute("aria-label")).toBe(label);
  });
});

describe("which sidebar is actually on screen", () => {
  it("reads hidden-ness structurally, the way a closed drawer states it", () => {
    const wrapper = sidebar({ mobile: true, visible: false });
    const root = wrapper.querySelector('[data-sidebar="sidebar"]')!;
    expect(isSidebarShown(root)).toBe(false);

    wrapper.setAttribute("data-state", "open");
    expect(isSidebarShown(root)).toBe(true);

    wrapper.setAttribute("inert", "");
    expect(isSidebarShown(root)).toBe(false);
    wrapper.removeAttribute("inert");
    wrapper.setAttribute("aria-hidden", "true");
    expect(isSidebarShown(root)).toBe(false);
    wrapper.removeAttribute("aria-hidden");
    (wrapper as HTMLElement).style.display = "none";
    expect(isSidebarShown(root)).toBe(false);

    root.remove();
    expect(isSidebarShown(root)).toBe(false);
  });
});
