// ONE audio session, however many buttons.
//
// There are now two controls over the same LiveKit connection: "Join audio" in
// the canvas page's title bar (canvas/roster-ui.tsx) and the floating dock's
// join button (canvas/dock/dock.ts), and a third is a plugin reload away. The
// invariant they all depend on is that a tab holds AT MOST ONE connection to
// the room — two would show the user twice in the SFU, echo their own mic back
// at them, and leave each button able to hang up only its own half.
//
// av-room.ts used to enforce that with `if (room !== null) return`, which is
// correct once connected and wrong while CONNECTING: the token fetch and the
// WebRTC handshake are both awaits, and a second click lands squarely inside
// them with `room` still null. That is not a theoretical race — it is what
// happens when someone clicks the dock and then the header a beat later, and
// tests/av-session.test.ts pins it.
//
// So the phase lives here, in a module with no LiveKit and no DOM in it: the
// decisions (is this click a connect, a wait, or a no-op; may a connect that
// lands after a leave still claim the session) are separable from the transport
// and are the part worth testing.

/** What the audio controls are doing. Deliberately the same three values as
 * panel-bus.ts's `AvStatus` — this machine IS that status's source. */
export type SessionPhase = "off" | "connecting" | "live";

/** Why a join did not happen. `not_configured` is the expected fresh-install
 * answer and gets its own copy; everything else is a genuine fault. */
export type JoinOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "not_configured" | "failed";
      readonly detail: string;
    };

export interface SharedAvSession {
  /** The current phase. */
  phase(): SessionPhase;
  /**
   * Join, or attach to the join already in flight.
   *
   * `connect` is called AT MOST ONCE per off -> live transition: a caller that
   * arrives while another connect is running gets that one's promise, and a
   * caller that arrives once we are live gets `{ ok: true }` without any
   * transport work at all.
   */
  join(connect: () => Promise<JoinOutcome>): Promise<JoinOutcome>;
  /**
   * Leave. `disconnect` is called only when there is something to disconnect —
   * including when a connect is still in flight, because the caller owns a
   * half-open connection at that point and something has to close it.
   */
  leave(disconnect: () => Promise<void>): Promise<void>;
  /** The session went away without us asking (server hang-up, network drop). */
  reset(): void;
}

export interface SharedAvSessionOptions {
  /** Called on every phase change, never on a no-op. */
  readonly onPhase?: (phase: SessionPhase) => void;
}

export function createSharedAvSession(
  options: SharedAvSessionOptions,
): SharedAvSession {
  let phase: SessionPhase = "off";
  let inFlight: Promise<JoinOutcome> | null = null;
  // Bumped by every leave/reset. A connect that resolves after its generation
  // has been retired reports its outcome to its caller but may no longer flip
  // the session live — otherwise "join, change your mind, leave" ends with a
  // session nobody asked for and no button holding it.
  let generation = 0;

  function setPhase(next: SessionPhase): void {
    if (phase === next) return;
    phase = next;
    options.onPhase?.(next);
  }

  async function run(
    connect: () => Promise<JoinOutcome>,
    forGeneration: number,
  ): Promise<JoinOutcome> {
    let outcome: JoinOutcome;
    try {
      outcome = await connect();
    } catch (cause) {
      // A throw out of the transport is a failure like any other: the caller
      // gets one shape to branch on and the phase always lands somewhere real.
      outcome = { ok: false, reason: "failed", detail: messageOf(cause) };
    }
    if (forGeneration !== generation) return outcome;
    inFlight = null;
    setPhase(outcome.ok ? "live" : "off");
    return outcome;
  }

  return {
    phase: () => phase,

    join(connect) {
      if (phase === "live") return Promise.resolve({ ok: true });
      if (inFlight !== null) return inFlight;
      generation += 1;
      setPhase("connecting");
      const attempt = run(connect, generation);
      inFlight = attempt;
      return attempt;
    },

    async leave(disconnect) {
      if (phase === "off") return;
      generation += 1;
      inFlight = null;
      setPhase("off");
      await disconnect();
    },

    reset() {
      generation += 1;
      inFlight = null;
      setPhase("off");
    },
  };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
