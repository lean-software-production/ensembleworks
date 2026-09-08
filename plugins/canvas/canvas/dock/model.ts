// Everything the presence strip DECIDES, with none of the DOM it decides it
// against.
//
// The strip (canvas/dock/dock.ts) is a content script: imperative DOM in a bb
// app shell with no React tree and no test harness short of a real browser. So
// the split is the same one roster.ts and agents-view.ts use, only harder:
// every judgement — who gets a bubble, in what order, who is ringed, whose face
// is a place the camera can fly to — is a pure function here, and the script is
// a renderer that makes no decisions of its own. Placement and fold state are
// decisions too, and they live next door in canvas/dock/anchor.ts and
// canvas/dock/expand.ts.
import { colorForName } from "../identity.js";
import { initialsFor } from "../roster.js";

/**
 * How many faces the strip draws before collapsing the rest into "+N".
 *
 * The strip sits IN bb's page-header row on every page, sharing a fixed-height
 * flex line with the page title and its action buttons. That width is a cost
 * paid by every surface, not just the canvas — six overlapping 24px circles is
 * about what a title bar can spare, and it is the same cap the canvas page's
 * own avatar stack used before the strip replaced it.
 */
export const MAX_DOCK_BUBBLES = 6;

/**
 * How long a bubble keeps its speaking ring after LiveKit last named that
 * participant an active speaker.
 *
 * `ActiveSpeakersChanged` fires on the SFU's own audio-level cadence and drops
 * people between syllables. Rendering it raw makes the ring strobe, which
 * reads as a rendering bug rather than as speech; a short hold turns the same
 * signal into "this person is talking".
 */
export const SPEAKING_HOLD_MS = 900;

/** The minimum a person needs to be in the roster: what the `canvas_roster`
 * rpc returns, and a structural subset of `RosterMember`.
 *
 * `hasCursor` is the one field only the LIVE bus roster carries — the polled
 * rpc knows names and clientIds and nothing about pointers — so it is optional,
 * and its absence reads as "no cursor", which is the honest answer off the
 * canvas page. */
export interface DockRosterEntry {
  readonly clientId: string;
  readonly name: string;
  readonly hasCursor?: boolean;
  /**
   * Where in bb this TAB is, or null for "present, location unknown" — which
   * is also what the server answers once a location has gone stale (see
   * LOCATION_STALE_MS in canvas/locations.ts). Optional because the LIVE bus
   * roster does not carry it: the canvas panel knows cursors, the poll knows
   * whereabouts, and `mergeRoster` joins the two.
   */
  readonly path?: string | null;
  /** The reporting tab's own document.title, so a thread can be named rather
   * than numbered. Null off a thread, or before the title settled. */
  readonly title?: string | null;
  /** When that location was reported, server clock. The LAST tiebreak when one
   * person has bb open in several tabs — see `locateEveryone`, which reaches
   * for it only after focus and after the tab it chose last time. */
  readonly seenMs?: number | null;
  /**
   * Whether that tab had the OS focus when it last reported
   * (`document.hasFocus()`).
   *
   * The honest answer to "which of your five windows are you actually in", and
   * the reason it is on the wire at all. Absent — an older bb on the other end,
   * or the LIVE bus roster, which knows cursors and not focus — reads as NOT
   * focused, never as focused: a tab that never said so must not out-rank one
   * that did.
   */
  readonly focused?: boolean;
}

