/**
 * Ephemeral presence for the sittings this hub is currently attached to.
 *
 * The hub-facing vocabulary is deliberately generic: a SITTING key (the hub's
 * own conversation id), a SESSION token (an opaque generation supplied by the
 * adapter), and participants with hub ids. No meeting uuid, stream id, user id
 * or media type reaches this file — those stay inside the source adapter, which
 * is the rule the whole plugin is built on.
 *
 * The service exists to answer one question truthfully — "what does this room
 * look like right now?" — and to make the wrong answers unreachable:
 *
 * - A LATE MESSAGE FROM A SUPERSEDED SESSION cannot mutate anything. Every
 *   write carries its session token and is dropped unless it matches the one
 *   currently installed for that sitting. A socket that reconnects, or a stream
 *   that Zoom replaces mid-meeting, therefore cannot resurrect people from the
 *   session it replaced.
 * - A FINISHED SITTING HOLDS NOBODY. `endSitting` deletes the roster and its
 *   stills together, so "the meeting ended" and "the meeting is empty" are not
 *   the same state, and neither one leaves a face on screen.
 * - A DELETED OR ARCHIVED ROOM FORGETS ITS PEOPLE immediately, without waiting
 *   for a socket to notice.
 * - PLUGIN TEARDOWN DROPS EVERYTHING. Nothing here is persisted, so a reloaded
 *   plugin starts by knowing nobody rather than by believing something old.
 */

import {
  SittingRoster,
  type PresenceAvailability,
  type PresenceEvent,
  type PresenceParticipant,
  type RosterCompleteness,
} from "./roster.js";
import { PortraitStore, type PortraitFrame, type PortraitImage, type PortraitResult } from "./portraits.js";

/** What one sitting looks like to the hub, with no source detail in sight. */
export interface SittingPresence {
  readonly sittingKey: string;
  readonly roomId: string | null;
  readonly availability: PresenceAvailability;
  readonly completeness: RosterCompleteness;
  readonly participants: PresenceParticipant[];
  readonly updatedAt: number | null;
  /** True only when this sitting is actually receiving stills. */
  readonly portraits: boolean;
}

/**
 * The half of the service a source adapter is allowed to see.
 *
 * Adapters depend on this interface rather than on `PresenceService`, the same
 * way they depend on `TranscriptSink` rather than on the hub: an adapter can
 * report what it observed and can never read the room back, select a room, or
 * serve an image.
 */
export interface PresenceSink {
  beginSitting(input: { sittingKey: string; sessionId: string; roomId?: string | null; portraits?: boolean }): void;
  applyEvent(input: { sittingKey: string; sessionId: string; event: PresenceEvent }): boolean;
  setAvailability(input: {
    sittingKey: string;
    sessionId: string;
    availability: PresenceAvailability;
    at?: number;
  }): boolean;
  acceptPortrait(input: { sittingKey: string; sessionId: string; frame: PortraitFrame }): PortraitResult;
  /** A media frame that could not be decoded, so it never reached the store. */
  countPortraitFailure(input: { sittingKey: string; sessionId: string }): void;
  /** This sitting will not be receiving stills any more. */
  retirePortraits(input: { sittingKey: string; sessionId: string }): void;
  portraitsExhausted(sittingKey: string): boolean;
  endSitting(input: { sittingKey: string; sessionId?: string }): void;
}

export interface PresenceServiceOptions {
  now(): number;
  portraits?: PortraitStore;
  /** How many sittings may be tracked at once. Bounds memory on a busy hub. */
  maxSittings?: number;
}

interface Sitting {
  readonly key: string;
  sessionId: string;
  roomId: string | null;
  startedAt: number;
  portraits: boolean;
  roster: SittingRoster;
}

export class PresenceService implements PresenceSink {
  private readonly sittings = new Map<string, Sitting>();
  private readonly portraitStore: PortraitStore;
  private readonly maxSittings: number;

  constructor(private readonly options: PresenceServiceOptions) {
    this.portraitStore = options.portraits ?? new PortraitStore({ now: options.now });
    this.maxSittings = options.maxSittings ?? 16;
  }

  /**
   * Install (or replace) the sitting behind one session.
   *
   * Replacing is the reconnect path, and it starts from an empty roster on
   * purpose: the new socket has not told us who is in the room yet, and
   * carrying the old membership over would be asserting knowledge the new
   * session does not have.
   */
  beginSitting(input: {
    sittingKey: string;
    sessionId: string;
    roomId?: string | null;
    portraits?: boolean;
  }): void {
    const now = this.options.now();
    this.portraitStore.beginSitting(input.sittingKey);
    this.sittings.set(input.sittingKey, {
      key: input.sittingKey,
      sessionId: input.sessionId,
      roomId: input.roomId ?? null,
      startedAt: now,
      portraits: input.portraits ?? false,
      roster: new SittingRoster(input.sittingKey, this.options.now),
    });
    this.evictOldest();
  }

  applyEvent(input: { sittingKey: string; sessionId: string; event: PresenceEvent }): boolean {
    const sitting = this.current(input.sittingKey, input.sessionId);
    if (!sitting) return false;
    sitting.roster.apply(input.event);
    return true;
  }

  setAvailability(input: {
    sittingKey: string;
    sessionId: string;
    availability: PresenceAvailability;
    at?: number;
  }): boolean {
    const sitting = this.current(input.sittingKey, input.sessionId);
    if (!sitting) return false;
    sitting.roster.setAvailability(input.availability, input.at ?? this.options.now());
    return true;
  }

