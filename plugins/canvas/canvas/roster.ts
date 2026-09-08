// "Who is at this canvas, and who is talking" — the pure half.
//
// DOM-free and React-free, the same split agents-view.ts uses: the three
// decisions worth getting right (who is in the roster, where a camera has to
// sit to centre somebody's cursor, and where a speaking ring lands on screen)
// are plain functions, and the header/overlay components stay thin adapters.
import { worldToScreen, type Camera } from "@ensembleworks/canvas-editor";
import type { Presence } from "@ensembleworks/canvas-sync";
import { isOnOtherPage, type ViewportSize } from "@ensembleworks/canvas-react";
import { colorForName } from "./identity.js";

/** One person in the room, as the header's avatar stack renders them. */
export interface RosterMember {
  readonly clientId: string;
  readonly name: string;
  /** Hashed from the NAME, so it matches this person's cursor label exactly. */
  readonly color: string;
  readonly isSelf: boolean;
  /**
   * Whether this client has a cursor ON THE PAGE YOU ARE LOOKING AT right now.
   *
   * Not a fact about the room — the answer to "is there somewhere honest for
   * the camera to jump to?", which is why it is `panIntentFor` below and not a
   * field of its own. Two ways the answer is no: a client that joined and
   * never moved its pointer has published no presence at all, and a client who
   * is on another page has a cursor this view deliberately does not draw
   * (design doc D-4). Both leave the avatar saying so rather than sending the
   * camera somewhere arbitrary or somewhere empty.
   */
  readonly hasCursor: boolean;
}

/**
 * The roster: room membership, joined to presence.
 *
 * MEMBERSHIP IS THE SOURCE OF TRUTH, not presence. The room's `identities`
 * broadcast is the authoritative "who is connected" (it changes on join, leave
 * and idle sweep), whereas presence only exists for clients that have moved a
 * pointer — deriving the roster from presence would hide a teammate who just
 * opened the page, which is exactly the person you most want to see arrive.
 *
 * Self is always present, even before the identity broadcast has round-tripped
 * back to us: the panel knows its own name from the identity fetch, and an
 * avatar stack that does not contain you reads as a bug.
 *
 * PRESENCE ONLY DECIDES `hasCursor`, and it does so through `panIntentFor`, so
 * the avatar that is drawn clickable is exactly the avatar whose click lands
 * somewhere — see that function for the rule and for why an absent page must
 * stay clickable.
 */
export function buildRoster(
  identities: Readonly<Record<string, string>>,
  presence: Readonly<Record<string, Presence>>,
  selfKey: string,
  selfName: string | null,
  /** The page the LOCAL view is showing. Optional, and last, so every existing
   * caller keeps its current meaning: no local page, no page filtering — the
   * same shape `speakerRingsFor` takes. */
  currentPageId?: string,
): RosterMember[] {
  const names = new Map<string, string>(Object.entries(identities));
  if (selfName !== null) names.set(selfKey, selfName);
  else if (!names.has(selfKey)) names.set(selfKey, selfKey.slice(0, 6));

  const members = [...names].map(([clientId, name]): RosterMember => ({
    clientId,
    name,
    color: colorForName(name),
    isSelf: clientId === selfKey,
    hasCursor: panIntentFor(presence[clientId], name, currentPageId).kind === "fly",
  }));

  // You first, then alphabetical: a stable order matters more than a clever
  // one, because these are small circles a person learns by position, and a
  // roster that reshuffles whenever a map is re-serialised is unreadable.
  return members.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    return a.name.localeCompare(b.name) || a.clientId.localeCompare(b.clientId);
  });
}

/**
 * Up to two initials for an avatar. Handles the two shapes this plugin's names
 * actually take — `local:mrdavidlaing` from a machine account and `alice` from
 * a Cloudflare Access email's local part — plus the separator-joined forms
 * (`ada.lovelace`, `ada-lovelace`, `ada lovelace`) an email local part often is.
 */