/** One face in the strip. */
export interface DockBubble {
  /** LiveKit identity — the join key for speaking, video and tile attachment.
   * Equal to the display name by construction; see av.ts. */
  readonly key: string;
  readonly name: string;
  /** What a tooltip says. */
  readonly label: string;
  readonly initials: string;
  readonly color: string;
  /**
   * Which of this person's tabs a pan should fly to, or null when the roster
   * has no client for them at all (you, before the identity broadcast has
   * round-tripped).
   *
   * Bubbles are keyed by NAME — one person, however many tabs — but
   * canvasBus.panTo speaks clientIds, so the model picks the tab worth flying
   * to and hands the renderer one id rather than a set to choose from.
   */
  readonly clientId: string | null;
  /**
   * Whether clicking this face has somewhere honest to go: that client has a
   * cursor on the canvas. False makes the button inert rather than inventing a
   * destination (their viewport centre, the origin), which is what the canvas
   * page's own avatar stack did before the strip absorbed it.
   */
  readonly canPan: boolean;
  /**
   * Where this PERSON is in bb — the path of whichever of their tabs reported
   * a location most recently — or null when no tab of theirs is located (nobody
   * has reported, or every report has gone stale).
   *
   * A separate question from `clientId`/`canPan`, which are about flying the
   * CANVAS camera to a cursor. One person can easily be a canvas tab with a
   * cursor and a thread tab they are actually reading, and the two affordances
   * must point at different tabs without arguing.
   */
  readonly path: string | null;
  /** The thread title that travelled with `path`, when there was one. */
  readonly title: string | null;
  readonly isSelf: boolean;
  readonly isSpeaking: boolean;
  /** Whether this person is publishing a camera, i.e. whether the bubble is a
   * live tile rather than initials. */
  readonly hasVideo: boolean;
}

export interface DockModel {
  readonly bubbles: readonly DockBubble[];
  /** How many members the strip could not fit. */
  readonly overflow: number;
}

export interface DockModelInput {
  readonly roster: readonly DockRosterEntry[];
  /**
   * Where each person is, already decided — an OVERRIDE, not a second source.
   *
   * `locateEveryone` is now stateful in one narrow sense: it is told which tab
   * it chose last time so a person with two live windows stops teleporting
   * between them (see that function). Only the strip holds that memory, and
   * the strip needs the same answer twice per render — once for these faces
   * and once for the host's thread rows — so it computes it once and hands it
   * in. Omitted (every test that does not care, and any caller with no memory
   * to offer), the model works it out itself with no history.
   */
  readonly where?: readonly DockWhereabouts[];
  /** LiveKit identities currently speaking (already held — see speakingAt). */
  readonly speaking: readonly string[];
  /** LiveKit identities currently publishing a camera. */
  readonly video: readonly string[];
  /** Our own display name, or null while we do not know it yet. */
  readonly selfName: string | null;
  /**
   * How many faces the strip has room for right now. Omitted — every caller
   * that does not measure, and every test that does not care — means
   * MAX_DOCK_BUBBLES.
   *
   * A MEASUREMENT, and measurements are only trusted downwards: see the clamp
   * described on `buildDockModel`.
   */
  readonly limit?: number;
}