  /**
   * Offer a still for this sitting.
   *
   * Refusals are counted by the store, not thrown: the caller is a video socket
   * whose only job is to be droppable. A rejected frame leaves the roster
   * untouched, so a face falls back to initials rather than showing a picture
   * we could not vouch for.
   */
  acceptPortrait(input: { sittingKey: string; sessionId: string; frame: PortraitFrame }): PortraitResult {
    const sitting = this.current(input.sittingKey, input.sessionId);
    if (!sitting) return { accepted: false, reason: "no-sitting" };
    const result = this.portraitStore.accept(input.sittingKey, input.frame);
    if (!result.accepted) return result;
    sitting.roster.apply({
      kind: "portrait",
      participantId: input.frame.participantId,
      capturedAt: result.capturedAt,
    });
    for (const id of result.evicted) sitting.roster.forgetPortrait(id);
    return result;
  }

  /**
   * Count a video frame the adapter refused before it could become a still.
   *
   * It is the same feed failing in the same sitting, so it spends the same
   * budget — and the budget is what eventually retires a video stream that is
   * sending nothing readable.
   */
  countPortraitFailure(input: { sittingKey: string; sessionId: string }): void {
    if (!this.current(input.sittingKey, input.sessionId)) return;
    this.portraitStore.countFailure(input.sittingKey, "malformed-frame");
  }

  /**
   * Stop claiming this sitting has portraits, and drop the ones it had.
   *
   * Called when the video feed retires mid-meeting: refused, dropped, or out of
   * budget. Presence itself is unaffected — the people are still in the room —
   * but a face must not keep offering a picture from a feed that has stopped,
   * so the capability, the stored bytes and the roster's `portraitAt` all go
   * together. The client drops its own cache the moment the view says
   * `portraits: false`.
   */
  retirePortraits(input: { sittingKey: string; sessionId: string }): void {
    const sitting = this.current(input.sittingKey, input.sessionId);
    if (!sitting) return;
    sitting.portraits = false;
    this.portraitStore.dropImages(input.sittingKey);
    sitting.roster.forgetPortraits();
  }

  /** True once this sitting's video has failed often enough to stop asking. */
  portraitsExhausted(sittingKey: string): boolean {
    return this.portraitStore.exhausted(sittingKey);
  }

  /** The still for a hub participant id, or null. Callers must authenticate. */
  portrait(participantId: string): PortraitImage | null {
    const resolved = this.resolve(participantId);
    if (!resolved) return null;
    return this.portraitStore.get(resolved.sittingKey, resolved.sourceId);
  }

  endSitting(input: { sittingKey: string; sessionId?: string }): void {
    const sitting = this.sittings.get(input.sittingKey);
    if (!sitting) return;
    if (input.sessionId !== undefined && sitting.sessionId !== input.sessionId) return;
    this.sittings.delete(input.sittingKey);
    this.portraitStore.endSitting(input.sittingKey);
  }

  /** Archiving or deleting a room drops its presence without waiting for a socket. */
  forgetRoom(roomId: string): void {
    for (const sitting of [...this.sittings.values()]) {
      if (sitting.roomId === roomId) this.endSitting({ sittingKey: sitting.key });
    }
  }

  roomPresence(roomId: string): SittingPresence | null {
    let newest: Sitting | null = null;
    for (const sitting of this.sittings.values()) {
      if (sitting.roomId !== roomId) continue;
      if (newest === null || sitting.startedAt >= newest.startedAt) newest = sitting;
    }
    return newest === null ? null : this.present(newest);
  }

  sittingPresence(sittingKey: string): SittingPresence | null {
    const sitting = this.sittings.get(sittingKey);
    return sitting ? this.present(sitting) : null;
  }

  dispose(): void {
    this.sittings.clear();
    this.portraitStore.clear();
  }

  private present(sitting: Sitting): SittingPresence {
    const at = this.options.now();
    return {
      sittingKey: sitting.key,
      roomId: sitting.roomId,
      availability: sitting.roster.state,
      completeness: sitting.roster.completeness,
      participants: sitting.roster.participants(at),
      updatedAt: sitting.roster.lastChangeAt,
      portraits: sitting.portraits,
    };
  }

  private current(sittingKey: string, sessionId: string): Sitting | null {
    const sitting = this.sittings.get(sittingKey);
    if (!sitting || sitting.sessionId !== sessionId) return null;
    return sitting;
  }

  /**
   * Split a hub participant id back into the sitting that owns it.
   *
   * Done by asking each sitting whether the id is its own rather than by
   * splitting on the separator, because neither half is guaranteed to be free
   * of one. An id whose sitting has ended resolves to nothing, which is what
   * makes a stale portrait request answer "no image" instead of someone else's.
   */
  private resolve(participantId: string): { sittingKey: string; sourceId: string } | null {
    for (const sitting of this.sittings.values()) {
      const prefix = `${sitting.key}:`;
      if (participantId.startsWith(prefix)) {
        return { sittingKey: sitting.key, sourceId: participantId.slice(prefix.length) };
      }
    }
    return null;
  }

  private evictOldest(): void {
    while (this.sittings.size > this.maxSittings) {
      let oldest: Sitting | null = null;
      for (const sitting of this.sittings.values()) {
        if (oldest === null || sitting.startedAt < oldest.startedAt) oldest = sitting;
      }
      if (oldest === null) return;
      this.endSitting({ sittingKey: oldest.key });
    }
  }
}
