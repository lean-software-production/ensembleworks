/**
 * Who the hub believes is in one sitting, right now.
 *
 * Presence is EPHEMERAL: it lives in memory for the lifetime of a sitting and is
 * never written to the transcript database. A restarted plugin knows nobody,
 * which is the truthful answer — it has not observed anyone.
 *
 * Three rules shape everything here, and each one exists because the opposite is
 * a lie the UI would otherwise tell:
 *
 * 1. IDENTITY IS (SITTING, PARTICIPANT ID), NEVER A NAME. Display names are
 *    self-asserted free text: two people can share one and one person can change
 *    theirs mid-meeting. Source participant ids are only unique WITHIN one
 *    occurrence — Zoom's counter starts from the same base every meeting, so the
 *    same id in two sittings is two different people (docs/zoom-setup.md,
 *    2026-09-12). The roster is therefore per-sitting and its ids are scoped to
 *    it.
 *
 * 2. THE LIST IS NEVER CLAIMED COMPLETE. We observe joins and leaves from the
 *    moment we connect; anyone already present when we connected is invisible to
 *    us unless they do something. Whether RTMS replays an initial roster is not
 *    established (see docs/zoom-setup.md "Presence events"), so completeness is
 *    "partial" at best and "unknown" before the first observation. There is
 *    deliberately no "complete" value to reach for.
 *
 * 3. AN ACTIVE-SPEAKER EVENT IS AN INSTANT, NOT A STATE. It says "this person
 *    became the active speaker at T", which is not evidence that they are still
 *    talking a minute later. Speaking therefore decays: it holds for
 *    SPEAKING_HOLD_MS and is dropped the moment somebody else takes over, when
 *    capture stops being live, or when the roster resets. Silence is never
 *    turned into a mute state — we do not know whether anyone is muted.
 */

/** Live-ness of the presence signal itself, distinct from who is in the room. */
export type PresenceAvailability = "unavailable" | "connecting" | "live" | "interrupted";

/**
 * How much of the participant list we can honestly claim.
 *
 * "unknown" — nothing observed in this sitting yet (or the signal is not live).
 * "partial" — some participants observed; there may be others we never saw.
 * There is no third value: see rule 2 above.
 */
export type RosterCompleteness = "unknown" | "partial";

export type CameraState = "on" | "off" | "unknown";

/** An observation from a source adapter, already stripped of wire specifics. */
export type PresenceEvent =
  | { kind: "joined"; participantId: string; name: string | null; at: number }
  | { kind: "left"; participantId: string; at: number }
  | { kind: "speaking"; participantId: string; name?: string | null; at: number }
  | { kind: "camera"; participantId: string; on: boolean; at: number }
  | { kind: "portrait"; participantId: string; capturedAt: number };

export interface PresenceParticipant {
  /** Sitting-scoped identity. Safe to hand to a client; meaningless elsewhere. */
  readonly id: string;
  /** The identity the source reported, kept for adapter-side correlation only. */
  readonly sourceId: string;
  /** What the source claims this person is called. Not identity. */
  readonly name: string | null;
  /** Display-ready and unambiguous: shared names are numbered by join order. */
  readonly label: string;
  readonly initials: string;
  readonly joinedAt: number;
  readonly lastSpokeAt: number | null;
  /** True only inside the decay window, and only while the signal is live. */
  readonly speaking: boolean;
  /**
   * How much of the decay window is left, in ms, at the moment asked.
   *
   * Sent on so a CLIENT can expire the ring on its own clock. A boolean alone
   * is only true of the instant it was computed: a client that polls, or whose
   * polls start failing, would otherwise hold a ring lit for as long as it
   * holds the answer.
   */
  readonly speakingMsRemaining: number;
  readonly camera: CameraState;
  /** When the newest accepted still for this person was captured, if any. */
  readonly portraitAt: number | null;
}

/** How long one active-speaker event is allowed to keep a ring lit. */
export const SPEAKING_HOLD_MS = 3_000;

/** Bounds one sitting's memory. A meeting larger than this reports "partial". */
export const MAX_PARTICIPANTS = 300;

interface Member {
  sourceId: string;
  name: string | null;
  joinedAt: number;
  lastSpokeAt: number | null;
  speakingUntil: number;
  camera: CameraState;
  portraitAt: number | null;
}

const UNNAMED = "Unnamed participant";

function cleanName(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ").slice(0, 120);
  return trimmed.length > 0 ? trimmed : null;
}

/** Two visible characters for a face, or "?" when the source gave us no name. */
export function initialsOf(name: string | null): string {
  if (name === null) return "?";
  const words = name.split(" ").filter((word) => word.length > 0);
  const first = [...(words[0] ?? "")][0] ?? "";
  const second = words.length > 1 ? [...(words.at(-1) ?? "")][0] ?? "" : [...(words[0] ?? "")][1] ?? "";
  const initials = `${first}${second}`.trim().toLocaleUpperCase();
  return initials.length > 0 ? initials : "?";
}

export class SittingRoster {
  private readonly members = new Map<string, Member>();
  private availability: PresenceAvailability = "connecting";
  private observed = false;
  private updatedAt: number | null = null;

  constructor(
    /** The sitting this roster belongs to. Participant ids are scoped by it. */
    readonly sittingKey: string,
    private readonly now: () => number,
    private readonly speakingHoldMs: number = SPEAKING_HOLD_MS,
  ) {}

  get state(): PresenceAvailability {
    return this.availability;
  }