/**
 * The strip's contents.
 *
 * KEYED BY NAME, NOT clientId. Membership is per browser tab, but a face is per
 * PERSON: someone with the canvas open in two windows is two roster entries and
 * exactly one LiveKit participant, and giving them two bubbles — one of which
 * could never show video — would be a lie about who is in the room. It also
 * makes the join to LiveKit's speaking/video signals direct, since av.ts mints
 * the participant identity from the display name.
 *
 * ORDER IS STABLE AND BORING: others alphabetically, you last. These are small
 * circles a person learns by position, so the order must not depend on who is
 * talking or who turned a camera on.
 *
 * HOW MANY FACES IS AN INPUT, and the clamp on it is ONE-DIRECTIONAL: a caller
 * may ask for fewer than MAX_DOCK_BUBBLES, never more. The two numbers answer
 * different questions. MAX_DOCK_BUBBLES is about LEGIBILITY — how many
 * overlapping 24px circles still read as faces in a title-bar row — and no
 * amount of measured width changes that, so a wide header is not permission to
 * draw ten. `limit` is about ROOM, which only ever takes width away. Letting a
 * measurement raise the cap would also mean a layout bug could scale the strip
 * without bound; clamping down is the strictly safer direction to be wrong in.
 *
 * A limit that is not a finite number is not a measurement at all — an element
 * with no layout yet, a divide by a zero width — so it degrades to
 * MAX_DOCK_BUBBLES, i.e. to the behaviour the strip had before it measured
 * anything. It must never empty the strip: that would turn a bad measurement
 * into a strip that looks broken rather than one that looks unsqueezed.
 *
 * ZERO MEANS ZERO, AND ONLY AN ABSENT LIMIT MEANS THE CAP. This used to be
 * "zero means one" — a floor, put there so that a strip with people in it could
 * never come out empty, and correct for every caller that existed at the time.
 * canvas/dock/squeeze.ts's `bare` tier is a caller that asks for none ON
 * PURPOSE (`maxBubblesFor("bare") === 0`, and its comment says outright that
 * this clamp had to learn the difference), so the floor turned the one tier
 * that must draw nothing into the tier that draws exactly one face: the most
 * expensive circle in the run and the least honest, since one face out of a
 * room of ten reads as "one person is here".
 *
 * WHAT USED TO GUARD THAT, AND WHERE IT WENT. The fear behind the floor was a
 * broken measurement emptying the strip, and it is still answered — one module
 * earlier. A width that is not a measurement never becomes a 0 here:
 * `chooseSqueeze` answers an unreadable width with `cramped`, and `nextSqueeze`
 * holds the tier already on screen, so `bare` is only ever reached by a width
 * that was actually read. The `undefined`/non-finite degradation above is what
 * still catches a caller with no measurement at all.
 *
 * AT ZERO, "YOU ARE NEVER THE FACE THAT GETS DROPPED" DOES NOT APPLY. That rule
 * exists so the mic and camera state, which is read off your own face, stays
 * attributable; with no faces at all there is nothing to attribute, and the
 * strip says who is present with a count and the popover instead. So the
 * overflow at zero counts EVERYBODY, you included — a "+N" that quietly
 * excluded you would be short by one at the one tier where it is the only
 * number on screen.
 */
export function buildDockModel(input: DockModelInput): DockModel {
  const limit = facesThatFit(input.limit);
  const speaking = new Set(input.speaking);
  const video = new Set(input.video);

  const names = new Set(input.roster.map((entry) => entry.name));

  // The tab worth flying to, per person: one with a cursor if this person has
  // one open, otherwise their first tab (so the face still knows who it is,
  // and the button is simply inert).
  const panTargets = new Map<string, DockRosterEntry>();
  for (const entry of input.roster) {
    const held = panTargets.get(entry.name);
    if (held === undefined || (held.hasCursor !== true && entry.hasCursor === true)) {
      panTargets.set(entry.name, entry);
    }
  }

  const whereabouts = new Map(
    (input.where ?? locateEveryone(input.roster)).map(
      (entry) => [entry.name, entry] as const,
    ),
  );

  const others = [...names]
    .filter((name) => name !== input.selfName)
    .sort((a, b) => a.localeCompare(b));
  // Appending your name UNCONDITIONALLY — rather than relying on finding it in
  // the roster — is what puts you in your own strip even before the room's
  // identity broadcast has reached you. A strip with no you in it reads as
  // broken, and off the canvas page the roster poll can be seconds behind.
  const ordered =
    input.selfName === null ? others : [...others, input.selfName];

  const bubble = (name: string): DockBubble => ({
    key: name,
    name,
    label: name === input.selfName ? `${name} (you)` : name,
    initials: initialsFor(name),
    color: colorForName(name),
    clientId: panTargets.get(name)?.clientId ?? null,
    canPan: panTargets.get(name)?.hasCursor === true,
    path: whereabouts.get(name)?.path ?? null,
    title: whereabouts.get(name)?.title ?? null,
    isSelf: name === input.selfName,
    isSpeaking: speaking.has(name),
    hasVideo: video.has(name),
  });

  // No faces at all, and it has to be its own branch rather than falling
  // through to the slicing below. With the clamp's floor of one gone, a limit
  // of 0 reaches `others.slice(0, limit - 1)` as `slice(0, -1)` — which does
  // not mean "none", it means "all but the last one", so the strip would draw
  // the entire room minus one person at the tier that asked for nobody. That
  // trap is only on the branch with a self to append: the self-less branch
  // slices `(0, 0)` and would have been right by luck, which is exactly the
  // kind of half-right that a single test only exercising one branch misses.
  //
  // Placed AFTER `ordered`, so the count is the whole room, and it stays 0 for
  // an empty room: "nobody is here" and "nobody is drawn" are different facts,
  // and the strip hides the count on the first of them.
  if (limit === 0) return { bubbles: [], overflow: ordered.length };

  if (ordered.length <= limit) {
    return { bubbles: ordered.map(bubble), overflow: 0 };
  }

  // Over the limit, YOU are the one bubble that never gets dropped: the local
  // mic/camera state is read off your own face, and a strip that hides it makes
  // the controls unattributable.
  //
  // THE GUARANTEE IS A PROPERTY OF THIS SLICING, NOT OF THE CLAMP, and that
  // sentence used to read the other way round — "this is also why the floor of
  // the clamp is one rather than zero". `facesThatFit` has no floor of one any
  // more (see its own note); it floors at 0. Nothing was lost, because the
  // lowest limit that reaches this line is 1: 0 returned above, with no face
  // for the controls to be attributed to and a count in its place.
  const keptOthers =
    input.selfName === null
      ? others.slice(0, limit)
      : others.slice(0, limit - 1);
  const kept =
    input.selfName === null ? keptOthers : [...keptOthers, input.selfName];

  return {
    bubbles: kept.map(bubble),
    overflow: ordered.length - kept.length,
  };
}

