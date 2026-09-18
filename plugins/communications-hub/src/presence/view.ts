/**
 * What the sidebar is allowed to say about a room, assembled in one pure place.
 *
 * The strip is one line high and holds at most three faces, so almost every
 * decision it makes is a decision about what to LEAVE OUT. Those decisions live
 * here rather than in the DOM, because the interesting ones are about honesty
 * and a renderer is a bad place to keep an argument.
 *
 * ONE ROOM AT A TIME. A hub with five rooms still spends exactly 36px: the strip
 * shows the selected room and the popover is where the others are reachable.
 * Rooms never stack, so presence cannot grow into the thread list.
 *
 * AVAILABILITY IS NOT OCCUPANCY. "No active stream" and "nobody is here" are
 * different sentences and this view never confuses them: with no live capture
 * there is no participant list at all, and the copy says what is actually known
 * — that BB is not being told who is in the room.
 */

import { z } from "zod";
import type { PresenceParticipant, PresenceAvailability, RosterCompleteness } from "./roster.js";
import type { SittingPresence } from "./service.js";

export const participantViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  initials: z.string(),
  speaking: z.boolean(),
  camera: z.enum(["on", "off", "unknown"]),
  /** Present only when a still exists; it is a CACHED IMAGE, never live video. */
  portraitAt: z.number().nullable(),
});
export type ParticipantView = z.infer<typeof participantViewSchema>;

export const roomPresenceViewSchema = z.object({
  roomId: z.string(),
  roomName: z.string(),
  joinUrl: z.string(),
  /** False once the meeting was deleted at the source: every link into it died. */
  joinable: z.boolean(),
  conversationId: z.string().nullable(),
  conversationTitle: z.string().nullable(),
  availability: z.enum(["unavailable", "connecting", "live", "interrupted"]),
  completeness: z.enum(["unknown", "partial"]),
  participants: z.array(participantViewSchema),
  /** How many people we have SEEN. Never presented as the room's population. */
  knownCount: z.number().int().nonnegative(),
  /** True only while this sitting is actually receiving stills. */
  portraits: z.boolean(),
  updatedAt: z.number().nullable(),
  /** One line of honest status, already written for the row and the popover. */
  status: z.string(),
});
export type RoomPresenceView = z.infer<typeof roomPresenceViewSchema>;

export const presenceViewSchema = z.object({
  rooms: z.array(z.object({ id: z.string(), name: z.string() })),
  selectedRoomId: z.string().nullable(),
  room: roomPresenceViewSchema.nullable(),
  /** Why there is nothing to show, when there is nothing to show. */
  reason: z.enum(["ok", "no-rooms", "zoom-unconfigured"]),
  generatedAt: z.number(),
});
export type PresenceView = z.infer<typeof presenceViewSchema>;

/** The room fields this view needs; deliberately narrower than a hub Room. */
export interface PresenceRoomInput {
  readonly id: string;
  readonly name: string;
  readonly joinUrl: string;
  readonly sourceDeletedAt: number | null;
}

export interface PresenceViewInput {
  readonly rooms: readonly PresenceRoomInput[];
  /** What a human last chose in the popover, if anything. */
  readonly selectedRoomId: string | null;
  /** Live presence for the selected room, when a sitting is attached to it. */
  readonly presence: SittingPresence | null;
  /** The sitting to offer as "the current conversation", live or just ended. */
  readonly conversation: { id: string; title: string } | null;
  readonly zoomConfigured: boolean;
  readonly now: number;
}

/**
 * Resolve the selection.
 *
 * A stored choice wins while that room still exists; otherwise the first room
 * does, so a deleted or archived room cannot leave the strip pointing at
 * nothing. Exported because "which room am I looking at" is the one piece of
 * state a human changes by hand, and it deserves its own test.
 */
