import type { HostClassification } from "../hosts.js";
import type { RosterAnswer } from "../server.js";

/**
 * The People tab's "Recognised by" table: every signal Identity would use to name this
 * person, where it comes from, and what it counts for. Pure, so the precedence the
 * copy promises is the precedence tested here.
 */
export type RecognisedByRow = { signal: string; from: string; countsFor: string };

/** Does the host name's `<box>-<person>` suffix name this person (id or github)? */
function suffixNames(hostName: string, row: RosterAnswer["people"][number]): boolean {
  const segment = hostName.trim().split("-").pop()?.toLowerCase() ?? "";
  return segment.length > 0 && (segment === row.person.toLowerCase() || segment === row.github.toLowerCase());
}

export function recognisedBy(row: RosterAnswer["people"][number], context: {
  machines: readonly HostClassification[]; teamMachines: readonly string[]; pickerOn: boolean;
}): RecognisedByRow[] {
  const rows: RecognisedByRow[] = row.emails.map((email) =>
    ({ signal: email, from: "Access email", countsFor: "attribution and the guardrail" }));
  if (context.pickerOn) {
    rows.push({ signal: "Browser name", from: "This browser's picker", countsFor: "attribution only" });
  }
  // The team list wins over a pin and a name alike, so a team machine is never theirs.
  const team = new Set(context.teamMachines.map((name) => name.trim().toLowerCase()));
  const listed = new Set(row.machines);
  for (const machine of context.machines) {
    if (machine.kind !== "person" || machine.person.person !== row.person) continue;
    if (team.has(machine.hostName.trim().toLowerCase())) continue;
    // The classification does not say which rule named the owner: a listed machine whose
    // name does not name them can only have been pinned to them.
    const pinned = listed.has(machine.hostName) && !suffixNames(machine.hostName, row);
    rows.push({ signal: machine.hostName, from: pinned ? "pin" : "name suffix", countsFor: "machine owner (rule A)" });
  }
  return rows;
}