/** `DockModelInput.limit` reduced to a number of faces. See `buildDockModel`
 * for why the clamp only ever points down, why a broken measurement lands on
 * MAX_DOCK_BUBBLES rather than on none, and why a limit of zero is now taken at
 * its word instead of being floored at one.
 *
 * NEGATIVE GOES TO ZERO, NOT TO ONE AND NOT TO THE CAP. Nothing produces one
 * today (`maxBubblesFor` answers 0..MAX_DOCK_BUBBLES), so this is a guard on
 * the type rather than a path anybody walks. "Room for less than none" is still
 * not a request for a face, and rounding it UP to one would put a circle on
 * screen on the strength of the most obviously broken number a caller can hand
 * in — the opposite of the direction every other clamp here errs in.
 *
 * Fractions FLOOR rather than round, because a face is drawn whole or not at
 * all: rounding 3.7 up would put a fourth circle in width the measurement had
 * just said was not there, which is the one direction that reintroduces the
 * overflow this input exists to prevent. Nothing hands in a fraction today —
 * canvas/dock/squeeze.ts answers in whole tier counts — so this is a guard on
 * the type, not a rounding policy any caller currently leans on. */
function facesThatFit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return MAX_DOCK_BUBBLES;
  return Math.min(MAX_DOCK_BUBBLES, Math.max(0, Math.floor(limit)));
}

/**
 * What the strip says about the room — its tooltip and its accessible name.
 *
 * WHY IT IS HERE AND NOT IN THE RENDERER. It was a private `describe()` in
 * canvas/dock/dock.ts, wrapped in a `bubbles.length === 0 ? "nobody here yet"`
 * ternary written when an empty bubble list could only mean an empty room. The
 * `bare` tier made that inference false: there, the strip draws no faces for a
 * room that is full of people, and the control announced "Canvas room — nobody
 * here yet" to five of them. Both halves are judgements about a `DockModel`, so
 * both are now in the file that has tests.
 *
 * THE THREE SENTENCES IT CAN SAY, and they are three because the model has
 * three genuinely different states:
 *
 *   * Faces drawn, everybody fitted — the names, and nothing else to add.
 *   * Faces drawn, some left over — the names "and N more", which is only a
 *     true sentence while there are names for them to be more THAN.
 *   * No faces drawn — a count on its own. Reached when the tier is `bare`
 *     (and only then; every other tier keeps at least one face), and the reason
 *     the second form cannot simply be reused with an empty name list.
 *
 * "nobody here yet" IS NOT "0 people". It is the answer on every page of a
 * quiet bb, so it is the sentence most people will ever read off this control,
 * and a count of zero is a worse way to say it.
 */