export function selectRoom<T extends { id: string }>(rooms: readonly T[], selectedRoomId: string | null): T | null {
  if (selectedRoomId !== null) {
    const chosen = rooms.find((room) => room.id === selectedRoomId);
    if (chosen) return chosen;
  }
  return rooms[0] ?? null;
}

/**
 * The sentence under the room name.
 *
 * Every branch here was written to be defensible out loud:
 *
 * - live, people seen → "3 people seen here" plus "list may be incomplete",
 *   because we only ever observed arrivals and departures from the moment we
 *   connected. Never "3 in the room".
 * - live, nobody seen → "Nobody seen speaking or joining yet", which is what we
 *   know. It is not "the room is empty".
 * - interrupted → "Reconnecting — presence unavailable", and the roster is gone
 *   rather than frozen.
 * - no capture → "No active stream — BB cannot tell who is here".
 */
export function presenceStatus(
  availability: PresenceAvailability,
  completeness: RosterCompleteness,
  knownCount: number,
): string {
  if (availability === "unavailable") return "No active stream — BB cannot tell who is here";
  if (availability === "interrupted") return "Reconnecting — presence unavailable";
  if (availability === "connecting") return "Connecting to the meeting stream";
  if (knownCount === 0) return "Nobody seen joining or speaking yet";
  const people = `${knownCount} ${knownCount === 1 ? "person" : "people"} seen here`;
  return completeness === "partial" ? `${people} · list may be incomplete` : people;
}

function participantView(participant: PresenceParticipant): ParticipantView {
  return {
    id: participant.id,
    label: participant.label,
    initials: participant.initials,
    speaking: participant.speaking,
    camera: participant.camera,
    portraitAt: participant.portraitAt,
  };
}

/**
 * Order the faces the strip has room for.
 *
 * The active speaker first, then whoever spoke most recently, then join order.
 * A three-face strip that never shows the person currently talking would be
 * decoration; this makes the truncation carry the useful information.
 */
export function orderParticipants(participants: readonly PresenceParticipant[]): PresenceParticipant[] {
  return [...participants].sort((left, right) => {
    if (left.speaking !== right.speaking) return left.speaking ? -1 : 1;
    const spoke = (right.lastSpokeAt ?? -1) - (left.lastSpokeAt ?? -1);
    if (spoke !== 0) return spoke;
    return left.joinedAt - right.joinedAt || left.id.localeCompare(right.id);
  });
}

export function buildPresenceView(input: PresenceViewInput): PresenceView {
  const rooms = input.rooms.map((room) => ({ id: room.id, name: room.name }));
  const selected = selectRoom(input.rooms, input.selectedRoomId);
  if (!selected) {
    return {
      rooms,
      selectedRoomId: null,
      room: null,
      reason: input.zoomConfigured ? "no-rooms" : "zoom-unconfigured",
      generatedAt: input.now,
    };
  }
  // Presence belonging to another room is not this room's presence. It can
  // happen for a beat while a new sitting is being installed, and showing it
  // would put strangers under this room's name.
  const presence = input.presence?.roomId === selected.id ? input.presence : null;
  const availability: PresenceAvailability = presence?.availability ?? "unavailable";
  const completeness: RosterCompleteness = presence?.completeness ?? "unknown";
  const participants = orderParticipants(presence?.participants ?? []);
  return {
    rooms,
    selectedRoomId: selected.id,
    room: {
      roomId: selected.id,
      roomName: selected.name,
      joinUrl: selected.joinUrl,
      joinable: selected.sourceDeletedAt === null,
      conversationId: input.conversation?.id ?? null,
      conversationTitle: input.conversation?.title ?? null,
      availability,
      completeness,
      participants: participants.map(participantView),
      knownCount: participants.length,
      portraits: presence?.portraits ?? false,
      updatedAt: presence?.updatedAt ?? null,
      status: presenceStatus(availability, completeness, participants.length),
    },
    reason: "ok",
    generatedAt: input.now,
  };
}
