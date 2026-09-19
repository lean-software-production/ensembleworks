import type { HostClassification } from "./hosts.js";
import type { Person } from "./people.js";
import { colorsClash, readableInk, resolvePersonColor } from "./person-colors.js";

/**
 * The people page's row model: who is registered on this server, what colour is theirs,
 * which machines are theirs, and whether Identity has ever seen them.
 *
 * Pure. No storage, no SDK, no DOM — the server assembles the inputs and the frontend
 * renders the output, and everything interesting in between is testable here.
 */

export type RosterRow = {
  person: string;
  displayName: string;
  github: string;
  emails: string[];
  /** The colour in force: the chosen one if there is one, else the dealt one. */
  color: string;
  /** The colour the roster deals this person, shown as the thing "reset" returns to. */
  dealt: string;
  overridden: boolean;
  /** The ink that stays legible ON `color`. See person-colors.ts for why ink, not fill. */
  ink: string;
  /** The host names that classify as this person's. */
  machines: string[];
  /** True when a thread has been attributed to them. See `SEEN_UNKNOWN_CAVEAT`. */
  seen: boolean;
  seenAt: number | null;
  /**
   * The display names of people whose colour reads the same as this one.
   *
   * A WARNING, never a refusal: two people the same colour defeats the whole point of
   * per-person colours, so it must be visible — but the owner's answer to a collision is
   * information, not prevention, so the clashing colour is still the colour in force.
   */
  clashesWith: string[];
};

export function buildRoster(input: {
  people: readonly Person[];
  overrides: Readonly<Record<string, string>>;
  machines: readonly HostClassification[];
  seen: Readonly<Record<string, number>>;
}): RosterRow[] {
  // The dealt hue comes from the WHOLE directory's ids, exactly as the sidebar deals
  // them — so the page and the sidebar cannot disagree about anyone's colour.
  const roster = input.people.map((entry) => entry.person);
  const rows: RosterRow[] = input.people.map((entry) => {
    const resolved = resolvePersonColor(entry.person, roster, input.overrides);
    const seenAt = input.seen[entry.person];
    return {
      person: entry.person,
      displayName: entry.displayName,
      github: entry.github,
      emails: [...entry.emails],
      color: resolved.color,
      dealt: resolved.dealt,
      overridden: resolved.overridden,
      ink: readableInk(resolved.color),
      machines: input.machines
        .filter((host) => host.kind === "person" && host.person.person === entry.person)
        .map((host) => host.hostName),
      seen: seenAt !== undefined,
      seenAt: seenAt ?? null,
      clashesWith: [],
    };
  });

  // Pairwise, which is fine: this is a team directory, not a user table.
  for (let left = 0; left < rows.length; left += 1) {
    for (let right = left + 1; right < rows.length; right += 1) {
      if (!colorsClash(rows[left]!.color, rows[right]!.color)) continue;
      // Both sides are told: a clash belongs to the pair, not to whoever chose last.
      rows[left]!.clashesWith.push(rows[right]!.displayName);
      rows[right]!.clashesWith.push(rows[left]!.displayName);
    }
  }
  return rows;
}

/**
 * The exact limit of what a seen-state answer means.
 *
 * Identity can only answer from the attribution records it still holds — the newest 2000
 * — plus everything it has recorded since seen-state shipped. It cannot know whether
 * someone used this server before Identity was installed, or before their oldest retained
 * thread. So the UI says the narrow, true thing and never the broad, false one.
 */
export const SEEN_UNKNOWN_CAVEAT =
  "Identity can only answer from the attribution records it retains (the 2000 most recent threads), "
  + "so this means \"no thread of theirs is on record\", not that they have not used this server.";

export function seenPhrase(seen: boolean): string {
  return seen ? "Seen — a thread is attributed to them" : "Not seen in Identity's records";
}