export function describeRoom(model: DockModel): string {
  if (model.bubbles.length === 0) {
    if (model.overflow === 0) return "nobody here yet";
    // Singular is worth the branch: "1 people" in a tooltip is the kind of
    // thing that makes the whole control look unfinished.
    return `${model.overflow} ${model.overflow === 1 ? "person" : "people"}`;
  }
  const names = model.bubbles.map((bubble) => bubble.label).join(", ");
  return model.overflow > 0 ? `${names} and ${model.overflow} more` : names;
}

/**
 * The little number beside the faces, as text. Empty for "there is nothing to
 * say", which is what the renderer keys its `hidden` off.
 *
 * THE PLUS SIGN IS A CLAIM ABOUT WHAT IS NEXT TO IT. "+3" means "three more as
 * well as the faces you can see", and at the `bare` tier there are no faces to
 * be more than — the run is not rendered at all — so the same glyph would be a
 * plus sign with nothing on its left. There it is a plain count of the room.
 *
 * A COUNT, NOT A COUNT WITH A WORD AFTER IT. `bare` exists because the row has
 * run out of width; "3 people" beside the mic would spend a good part of what
 * dropping the faces just bought back. The sentence version is the tooltip and
 * the accessible name (`describeRoom`), which cost no width at all.
 */
export function overflowLabel(model: DockModel): string {
  if (model.overflow === 0) return "";
  return model.bubbles.length === 0 ? `${model.overflow}` : `+${model.overflow}`;
}

/** Last-seen timestamps for speaking participants, by LiveKit identity. */
export type SpeakingHold = Readonly<Record<string, number>>;

/**
 * Fold one `ActiveSpeakersChanged` event into the hold map.
 *
 * Returns `previous` UNCHANGED when nothing moved, so the strip can skip a
 * repaint on the many events that say the same thing as the last one. Entries
 * whose hold has expired are dropped rather than kept at zero: this is fed by
 * an event that fires several times a second for a whole session, and a map
 * that accumulates one key per person who ever spoke is a slow leak.
 */
export function holdSpeaking(
  previous: SpeakingHold,
  active: readonly string[],
  nowMs: number,
): SpeakingHold {
  const next: Record<string, number> = {};
  for (const [identity, seenAt] of Object.entries(previous)) {
    if (nowMs - seenAt < SPEAKING_HOLD_MS) next[identity] = seenAt;
  }
  for (const identity of active) next[identity] = nowMs;

  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  if (
    previousKeys.length === nextKeys.length &&
    nextKeys.every((identity) => previous[identity] === next[identity])
  ) {
    return previous;
  }
  return next;
}

/** Who still counts as speaking at `nowMs`. Sorted, so two equal states
 * compare equal and the strip's change check stays a string walk. */
