/**
 * What the row and the popover say, decided before any DOM exists.
 *
 * Every string a human reads is chosen here, on purpose. The strip is small
 * enough that its copy IS its design, and the difference between "4 in the room"
 * and "4 people seen here" is the difference between a claim we cannot support
 * and one we can.
 */

import type { ParticipantView, PresenceView } from "../view.js";
import { facesForTier, type StripTier } from "./layout.js";

export type PresenceDot = "live" | "connecting" | "interrupted" | "idle";

export interface FaceModel {
  readonly id: string;
  readonly initials: string;
  readonly label: string;
  readonly speaking: boolean;
  readonly portraitAt: number | null;
}

export interface RowModel {
  /** False when there is nothing honest to show; the row is removed, not blanked. */
  readonly present: boolean;
  readonly tier: StripTier;
  readonly roomName: string;
  readonly showName: boolean;
  readonly dot: PresenceDot;
  readonly faces: FaceModel[];
  readonly overflow: number;
  /** Trailing text when there are no faces to show. */
  readonly note: string | null;
  /** The count the collapsed rail shows instead of faces. */
  readonly count: number;
  readonly ariaLabel: string;
  readonly expanded: boolean;
}

export interface PersonModel {
  readonly id: string;
  readonly label: string;
  readonly initials: string;
  readonly status: string;
  readonly speaking: boolean;
  readonly portraitAt: number | null;
  /** Says out loud that a face is a cached still, never a live camera. */
  readonly portraitHint: string | null;
}

export interface PopoverModel {
  readonly title: string;
  readonly status: string;
  readonly dot: PresenceDot;
  readonly rooms: readonly { id: string; name: string }[];
  readonly selectedRoomId: string | null;
  readonly people: PersonModel[];
  readonly emptyMessage: string | null;
  readonly joinUrl: string | null;
  readonly joinable: boolean;
  readonly joinNote: string | null;
  readonly conversationHref: string | null;
  readonly conversationLabel: string | null;
  readonly portraitNote: string | null;
}

function dotFor(view: PresenceView): PresenceDot {
  const availability = view.room?.availability ?? "unavailable";
  if (availability === "live") return "live";
  if (availability === "connecting") return "connecting";
  if (availability === "interrupted") return "interrupted";
  return "idle";
}

/**
 * The trailing word on a row with no faces.
 *
 * "Open Zoom" is an invitation, not a status: with no stream we genuinely do not
 * know whether anybody is in there, and the useful thing to offer is the door.
 */
function rowNote(view: PresenceView): string | null {
  switch (view.room?.availability) {
    case "live":
      return view.room.knownCount === 0 ? "Nobody seen yet" : null;
    case "connecting":
      return "Connecting";
    case "interrupted":
      return "Reconnecting";
    default:
      return "Open Zoom";
  }
}

export function rowModel(view: PresenceView, tier: StripTier, expanded = false): RowModel {
  const room = view.room;
  const empty: RowModel = {
    present: false,
    tier,
    roomName: "",
    showName: false,
    dot: "idle",
    faces: [],
    overflow: 0,
    note: null,
    count: 0,
    ariaLabel: "",
    expanded,
  };
  if (!room) return empty;
  const capacity = facesForTier(tier);
  const visible = room.participants.slice(0, capacity);
  return {
    present: true,
    tier,
    roomName: room.roomName,
    showName: tier === "full",
    dot: dotFor(view),
    faces: visible.map((participant) => ({
      id: participant.id,
      initials: participant.initials,
      label: participant.label,
      speaking: participant.speaking,
      portraitAt: participant.portraitAt,
    })),
    overflow: Math.max(0, room.participants.length - visible.length),
    note: rowNote(view),
    count: room.knownCount,
    // One sentence, and every clause in it is something we can defend: which
    // room, what we actually know about it, and what the control does.
    ariaLabel: `${room.roomName}. ${room.status}. Opens room details.`,
    expanded,
  };
}

function personStatus(participant: ParticipantView): string {
  if (participant.speaking) return "Active speaker";
  if (participant.camera === "off") return "Camera off";
  if (participant.camera === "on") return "Camera on";
  // Deliberately not "muted" or "silent": an absence of speech is not evidence
  // of a microphone state, and we are never told one.
  return "In room";
}

function ago(from: number, now: number): string {
  const elapsed = Math.max(0, now - from);
  if (elapsed < 10_000) return "just now";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  return `${Math.floor(elapsed / 3_600_000)}h ago`;
}

function emptyMessage(view: PresenceView): string | null {
  if (!view.room) {
    return view.reason === "zoom-unconfigured"
      ? "Zoom capture is not configured yet."
      : "No meeting rooms yet. Create one in Communications.";
  }
  switch (view.room.availability) {
    case "live":
      return view.room.knownCount === 0
        ? "Nobody has joined or spoken since BB connected to this meeting."
        : null;
    case "connecting":
      return "Connecting to the meeting stream.";
    case "interrupted":
      return "Reconnecting. The last known participants are hidden until presence can be refreshed.";
    default:
      return "No active stream. Open Zoom to join — without a live stream BB cannot tell who is here.";
  }
}

export function popoverModel(
  view: PresenceView,
  options: { pluginId: string; now: number },
): PopoverModel {
  const room = view.room;
  const people = (room?.participants ?? []).map((participant) => ({
    id: participant.id,
    label: participant.label,
    initials: participant.initials,
    status: personStatus(participant),
    speaking: participant.speaking,
    portraitAt: participant.portraitAt,
    portraitHint: participant.portraitAt === null
      ? null
      : `Still image of ${participant.label}, captured ${ago(participant.portraitAt, options.now)}`,
  }));
  return {
    title: room?.roomName ?? "Zoom presence",
    status: room?.status ?? "No room selected",
    dot: dotFor(view),
    rooms: view.rooms,
    selectedRoomId: view.selectedRoomId,
    people,
    emptyMessage: emptyMessage(view),
    joinUrl: room?.joinUrl ?? null,
    joinable: room?.joinable ?? false,
    joinNote: room && !room.joinable
      ? "This meeting was deleted at Zoom, so its links no longer work."
      : null,
    // A real in-app link, so the browser's own middle-click, copy-link and
    // status bar all behave without the strip doing anything clever.
    conversationHref: room?.conversationId
      ? `/plugins/${encodeURIComponent(options.pluginId)}/communications/${encodeURIComponent(room.conversationId)}`
      : null,
    conversationLabel: room?.conversationTitle ?? null,
    portraitNote: room?.portraits && people.some((person) => person.portraitAt !== null)
      ? "Still images, captured while someone was speaking — not live video."
      : null,
  };
}