  get lastChangeAt(): number | null {
    return this.updatedAt;
  }

  get completeness(): RosterCompleteness {
    return this.availability === "live" && this.observed ? "partial" : "unknown";
  }

  /**
   * Move the signal between states, and decide what survives the move.
   *
   * Leaving "live" clears every speaking hold at once: a ring that kept glowing
   * through a dropped connection would be claiming knowledge the socket no
   * longer has. Coming BACK to live wipes the roster instead of resuming it —
   * we cannot know who left while we were not listening, and a ghost in the
   * strip is worse than an empty one that fills up again within seconds.
   */
  setAvailability(next: PresenceAvailability, at: number = this.now()): void {
    if (next === this.availability) return;
    const wasLive = this.availability === "live";
    this.availability = next;
    this.updatedAt = at;
    if (next !== "live") {
      for (const member of this.members.values()) member.speakingUntil = 0;
      return;
    }
    if (wasLive) return;
    this.members.clear();
    this.observed = false;
  }

  apply(event: PresenceEvent): void {
    // A sitting that has ended, or one whose signal is down, is not a place
    // where observations can be trusted: they describe a session we are no
    // longer attached to.
    if (this.availability === "unavailable" || this.availability === "interrupted") return;
    const id = event.participantId.trim().slice(0, 200);
    if (!id) return;
    // A portrait carries the moment the picture was taken, not the moment the
    // roster changed, so it is not evidence about membership freshness.
    this.updatedAt = event.kind === "portrait" ? this.updatedAt : event.at;
    switch (event.kind) {
      case "joined": {
        this.observed = true;
        this.upsert(id, cleanName(event.name), event.at);
        return;
      }
      case "left": {
        this.observed = true;
        this.members.delete(id);
        return;
      }
      case "speaking": {
        this.observed = true;
        // An active speaker we never saw join is evidence of a participant, not
        // a reason to discard the observation: it is exactly the case rule 2
        // warns about, so record them and stay "partial".
        const member = this.upsert(id, cleanName(event.name), event.at);
        if (!member) return;
        for (const other of this.members.values()) other.speakingUntil = 0;
        member.lastSpokeAt = event.at;
        member.speakingUntil = event.at + this.speakingHoldMs;
        return;
      }
      case "camera": {
        // A camera event is an observation of a participant, the same way an
        // active-speaker event is: Zoom names someone whose camera changed, and
        // that they are in the meeting follows. Someone we never saw join is
        // exactly the case rule 2 warns about, so record them and stay
        // "partial" rather than discarding what we were told.
        this.observed = true;
        const member = this.upsert(id, null, event.at);
        if (!member) return;
        member.camera = event.on ? "on" : "off";
        return;
      }
      case "portrait": {
        const member = this.members.get(id);
        if (!member) return;
        member.portraitAt = event.capturedAt;
        return;
      }
    }
  }

  /** Drop a still we can no longer serve (evicted, or its sitting ended). */
  forgetPortrait(participantId: string): void {
    const member = this.members.get(participantId);
    if (member) member.portraitAt = null;
  }

  /** Drop every still at once: the feed that produced them has retired. */
  forgetPortraits(): void {
    for (const member of this.members.values()) member.portraitAt = null;
  }

  /**
   * The list as it stands at `at`.
   *
   * A signal that is not live exposes NOBODY. The last people we saw are not
   * evidence about the room now, and showing them under a "reconnecting" banner
   * is precisely the ghost this feature is not allowed to leave behind.
   */
  participants(at: number = this.now()): PresenceParticipant[] {
    if (this.availability !== "live") return [];
    const ordered = [...this.members.entries()].sort((left, right) =>
      left[1].joinedAt - right[1].joinedAt || left[0].localeCompare(right[0]));
    const totals = new Map<string, number>();
    for (const [, member] of ordered) {
      const key = (member.name ?? UNNAMED).toLocaleLowerCase();
      totals.set(key, (totals.get(key) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    return ordered.map(([id, member]) => {
      const name = member.name;
      const key = (name ?? UNNAMED).toLocaleLowerCase();
      const ordinal = (seen.get(key) ?? 0) + 1;
      seen.set(key, ordinal);
      const shared = (totals.get(key) ?? 0) > 1;
      return {
        id: `${this.sittingKey}:${id}`,
        sourceId: id,
        name,
        // Two people called "Alex" are two people, and a UI that shows one
        // "Alex" twice is unreadable. Numbering is by join order, so a label
        // does not change under someone as others arrive.
        label: shared ? `${name ?? UNNAMED} (${ordinal})` : name ?? UNNAMED,
        initials: initialsOf(name),
        joinedAt: member.joinedAt,
        lastSpokeAt: member.lastSpokeAt,
        speaking: at < member.speakingUntil,
        speakingMsRemaining: Math.max(0, member.speakingUntil - at),
        camera: member.camera,
        portraitAt: member.portraitAt,
      };
    });
  }

  private upsert(id: string, name: string | null, at: number): Member | null {
    const existing = this.members.get(id);
    if (existing) {
      // A rename mid-meeting is allowed; it changes the label, never identity.
      if (name !== null) existing.name = name;
      return existing;
    }
    if (this.members.size >= MAX_PARTICIPANTS) return null;
    const member: Member = {
      sourceId: id,
      name,
      joinedAt: at,
      lastSpokeAt: null,
      speakingUntil: 0,
      camera: "unknown",
      portraitAt: null,
    };
    this.members.set(id, member);
    return member;
  }
}