export function speakingAt(hold: SpeakingHold, nowMs: number): string[] {
  return Object.entries(hold)
    .filter(([, seenAt]) => nowMs - seenAt < SPEAKING_HOLD_MS)
    .map(([identity]) => identity)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * The roster the strip draws: the poll, wearing what only the bus knows.
 *
 * THIS RULE INVERTED WHEN LOCATIONS ARRIVED, and the old one is recorded here
 * because it was right at the time. It used to be "the bus roster wins
 * outright" — the canvas panel refreshes it on every presence tick, the poll
 * was only for the pages that are not the canvas, and merging risked
 * resurrecting members the poll had already seen leave.
 *
 * That held while the poll knew strictly LESS than the bus. It no longer does:
 * the poll now returns everybody in the building (every bb tab that reported a
 * location, not just the sync-room clients a canvas panel can see), so
 * preferring the bus made opening the canvas page erase everyone off it from
 * your strip, take their whereabouts with them, and silently clear every
 * thread-row glyph. That was observed live on the canvas route before this
 * changed.
 *
 * So the POLL is the membership truth, and the bus contributes the one fact
 * only it has: which clients have a cursor on the canvas right now. The join
 * key is the clientId, and it is exact because one tab is now one address (the
 * panel and the strip share it — canvas/tab-id.ts).
 *
 * The one bus entry kept regardless is one the poll has not listed at all while
 * the poll is EMPTY — you, in the moments after mounting the canvas panel and
 * before your first poll returns. A strip with no you in it reads as broken.
 */
export function mergeRoster<T extends DockRosterEntry>(
  bus: readonly T[],
  polled: readonly DockRosterEntry[],
): DockRosterEntry[] {
  if (polled.length === 0) return [...bus];
  const cursors = new Map(bus.map((entry) => [entry.clientId, entry.hasCursor === true]));
  return polled.map((entry) => ({
    clientId: entry.clientId,
    name: entry.name,
    path: entry.path ?? null,
    title: entry.title ?? null,
    seenMs: entry.seenMs ?? null,
    // Focus rides with the location: the poll is the only thing that knows it,
    // and it is the first thing `locateEveryone` ranks on.
    focused: entry.focused === true,
    hasCursor: cursors.get(entry.clientId) ?? false,
  }));
}

/**
 * Our own display name.
 *
 * The canvas panel knows it from the identity fetch before anyone joins audio,
 * which is the only source available on the canvas page and the earliest one
 * anywhere. Off the canvas page there is no panel, so the LiveKit identity we
 * joined under is the next answer.
 *
 * THE THIRD FALLBACK is the strip's OWN identity fetch. It exists because the
 * first two are both canvas-page-or-in-a-call answers: on a thread route, with
 * nobody in a call, the strip used to have no idea which bubble was you, and
 * drew your own face as a stranger's — with no "(you)", and (once there were
 * jump links) offering to fly you to yourself. It is the same `/http/identity`
 * door the panel uses, not a second name source.
 *
 * Before any of the three exists we still say null rather than guessing,
 * because a wrong "you" puts the mic controls on someone else's face.
 */
export function resolveSelfName<
  T extends { readonly name: string; readonly isSelf: boolean },
>(
  bus: readonly T[],
  livekitIdentity: string | null,
  fetchedIdentity: string | null = null,
): string | null {
  return (
    bus.find((member) => member.isSelf)?.name ??
    livekitIdentity ??
    fetchedIdentity
  );
}

/**
 * The `canvas_roster` reply, narrowed.
 *
 * Moved out of dock.ts with the location feature: this parses a value the strip
 * did not construct, into values that become an `<a href>` and a label, and in
 * dock.ts it was code no test in this project could reach.
 *
 * DEFENSIVE PER FIELD, not per member. A member with a junk `path` keeps its
 * face and loses its jump link, rather than costing the whole poll — the strip
 * has to survive an older or newer bb on the other end of the wire, and a
 * member with no location at all (nulls, or simply absent) is a state the
 * server produces routinely.
 */
export function parseRoster(value: unknown): DockRosterEntry[] {
  if (typeof value !== "object" || value === null) return [];
  const members = Reflect.get(value, "members");
  if (!Array.isArray(members)) return [];

  const entries: DockRosterEntry[] = [];
  for (const member of members) {
    if (typeof member !== "object" || member === null) continue;
    const clientId = Reflect.get(member, "clientId");
    const name = Reflect.get(member, "name");
    if (typeof clientId !== "string" || typeof name !== "string") continue;
    const path = Reflect.get(member, "path");
    const title = Reflect.get(member, "title");
    const seenMs = Reflect.get(member, "seenMs");
    const focused = Reflect.get(member, "focused");
    entries.push({
      clientId,
      name,
      path: typeof path === "string" ? path : null,
      title: typeof title === "string" ? title : null,
      seenMs: typeof seenMs === "number" ? seenMs : null,
      // Anything that is not literally `true` is NOT FOCUSED: null (the server
      // saying it has forgotten this tab's location), absent (an older bb), or
      // junk. Reading any of those as focused would let a tab nobody is
      // looking at win the ranking outright.
      focused: focused === true,
    });
  }
  return entries;
}

/**
 * How far ahead a rival tab must be before it takes the answer off the tab
 * `locateEveryone` chose last time.
 *
 * Every bb window polls on its own ROSTER_POLL_MS (2s) timer, so between two
 * live tabs of one person the gap in `seenMs` is at most one poll period, and
 * WHICH of them is ahead flips as the two phases drift past each other. Any
 * threshold above a poll period therefore ignores drift entirely; a second of
 * slack on top absorbs a slow request without letting go. A gap larger than
 * this is not drift — that tab has stopped reporting, and holding onto it
 * would be the stale answer this whole feature refuses to give.
 */
export const WHERE_STICKY_LEAD_MS = 3_000;

/** One person and where they are — `locateEveryone`'s answer. */
export interface DockWhereabouts {
  readonly name: string;
  /** Null for "present, location unknown", which is also what a location past
   * the server's staleness horizon degrades to. */
  readonly path: string | null;
  readonly title: string | null;
  /** WHICH TAB THIS ANSWER CAME FROM. The caller feeds it back next time (see
   * `whereChoiceOf`), which is what stops a person with two live windows
   * teleporting between them. */
  readonly clientId: string;
}

/** The memory `locateEveryone` takes: name -> the clientId it last chose. */
export type WhereChoice = ReadonlyMap<string, string>;

/** Turn an answer back into the memory for the next one. */
export function whereChoiceOf(
  where: readonly DockWhereabouts[],
): Map<string, string> {
  return new Map(where.map((entry) => [entry.name, entry.clientId] as const));
}

/** One LOCATED tab — `locatedTabs`' answer. `path` is never null here: a tab
 * with no location is not evidence that anybody is anywhere. */
export interface TabWhereabouts {
  readonly clientId: string;
  readonly name: string;
  readonly path: string;
  readonly title: string | null;
}

/**
 * Every tab that has said where it is, one row each, WITHOUT collapsing a
 * person's tabs into a single answer.
 *
 * THIS IS WHAT THE THREAD-ROW GLYPHS ARE FED. A row asks "is anybody reading
 * this thread", and the truthful answer for somebody with a thread window and
 * a canvas window open is YES to the thread — a union, with no vote to hold and
 * therefore nothing to oscillate. `threadRowStatuses` deduplicates names per
 * row, so two tabs of one person on one thread still read as one name.
 *
 * The popover asks a different question — "where IS this person", singular, for
 * one sentence and one link — and that one has to collapse. It is
 * `locateEveryone`, below, and it is the harder of the two.
 *
 * Sorted by name then clientId, so a diff of two consecutive answers is stable.
 */
export function locatedTabs(
  roster: readonly DockRosterEntry[],
): TabWhereabouts[] {
  return roster
    .filter((entry) => isLocated(entry))
    .map((entry) => ({
      clientId: entry.clientId,
      name: entry.name,
      path: entry.path as string,
      title: entry.title ?? null,
    }))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || (a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0),
    );
}

