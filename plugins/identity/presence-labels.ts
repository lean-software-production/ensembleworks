/** Pure wording for presence badges, header triggers and sidebar rows. */
export type LabelPerson = { displayName: string; typing: boolean };
export type LabelPresence = { viewers: number; typing: number; people: readonly LabelPerson[] };

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** "Matt", "Matt and Trevoke", "Matt, Trevoke and 1 other", "2 others". */
export function joinNames(names: readonly string[], others: number): string {
  const parts = others > 0 ? [...names, plural(others, "other")] : [...names];
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export function presenceLabel({ viewers, typing, people }: LabelPresence): string {
  if (people.length === 0) {
    const viewing = `${viewers} other ${viewers === 1 ? "viewer" : "viewers"}`;
    return typing > 0 ? `${viewing} · ${typing} typing` : viewing;
  }
  if (typing > 0) {
    const typers = people.filter((entry) => entry.typing).map((entry) => entry.displayName);
    const anonymousTypers = Math.max(0, typing - typers.length);
    const count = typers.length + anonymousTypers;
    return `${joinNames(typers, anonymousTypers)} ${count === 1 ? "is" : "are"} typing`;
  }
  const others = Math.max(0, viewers - people.length);
  const count = people.length + others;
  return `${joinNames(people.map((entry) => entry.displayName), others)} ${count === 1 ? "is here" : "here"}`;
}

export function initials(displayName: string): string {
  const letters = displayName.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]!.toUpperCase());
  return letters.length > 0 ? letters.join("") : "?";
}
