import { describe, expect, it } from "vitest";
import { PresenceService } from "../src/presence/service.js";
import { PortraitStore } from "../src/presence/portraits.js";
import { jpegBytes as jpeg } from "./helpers/jpeg.js";

const NOW = 1_800_000_000_000;

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
    expect(presence.portrait(`${sitting.sittingKey}:2`)?.bytes.byteLength).toBe(128);
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

  it("retires portraits for a sitting that goes on without them", () => {
    const { presence, portraits, now } = service();
    presence.beginSitting({ ...sitting, roomId: "room-1", portraits: true });
    presence.setAvailability({ ...sitting, availability: "live" });
    presence.applyEvent({ ...sitting, event: { kind: "joined", participantId: "1", name: "Ada", at: now() } });
    presence.acceptPortrait({ ...sitting, frame: { participantId: "1", capturedAt: now(), bytes: jpeg() } });
    expect(presence.roomPresence("room-1")?.portraits).toBe(true);
    expect(presence.portrait("conversation-1:1")).not.toBeNull();

    presence.retirePortraits({ ...sitting });

    const view = presence.roomPresence("room-1")!;
    // The capability, the stored image and the roster's claim to have one all
    // go together: a face must not keep offering a picture nothing can serve.
    expect(view.portraits).toBe(false);
    expect(view.participants[0]!.portraitAt).toBeNull();
    expect(presence.portrait("conversation-1:1")).toBeNull();
    expect(portraits.get("conversation-1", "1")).toBeNull();
    // Presence itself carries on: the people are still there.
    expect(view.participants.map((person) => person.label)).toEqual(["Ada"]);
  });

  it("refuses to retire portraits on behalf of a superseded session", () => {
    const { presence, now } = service();
    presence.beginSitting({ ...sitting, roomId: "room-1", portraits: true });
    presence.setAvailability({ ...sitting, availability: "live" });
    presence.applyEvent({ ...sitting, event: { kind: "joined", participantId: "1", name: "Ada", at: now() } });

    presence.retirePortraits({ sittingKey: sitting.sittingKey, sessionId: "stream-other" });
    expect(presence.roomPresence("room-1")?.portraits).toBe(true);
  });

  it("counts a frame the adapter could not decode against the video budget", () => {
    const { presence, portraits } = service();
    presence.beginSitting({ ...sitting, roomId: "room-1", portraits: true });

    presence.countPortraitFailure({ ...sitting });
    presence.countPortraitFailure({ sittingKey: sitting.sittingKey, sessionId: "stream-other" });

    // The superseded session's frame is not this sitting's failure.
    expect(portraits.failureCount("conversation-1")).toBe(1);
  });
});