/**
 * Where each PERSON is, ONE answer each, for everybody in the roster.
 *
 * The tab worth POINTING at is a different question from the tab worth FLYING
 * THE CANVAS CAMERA to (`DockBubble.clientId` / `canPan`), and one person can
 * easily be a canvas tab with a cursor and a thread tab they are actually
 * reading. It is also a different question from which ROWS to light up, which
 * does not collapse at all (`locatedTabs`, above).
 *
 * THE RULE WAS "MOST RECENTLY REPORTED TAB WINS" AND THAT WAS WRONG. Every bb
 * window rewrites its own `seenMs` on its own 2s timer, so for somebody with
 * two live visible windows `argmax(seenMs)` was decided by which of two
 * drifting timers happened to fire last. Measured live: three different
 * answers for one unmoving person inside twenty seconds, a row glyph flipping
 * nine times in forty-five, and a jump link whose href changed under the
 * pointer between clicks. The rule only ever held for a BACKGROUNDED window,
 * which stops polling and falls out on its own.
 *
 * SO THE ORDER IS: located beats unlocated; then FOCUS, because a focused
 * window is the honest answer to "where are you" and a person can only focus
 * one; then, among equals, THE TAB WE CHOSE LAST TIME unless a rival is ahead
 * by more than WHERE_STICKY_LEAD_MS; then most recent; then, so that two
 * genuinely equal tabs do not depend on the order the server serialised them
 * in, the lower clientId.
 *
 * `previous` is the memory (`whereChoiceOf` of the last answer). Passing none
 * is honest and stateless — it just means the first answer of a session has no
 * incumbent to defend.
 *
 * DELIBERATELY UNCAPPED, unlike `buildDockModel`, which draws at most
 * MAX_DOCK_BUBBLES faces and folds the rest into "+N": nothing downstream of
 * this knows about that cap.
 *
 * Sorted by name so a diff of two consecutive answers is stable.
 */
