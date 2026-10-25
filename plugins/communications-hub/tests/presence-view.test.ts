import { describe, expect, it } from "vitest";
import { buildPresenceView, presenceStatus, selectRoom, orderParticipants } from "../src/presence/view.js";
import type { SittingPresence } from "../src/presence/service.js";
import type { PresenceParticipant } from "../src/presence/roster.js";

const NOW = 1_800_000_000_000;

const rooms = [
  { id: "room-1", name: "Team room", joinUrl: "https://zoom.us/j/1", sourceDeletedAt: null },
  { id: "room-2", name: "Design review", joinUrl: "https://zoom.us/j/2", sourceDeletedAt: null },
];

function person(overrides: Partial<PresenceParticipant> = {}): PresenceParticipant {
  return {
    id: "conversation-1:1",
    sourceId: "1",
    name: "Ada",
    label: "Ada",
    initials: "AD",
    joinedAt: NOW,
    lastSpokeAt: null,
    speaking: false,
    speakingMsRemaining: 0,
    camera: "unknown",
    portraitAt: null,
    ...overrides,
  };
}

function presence(overrides: Partial<SittingPresence> = {}): SittingPresence {
  return {
    sittingKey: "conversation-1",
    roomId: "room-1",
    availability: "live",
    completeness: "partial",
    participants: [person()],
    updatedAt: NOW,
    portraits: false,
    ...overrides,
  };
}

describe("presence view", () => {
  it("spends one row on one room, whatever the hub has", () => {
    const view = buildPresenceView({
      rooms, selectedRoomId: null, presence: presence(), conversation: null, zoomConfigured: true, now: NOW,
    });
    expect(view.rooms).toHaveLength(2);
    // The other rooms are reachable in the popover; the strip never stacks.
    expect(view.room?.roomId).toBe("room-1");
    expect(view.selectedRoomId).toBe("room-1");
  });

  it("honours a human's choice, and falls back when that room is gone", () => {
    expect(selectRoom(rooms, "room-2")?.id).toBe("room-2");
    expect(selectRoom(rooms, "room-missing")?.id).toBe("room-1");
    expect(selectRoom([], "room-1")).toBeNull();
  });

  it("says no active stream rather than an empty room", () => {
    const view = buildPresenceView({
      rooms, selectedRoomId: "room-1", presence: null,
      conversation: { id: "conversation-9", title: "Yesterday" }, zoomConfigured: true, now: NOW,
    });
    expect(view.room?.availability).toBe("unavailable");
    expect(view.room?.participants).toEqual([]);
    expect(view.room?.status).toBe("No active stream — BB cannot tell who is here");
    // The last sitting is still reachable: a meeting that just ended is exactly
    // when somebody wants to read it.
    expect(view.room?.conversationId).toBe("conversation-9");
  });

  it("never presents a count as the room's population", () => {
    expect(presenceStatus("live", "partial", 3)).toBe("3 people seen here · list may be incomplete");
    expect(presenceStatus("live", "partial", 1)).toBe("1 person seen here · list may be incomplete");
    expect(presenceStatus("live", "unknown", 0)).toBe("Nobody seen joining or speaking yet");
    expect(presenceStatus("interrupted", "unknown", 0)).toBe("Reconnecting — presence unavailable");
    expect(presenceStatus("connecting", "unknown", 0)).toBe("Connecting to the meeting stream");
    expect(presenceStatus("unavailable", "unknown", 0)).toBe("No active stream — BB cannot tell who is here");
  });

  it("refuses to show one room the presence of another", () => {
    const view = buildPresenceView({
      rooms, selectedRoomId: "room-2", presence: presence({ roomId: "room-1" }),
      conversation: null, zoomConfigured: true, now: NOW,
    });
    expect(view.room?.roomId).toBe("room-2");
    expect(view.room?.participants).toEqual([]);
    expect(view.room?.availability).toBe("unavailable");
  });

  it("marks a room whose Zoom meeting was deleted as unjoinable", () => {
    const view = buildPresenceView({
      rooms: [{ ...rooms[0]!, sourceDeletedAt: NOW }], selectedRoomId: null, presence: null,
      conversation: null, zoomConfigured: true, now: NOW,
    });
    expect(view.room?.joinable).toBe(false);
  });

  it("explains an empty strip", () => {
    expect(buildPresenceView({
      rooms: [], selectedRoomId: null, presence: null, conversation: null, zoomConfigured: true, now: NOW,
    })).toMatchObject({ room: null, reason: "no-rooms" });
    expect(buildPresenceView({
      rooms: [], selectedRoomId: null, presence: null, conversation: null, zoomConfigured: false, now: NOW,
    })).toMatchObject({ room: null, reason: "zoom-unconfigured" });
  });

  it("puts the people worth seeing first, because only three faces fit", () => {
    const ordered = orderParticipants([
      person({ id: "a", label: "A", joinedAt: 1 }),
      person({ id: "b", label: "B", joinedAt: 2, lastSpokeAt: NOW - 5_000 }),
      person({ id: "c", label: "C", joinedAt: 3, speaking: true, lastSpokeAt: NOW }),
    ]);
    expect(ordered.map((entry) => entry.label)).toEqual(["C", "B", "A"]);
  });

  it("carries a portrait stamp through without carrying an image", () => {
    const view = buildPresenceView({
      rooms, selectedRoomId: "room-1",
      presence: presence({ portraits: true, participants: [person({ portraitAt: NOW })] }),
      conversation: null, zoomConfigured: true, now: NOW,
    });
    expect(view.room?.participants[0]!.portraitAt).toBe(NOW);
    // A poll must never carry image bytes: the stamp is all a client needs to
    // know a fresh still exists.
    expect(JSON.stringify(view)).not.toContain("data:image");
  });
});
