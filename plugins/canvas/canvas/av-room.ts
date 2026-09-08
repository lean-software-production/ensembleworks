// The LiveKit half of "how do I talk to them": one process-wide Room, its mic,
// its camera, and the speaker signal the roster, the cursors and the dock all
// read.
//
// A MODULE SINGLETON, like panel-bus.ts and for the same reason — the controls
// that join are scattered across surfaces BB renders in different trees (the
// canvas page's title bar, and now the floating dock, which is a content script
// with no React tree at all), and a WebRTC connection is far too expensive to
// be React state anyway (a re-render must never be able to reconnect it).
// Everything this module learns is pushed into the bus; nothing reads back out
// of it.
//
// The phase machine is NOT here: two independent join buttons race, and the
// decision "is this click a connect, a wait, or a no-op" is worth testing
// without a browser. It lives in av-session.ts; this module is the transport
// underneath it.
//
// The only livekit-client import in the plugin is here, so the browser SDK
// never leaks into a module the backend also loads.
import {
  Room,
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";
import { canvasBus } from "./panel-bus.js";
import { createSharedAvSession, type JoinOutcome } from "./av-session.js";
import type { AvTokenResult } from "./av.js";

export type { JoinOutcome } from "./av-session.js";

/** Anything we can hang a `<video>` off. Both LocalVideoTrack and
 * RemoteVideoTrack satisfy it; naming the structure rather than the union keeps
 * this module out of livekit's class hierarchy. */
interface AttachableVideo {
  attach(element: HTMLVideoElement): HTMLVideoElement;
  detach(element: HTMLVideoElement): HTMLVideoElement;
}

let room: Room | null = null;
/** The room whose handshake is in flight. Held separately from `room` because
 * for the length of a connect it is a real, half-open peer connection that
 * nothing else can reach — and a leave arriving in that window has to be able
 * to close it. */
let connectingRoom: Room | null = null;
/** Bumped by every teardown. A connect that finishes under a retired epoch has
 * been abandoned (the user left while it was handshaking) and must hang up
 * rather than install itself as the session. */
let epoch = 0;
/** Where remote audio elements live. Off-screen rather than absent: an
 * `<audio>` element has to be in the document to play. */
let sink: HTMLDivElement | null = null;
/** Camera tracks by LiveKit identity — the local one included, so the dock's
 * own bubble is a real self-view rather than a mirror we have to fake. */
const videoTracks = new Map<string, AttachableVideo>();

const session = createSharedAvSession({
  onPhase: (phase) => canvasBus.setAv({ status: phase }),
});

function audioSink(): HTMLDivElement {
  if (sink === null) {
    sink = document.createElement("div");
    sink.dataset.canvasAudioSink = "";
    sink.style.display = "none";
    document.body.appendChild(sink);
  }
  return sink;
}

function speakingNames(speakers: readonly Participant[]): string[] {
  // Identity, not name: av.ts mints the token with the display name AS the
  // identity, and identity is the field LiveKit guarantees is set.
  return speakers.map((participant) => participant.identity);
}

/** Publish the current camera-publishing identities. Sorted so panel-bus's
 * cheap array comparison sees "unchanged" when it is. */
function publishVideoIdentities(): void {
  canvasBus.setAv({ video: [...videoTracks.keys()].sort() });
}

function rememberVideo(identity: string, track: AttachableVideo | undefined): void {
  if (track === undefined) return;
  videoTracks.set(identity, track);
  publishVideoIdentities();
}

function forgetVideo(identity: string): void {
  if (!videoTracks.delete(identity)) return;
  publishVideoIdentities();
}

/**
 * Join the audio room.
 *
 * `fetchToken` is injected rather than called through a captured rpc client:
 * this module is a singleton that outlives any one React render, and holding a
 * stale `useRpc` handle across a plugin reload is exactly the bug
 * PluginContextStaleError exists to catch. (The dock, which has no hooks at
 * all, injects canvas/dock/rpc.ts's plain fetch client through the same door.)
 *
 * Idempotent ACROSS CONTROLS: a second click — from the same button or the
 * other one — while connecting attaches to the connect already in flight, and
 * once live it is a no-op. See av-session.ts.
 */
export function joinAudio(
  fetchToken: () => Promise<AvTokenResult>,
): Promise<JoinOutcome> {
  return session.join(() => connectRoom(fetchToken));
}

async function connectRoom(
  fetchToken: () => Promise<AvTokenResult>,
): Promise<JoinOutcome> {
  let result: AvTokenResult;
  try {
    result = await fetchToken();
  } catch (cause) {
    return { ok: false, reason: "failed", detail: messageOf(cause) };
  }
  if (!result.ok) {
    return { ok: false, reason: "not_configured", detail: result.detail };
  }

  const mine = ++epoch;
  const next = new Room();
  connectingRoom = next;
  // Wire the listeners BEFORE connect(): a fast server can deliver the first
  // track subscription inside the connect promise, and a listener attached
  // afterwards would miss it and leave a participant silently unplayable.
  next.on(
    RoomEvent.TrackSubscribed,
    (
      track: RemoteTrack,
      _publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      if (track.kind === Track.Kind.Audio) {
        audioSink().appendChild(track.attach());
        return;
      }
      if (track.kind === Track.Kind.Video && track.source === Track.Source.Camera) {
        rememberVideo(participant.identity, track as unknown as AttachableVideo);
      }
    },
  );
  next.on(
    RoomEvent.TrackUnsubscribed,
    (
      track: RemoteTrack,
      _publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      if (track.kind === Track.Kind.Audio) {
        for (const element of track.detach()) element.remove();
        return;
      }
      if (track.kind === Track.Kind.Video) forgetVideo(participant.identity);
    },
  );
  // The local camera is not "subscribed" to us, so it arrives through its own
  // pair of events. Without these the dock would show everyone's face but the
  // user's own, which reads as a broken camera button.
  next.on(
    RoomEvent.LocalTrackPublished,
    (publication: LocalTrackPublication, participant: Participant) => {
      if (publication.kind !== Track.Kind.Video) return;
      if (publication.source !== Track.Source.Camera) return;
      rememberVideo(
        participant.identity,
        publication.track as unknown as AttachableVideo | undefined,
      );
    },
  );
  next.on(
    RoomEvent.LocalTrackUnpublished,
    (publication: LocalTrackPublication, participant: Participant) => {
      if (publication.kind !== Track.Kind.Video) return;
      forgetVideo(participant.identity);
    },
  );
  // A participant who closes the tab never unsubscribes politely; without this
  // their tile would stay in the dock showing a frozen last frame.
  next.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
    forgetVideo(participant.identity);
  });
  next.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
    canvasBus.setAv({ speaking: speakingNames(speakers) });
  });
  // Server-side or network-side disconnects land here too, not just our own
  // leaveAudio() — so the button falls back to "Join audio" instead of lying.
  next.on(RoomEvent.Disconnected, () => {
    if (room === next) {
      teardown();
      session.reset();
    }
  });

  try {
    await next.connect(result.url, result.token);
    await next.localParticipant.setMicrophoneEnabled(true);
    // Browsers block autoplay until a gesture has unlocked audio. The join IS
    // a click, so this normally resolves immediately; it is wrapped because a
    // refusal must cost the remote audio, not the whole join.
    try {
      await next.startAudio();
    } catch {
      /* remote audio stays muted until the user clicks something else */
    }
  } catch (cause) {
    if (connectingRoom === next) connectingRoom = null;
    await next.disconnect().catch(() => {});
    return { ok: false, reason: "failed", detail: messageOf(cause) };
  }

  if (mine !== epoch) {
    // Somebody left while this was handshaking. av-session.ts already refuses
    // to call the session live, so the only thing left to do is not strand the
    // connection we opened.
    await next.disconnect().catch(() => {});
    return { ok: false, reason: "failed", detail: "Join cancelled" };
  }

  connectingRoom = null;
  room = next;
  canvasBus.setAv({
    muted: false,
    cameraOn: false,
    speaking: [],
    video: [],
    self: next.localParticipant.identity,
  });
  return { ok: true };
}