export function locateEveryone(
  roster: readonly DockRosterEntry[],
  previous: WhereChoice = new Map(),
): DockWhereabouts[] {
  const byName = new Map<string, DockRosterEntry[]>();
  for (const entry of roster) {
    const held = byName.get(entry.name);
    if (held === undefined) byName.set(entry.name, [entry]);
    else held.push(entry);
  }

  return [...byName.entries()]
    .map(([name, tabs]) => {
      const chosen = pickTab(tabs, previous.get(name));
      return {
        name,
        path: isLocated(chosen) ? (chosen.path as string) : null,
        title: isLocated(chosen) ? (chosen.title ?? null) : null,
        clientId: chosen.clientId,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Which of one person's tabs answers for them. See `locateEveryone` for why
 * the order is this order. */
function pickTab(
  tabs: readonly DockRosterEntry[],
  previousId: string | undefined,
): DockRosterEntry {
  const located = tabs.filter(isLocated);
  // Nobody has said where they are. They are still a member — a face with no
  // sentence under it — so an arbitrary but STABLE tab answers for them.
  if (located.length === 0) return [...tabs].sort(byClientId)[0] ?? tabs[0]!;

  const focused = located.filter((entry) => entry.focused === true);
  const pool = focused.length > 0 ? focused : located;

  const newest = [...pool].sort(
    (a, b) => (b.seenMs ?? 0) - (a.seenMs ?? 0) || byClientId(a, b),
  )[0]!;

  // The incumbent keeps the answer unless the newest is ahead by more than
  // drift can explain. Note this only ever fires INSIDE the winning rank: a
  // held tab that has lost its location, or lost the focus to a sibling, is
  // not in `pool` at all and cannot defend anything.
  const held = pool.find((entry) => entry.clientId === previousId);
  if (held !== undefined && (newest.seenMs ?? 0) - (held.seenMs ?? 0) <= WHERE_STICKY_LEAD_MS) {
    return held;
  }
  return newest;
}

function isLocated(entry: DockRosterEntry): boolean {
  return typeof entry.path === "string" && entry.path.length > 0;
}

function byClientId(a: DockRosterEntry, b: DockRosterEntry): number {
  return a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0;
}
