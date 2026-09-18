import { describe, expect, it } from "vitest";
import { PRESENCE_STALE_AFTER_MS, freshen } from "../src/presence/ui/freshness.js";
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

function view(participants: ParticipantView[]): PresenceView {
  return {
    rooms: [{ id: "room-1", name: "Team room" }],
    selectedRoomId: "room-1",
    room: {
      roomId: "room-1",
      roomName: "Team room",
      joinUrl: "https://zoom.us/j/12345",
      joinable: true,
      conversationId: "conversation-1",
      conversationTitle: "Team room",
      availability: "live",
      completeness: "partial",
      participants,
      knownCount: participants.length,
      portraits: true,
      updatedAt: NOW,
      status: "2 people seen here · list may be incomplete",
    },
    reason: "ok",
    generatedAt: NOW,
  };
}

describe("client-side freshness", () => {
  it("expires a speaking ring on the client's own clock", () => {
    const speaking = view([
      participant({ speaking: true, speakingMsRemaining: 3_000 }),
      participant({ id: "conversation-1:2", label: "Sam", initials: "SA" }),
    ]);

    // The server said "still speaking for another 3s" when it answered. Two
    // seconds later that is still true; four seconds later it is not, and no
    // new answer is needed to know it.
    expect(freshen(speaking, 2_000).view.room!.participants[0]!.speaking).toBe(true);
    expect(freshen(speaking, 4_000).view.room!.participants[0]!.speaking).toBe(false);
    expect(freshen(speaking, 4_000).stale).toBe(false);
  });

  it("never invents a ring the server did not report", () => {
    const quiet = view([participant({ speaking: false, speakingMsRemaining: 5_000 })]);
    expect(freshen(quiet, 0).view.room!.participants[0]!.speaking).toBe(false);
  });

  it("gives up on an answer that has stopped being refreshed", () => {
    const live = view([
      participant({ speaking: true, speakingMsRemaining: 3_000, portraitAt: NOW }),
      participant({ id: "conversation-1:2", label: "Sam", initials: "SA" }),
    ]);

    const fresh = freshen(live, PRESENCE_STALE_AFTER_MS - 1);
    expect(fresh.stale).toBe(false);
    expect(fresh.view.room!.participants).toHaveLength(2);

    const stale = freshen(live, PRESENCE_STALE_AFTER_MS);
    expect(stale.stale).toBe(true);
    // Nobody, no count, no portraits, and a sentence that says why rather than
    // a claim about the room.
    expect(stale.view.room!.participants).toEqual([]);
    expect(stale.view.room!.knownCount).toBe(0);
    expect(stale.view.room!.portraits).toBe(false);
    expect(stale.view.room!.status).toBe("Presence unavailable — BB is not getting updates");
    // The room itself, and the way into it, survive: those are not observations.
    expect(stale.view.room!.roomName).toBe("Team room");
    expect(stale.view.room!.joinUrl).toBe("https://zoom.us/j/12345");
    expect(stale.view.rooms).toEqual([{ id: "room-1", name: "Team room" }]);
  });

  it("leaves a view with no room alone", () => {
    const empty: PresenceView = {
      rooms: [],
      selectedRoomId: null,
      room: null,
      reason: "no-rooms",
      generatedAt: NOW,
    };
    expect(freshen(empty, 60_000)).toEqual({ view: empty, stale: true });
  });

  it("treats a negative age as no age at all", () => {
    const live = view([participant({ speaking: true, speakingMsRemaining: 1_000 })]);
    expect(freshen(live, -5_000).view.room!.participants[0]!.speaking).toBe(true);
    expect(freshen(live, -5_000).stale).toBe(false);
  });
});