/** Mute or unmute the local mic. A no-op when we are not in a room. */
export async function setMuted(muted: boolean): Promise<void> {
  const current = room;
  if (current === null) return;
  // Optimistic, then corrected: the toggle has to feel instant, and
  // setMicrophoneEnabled round-trips to the SFU.
  canvasBus.setAv({ muted });
  try {
    await current.localParticipant.setMicrophoneEnabled(!muted);
  } catch {
    canvasBus.setAv({ muted: !muted });
  }
}

/**
 * Turn the local camera on or off. A no-op when we are not in a room — the
 * dock disables the button in that state, but a keyboard or a stale click must
 * not be able to open a camera outside a session.
 *
 * NOT optimistic, unlike the mic: turning a camera on shows a browser
 * permission prompt the user can refuse, and a button that says "on" while the
 * light is off is worse than one that takes a moment to settle.
 */
export async function setCameraEnabled(on: boolean): Promise<void> {
  const current = room;
  if (current === null) return;
  try {
    await current.localParticipant.setCameraEnabled(on);
    canvasBus.setAv({ cameraOn: on });
  } catch {
    canvasBus.setAv({ cameraOn: false });
  }
}

/**
 * Put this identity's camera into `element`, or report that there is nothing to
 * show. The dock calls it per bubble; anything with a `<video>` may.
 *
 * Attaching is idempotent in livekit-client (the same element attached twice
 * is one attachment), which is what lets the dock re-render freely.
 */
export function attachVideo(identity: string, element: HTMLVideoElement): boolean {
  const track = videoTracks.get(identity);
  if (track === undefined) return false;
  track.attach(element);
  return true;
}

export function detachVideo(identity: string, element: HTMLVideoElement): void {
  videoTracks.get(identity)?.detach(element);
}

export async function leaveAudio(): Promise<void> {
  const current = room;
  await session.leave(async () => {
    teardown();
    await current?.disconnect().catch(() => {});
  });
}

/** Forget the room and clear every derived UI signal. Separate from
 * `leaveAudio` because the Disconnected event needs it without re-entering
 * disconnect(). */
function teardown(): void {
  epoch += 1;
  const pending = connectingRoom;
  connectingRoom = null;
  room = null;
  videoTracks.clear();
  canvasBus.setAv({
    muted: false,
    cameraOn: false,
    speaking: [],
    video: [],
    self: null,
  });
  sink?.replaceChildren();
  // Fire and forget: the caller is a UI event handler and a half-open room's
  // goodbye is not worth blocking a button on.
  void pending?.disconnect().catch(() => {});
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