export function initialsFor(name: string): string {
  const bare = name.replace(/^local:/, "").trim();
  const words = bare.split(/[\s._-]+/).filter((word) => word.length > 0);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** As much of one `canvas_roster` row as the sidebar's count looks at. */
export interface CountableMember {
  /** The server saying this clientId is in `room.identities`. */
  readonly inRoom: boolean;
}

/**
 * How many of a `canvas_roster` reply's members are actually ON THE CANVAS.
 *
 * NOT `members.length`. The roster carries every bb tab in the building now
 * (that is what makes "which thread is alice reading" answerable), while the
 * badge this feeds — `CanvasOnlineCount` — also follows the room's `identities`
 * realtime broadcast, which only ever counts clients that called `canvas_join`.
 * Two sources for one number must measure one set, or the badge changes value
 * every time somebody joins, leaves or is swept, with nobody having moved.
 * Measured live before this existed: three clients on the canvas, badge reading
 * seven, oscillating down to four and back.
 *
 * The flag is the SERVER'S answer, not a re-derivation here: a client cannot
 * tell a canvas panel from a tab parked on the canvas URL whose panel has
 * unmounted, and guessing from `path` would put the disagreement back.
 *
 * Anything that is not literally `true` does not count — this reads a value
 * this process did not construct, and a badge whose label asserts "N on the
 * canvas" should under-report rather than invent.
 */
export function onCanvasCount(members: readonly CountableMember[]): number {
  let count = 0;
  for (const member of members) if (member.inRoom === true) count += 1;
  return count;
}

/**
 * The camera that puts `point` (world coordinates) in the middle of the
 * viewport at the current zoom.
 *
 * From canvas-editor's NORMATIVE convention, `screen = (world + camera.xy) *
 * camera.z`: solving for the camera that maps `point` onto the viewport centre
 * gives `camera.xy = centre/z - point`. Zoom is deliberately preserved — the
 * click means "show me where they are", not "and also change how far in I am".
 */
export function cameraCenteredOn(
  point: { readonly x: number; readonly y: number },
  viewportSize: ViewportSize,
  zoom: number,
): { x: number; y: number; z: number } {
  return {
    x: viewportSize.width / 2 / zoom - point.x,
    y: viewportSize.height / 2 / zoom - point.y,
    z: zoom,
  };
}

/**
 * What clicking somebody's avatar should do: fly there, or say why not.
 *
 * ONE RULE FOR THE BUTTON AND FOR THE CLICK. `buildRoster` calls this to fill
 * `hasCursor`, which becomes `DockBubble.canPan` and so decides whether the
 * dock's pan button renders enabled and titled "jump to their cursor"; the
 * panel calls it again at click time. If they were two comparisons they could
 * disagree, and the disagreement would be silent — a button that promises a
 * cursor and delivers empty canvas.
 *
 * PAGE-SCOPED (design doc D-4), on the same terms as the cursors and the
 * speaker rings, and via canvas-react's `isOnOtherPage` rather than a third
 * copy of the comparison. Once this view stops DRAWING a peer's cursor because
 * they are on another page, flying the camera to that peer's world point lands
 * you on a spot where — by this feature's own design — nothing is rendered.
 * Before page filtering that jump was coherent; leaving it wired would make
 * D-4 turn a working gesture into one that lies, which is exactly the argument
 * `speakerRingsFor` already makes for the rings.
 *
 * ABSENT PAGE IS UNKNOWN, NEVER "ELSEWHERE" — a peer on an older bundle
 * publishes no page, their cursor IS still drawn, so the jump still lands on
 * something and must stay offered.
 *
 * The two refusals are worded differently because they are different
 * situations for the person clicking: "they have not moved a pointer" sends
 * you nowhere, "they are on another page" tells you where to look.
 */
export type PanIntent =
  | {
      readonly kind: "fly";
      readonly point: { readonly x: number; readonly y: number };
    }
  | { readonly kind: "refuse"; readonly message: string };

export function panIntentFor(
  /** This client's presence entry, read AT CLICK TIME by the panel: entries
   * expire and pages change between the roster's paint and the click. */
  entry: Presence | undefined,
  /** Their display name, for the refusal. Missing names are named generically
   * rather than interpolated as "undefined". */
  name: string | null | undefined,
  /** The page the LOCAL view is showing; absent means "not page-aware", which
   * filters nobody. */
  currentPageId?: string,
): PanIntent {
  const who = typeof name === "string" && name.length > 0 ? name : "That person";
  const cursor = entry?.cursor ?? null;
  if (cursor === null) {
    return {
      kind: "refuse",
      message: `${who} has no cursor on the canvas right now.`,
    };
  }
  if (isOnOtherPage(entry?.page, currentPageId)) {
    return {
      kind: "refuse",
      message: `${who} is on another page — open it to see their cursor.`,
    };
  }
  return { kind: "fly", point: cursor };
}

/** A ring to draw over a speaking peer's cursor, in viewport pixels. */
export interface SpeakerRing {
  readonly clientId: string;
  readonly name: string;
  readonly color: string;
  readonly left: number;
  readonly top: number;
}

/**
 * Where to draw a speaking ring for each remote peer who is currently talking.
 *
 * SELF IS EXCLUDED, matching canvas-react's `Cursors`, which filters the local
 * peer out (rendering your own cursor from round-tripped network state is a
 * stale duplicate of the real one). A ring with no cursor under it would be a
 * marker floating in empty space; the local speaker gets their feedback on
 * their own header avatar instead.
 *
 * The join key is the NAME: LiveKit participant identities are minted from the
 * same display names the room broadcasts (see av.ts), so "is this cursor
 * talking" is a name lookup rather than a second id space to keep in step.
 *
 * PAGE-SCOPED, on the same terms as the cursors (design doc D-4). A ring is
 * drawn ON a cursor, so scoping the cursors and not the rings would leave a
 * talking peer from another page as a ring around nothing — worse than before
 * page filtering existed, because the cursor that explained it is now hidden.
 * The rule itself is canvas-react's `isOnOtherPage`, called rather than
 * re-derived, so the two overlays can never disagree about who is elsewhere:
 * an absent/null page is UNKNOWN and stays visible, and an absent
 * `currentPageId` means "this caller is not page-aware" and filters nobody.
 */
export function speakerRingsFor(
  presence: Readonly<Record<string, Presence>>,
  identities: Readonly<Record<string, string>>,
  speaking: readonly string[],
  camera: Camera,
  viewportSize: ViewportSize,
  selfKey: string,
  /** The page the LOCAL view is showing. Optional, and last, so every existing
   * caller keeps its current meaning: no local page, no filtering. */
  currentPageId?: string,
): SpeakerRing[] {
  if (speaking.length === 0) return [];
  const talking = new Set(speaking);
  const rings: SpeakerRing[] = [];
  for (const [clientId, entry] of Object.entries(presence)) {
    if (clientId === selfKey) continue;
    if (isOnOtherPage(entry?.page, currentPageId)) continue;
    const cursor = entry?.cursor ?? null;
    if (cursor === null) continue;
    const name = identities[clientId];
    if (name === undefined || !talking.has(name)) continue;
    const screen = worldToScreen(camera, cursor);
    // Culled against the viewport for the same reason a badge is: a ring for
    // somebody talking three screens away is a DOM node nobody can see.
    if (screen.x < -40 || screen.x > viewportSize.width + 40) continue;
    if (screen.y < -40 || screen.y > viewportSize.height + 40) continue;
    rings.push({
      clientId,
      name,
      color: colorForName(name),
      left: screen.x,
      top: screen.y,
    });
  }
  return rings;
}
