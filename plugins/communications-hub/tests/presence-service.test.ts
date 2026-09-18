import { describe, expect, it } from "vitest";
import { PresenceService } from "../src/presence/service.js";
import { PortraitStore } from "../src/presence/portraits.js";

const NOW = 1_800_000_000_000;

function jpeg(length = 64): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes[length - 2] = 0xff;
  bytes[length - 1] = 0xd9;
  return bytes;
}

function service() {
  let clock = NOW;
  const portraits = new PortraitStore({ now: () => clock, minIntervalMs: 0 });
  const instance = new PresenceService({ now: () => clock, portraits });
  return {
    presence: instance,
    portraits,
    now: () => clock,
    advance(ms: number) {
      clock += ms;
      return clock;
    },
  };
}

const sitting = { sittingKey: "conversation-1", sessionId: "stream-1" };

describe("presence service", () => {
  it("shows a room the people observed in its current sitting", () => {
    const { presence, now } = service();
    presence.beginSitting({ ...sitting, roomId: "room-1" });
    presence.setAvailability({ ...sitting, availability: "live" });
    presence.applyEvent({ ...sitting, event: { kind: "joined", participantId: "1", name: "Ada", at: now() } });

    const view = presence.roomPresence("room-1");
    expect(view?.availability).toBe("live");
    expect(view?.completeness).toBe("partial");
    expect(view?.participants.map((person) => person.label)).toEqual(["Ada"]);
  });

  it("drops every message from a session that has been superseded", () => {
    const { presence, now } = service();
    presence.beginSitting({ ...sitting, roomId: "room-1" });
    presence.setAvailability({ ...sitting, availability: "live" });
    presence.applyEvent({ ...sitting, event: { kind: "joined", participantId: "1", name: "Ada", at: now() } });

    // Zoom replaced the stream: a new session takes over the same sitting.
    presence.beginSitting({ sittingKey: sitting.sittingKey, sessionId: "stream-2", roomId: "room-1" });
    presence.setAvailability({ sittingKey: sitting.sittingKey, sessionId: "stream-2", availability: "live" });

    // Late traffic from the old socket, arriving after the handover.
    const applied = presence.applyEvent({
      ...sitting,
      event: { kind: "joined", participantId: "9", name: "Ghost", at: now() },
    });
    expect(applied).toBe(false);
    expect(presence.roomPresence("room-1")?.participants).toEqual([]);

    // And a late teardown from the old session cannot empty the new one.
    presence.endSitting(sitting);
    presence.applyEvent({
      sittingKey: sitting.sittingKey,
      sessionId: "stream-2",
      event: { kind: "joined", participantId: "2", name: "Sam", at: now() },
    });
    expect(presence.roomPresence("room-1")?.participants.map((person) => person.label)).toEqual(["Sam"]);
  });

  it("leaves nobody behind when a sitting ends", () => {
    const { presence, now } = service();
    presence.beginSitting({ ...sitting, roomId: "room-1" });
    presence.setAvailability({ ...sitting, availability: "live" });
    presence.applyEvent({ ...sitting, event: { kind: "joined", participantId: "1", name: "Ada", at: now() } });
    presence.endSitting(sitting);

    // "The meeting ended" is not "the meeting is empty": there is no presence at
    // all, which is what makes the row say "no active stream".
    expect(presence.roomPresence("room-1")).toBeNull();
  });

  it("starts a new sitting in the same room from an empty roster", () => {
    const { presence, now } = service();
    presence.beginSitting({ ...sitting, roomId: "room-1" });
    presence.setAvailability({ ...sitting, availability: "live" });
    presence.applyEvent({ ...sitting, event: { kind: "joined", participantId: "1", name: "Ada", at: now() } });
    presence.endSitting(sitting);

    presence.beginSitting({ sittingKey: "conversation-2", sessionId: "stream-2", roomId: "room-1" });
    presence.setAvailability({ sittingKey: "conversation-2", sessionId: "stream-2", availability: "live" });
    expect(presence.roomPresence("room-1")?.participants).toEqual([]);
    expect(presence.roomPresence("room-1")?.sittingKey).toBe("conversation-2");
  });

  it("forgets a room the moment it is archived or deleted", () => {
    const { presence, now } = service();
    presence.beginSitting({ ...sitting, roomId: "room-1" });
    presence.setAvailability({ ...sitting, availability: "live" });
    presence.applyEvent({ ...sitting, event: { kind: "joined", participantId: "1", name: "Ada", at: now() } });

    presence.forgetRoom("room-1");
    expect(presence.roomPresence("room-1")).toBeNull();
    expect(presence.sittingPresence(sitting.sittingKey)).toBeNull();
  });

  it("holds nothing at all after the plugin is disposed", () => {
    const { presence, now } = service();
    presence.beginSitting({ ...sitting, roomId: "room-1", portraits: true });
    presence.setAvailability({ ...sitting, availability: "live" });
    presence.applyEvent({ ...sitting, event: { kind: "joined", participantId: "1", name: "Ada", at: now() } });
    presence.acceptPortrait({ ...sitting, frame: { participantId: "1", capturedAt: now(), bytes: jpeg() } });

    presence.dispose();
    expect(presence.roomPresence("room-1")).toBeNull();
    expect(presence.portrait(`${sitting.sittingKey}:1`)).toBeNull();
  });

  it("files an accepted still against the participant the FRAME named", () => {
    const { presence, now } = service();
    presence.beginSitting({ ...sitting, roomId: "room-1", portraits: true });
    presence.setAvailability({ ...sitting, availability: "live" });
    presence.applyEvent({ ...sitting, event: { kind: "joined", participantId: "1", name: "Ada", at: now() } });
    presence.applyEvent({ ...sitting, event: { kind: "joined", participantId: "2", name: "Sam", at: now() } });

    presence.acceptPortrait({ ...sitting, frame: { participantId: "2", capturedAt: now(), bytes: jpeg() } });
    const people = presence.roomPresence("room-1")!.participants;
    expect(people.find((person) => person.label === "Ada")!.portraitAt).toBeNull();
    expect(people.find((person) => person.label === "Sam")!.portraitAt).toBe(now());
    expect(presence.portrait(`${sitting.sittingKey}:2`)?.bytes.byteLength).toBe(64);
    expect(presence.portrait(`${sitting.sittingKey}:1`)).toBeNull();
  });

  it("refuses a still for a session that no longer owns the sitting", () => {
    const { presence, now } = service();
    presence.beginSitting({ ...sitting, roomId: "room-1", portraits: true });
    presence.setAvailability({ ...sitting, availability: "live" });
    presence.beginSitting({ sittingKey: sitting.sittingKey, sessionId: "stream-2", roomId: "room-1", portraits: true });

    expect(presence.acceptPortrait({ ...sitting, frame: { participantId: "1", capturedAt: now(), bytes: jpeg() } }))
      .toEqual({ accepted: false, reason: "no-sitting" });
  });

  it("answers a portrait request for an unknown or ended sitting with nothing", () => {
    const { presence, now } = service();
    presence.beginSitting({ ...sitting, roomId: "room-1", portraits: true });
    presence.setAvailability({ ...sitting, availability: "live" });
    presence.applyEvent({ ...sitting, event: { kind: "joined", participantId: "1", name: "Ada", at: now() } });
    presence.acceptPortrait({ ...sitting, frame: { participantId: "1", capturedAt: now(), bytes: jpeg() } });

    expect(presence.portrait("someone-elses-sitting:1")).toBeNull();
    presence.endSitting(sitting);
    expect(presence.portrait(`${sitting.sittingKey}:1`)).toBeNull();
  });

  it("does not show one room the presence of another", () => {
    const { presence, now } = service();
    presence.beginSitting({ ...sitting, roomId: "room-1" });
    presence.setAvailability({ ...sitting, availability: "live" });
    presence.applyEvent({ ...sitting, event: { kind: "joined", participantId: "1", name: "Ada", at: now() } });

    expect(presence.roomPresence("room-2")).toBeNull();
  });

  it("bounds how many sittings it tracks", () => {
    let clock = NOW;
    const presence = new PresenceService({ now: () => clock, maxSittings: 2 });
    presence.beginSitting({ sittingKey: "a", sessionId: "s", roomId: "room-a" });
    clock += 10;
    presence.beginSitting({ sittingKey: "b", sessionId: "s", roomId: "room-b" });
    clock += 10;
    presence.beginSitting({ sittingKey: "c", sessionId: "s", roomId: "room-c" });

    expect(presence.sittingPresence("a")).toBeNull();
    expect(presence.sittingPresence("c")).not.toBeNull();
  });
});
