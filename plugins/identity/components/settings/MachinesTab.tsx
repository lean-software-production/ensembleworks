import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { PinResolution, rpcContract } from "../../server.js";
import { parseTeamMachines, personFromHostName, type HostClassification, type HostKind } from "../../hosts.js";
import type { Person } from "../../people.js";
import { addTeamMachine, removeTeamMachine, type ReadinessStatus } from "../../settings-admin.js";
import { ConfirmDialog, focusOpener } from "./ConfirmDialog.js";
import { refusalSentence } from "./ProfilePanel.js";
import { StatusBadge } from "./StatusBadge.js";
import type { SettingsData } from "./IdentitySettings.js";

const KINDS: Record<HostKind, { label: string; icon: string }> = {
  person: { label: "Person", icon: "●" },
  team: { label: "Team", icon: "■" },
  unclaimed: { label: "Unclaimed", icon: "○" },
};

/** Every refusal `identity_resolve_pin` can answer with, as a sentence about the row it came from. */
const PIN_REFUSALS: Record<Extract<PinResolution, { ok: false }>["reason"], (host: string, person: string) => string> = {
  "unknown-host": (host) => `Identity no longer sees ${host}; nothing changed.`,
  "no-pin": (host) => `${host} has no pin to keep; nothing changed.`,
  "not-in-directory": (_host, person) => `${person} is not in the directory; nothing changed.`,
  "no-person": (host) => `${host}'s name names nobody, so there is nobody to re-pin it to; nothing changed.`,
  "write-failed": () => "BB did not save the pin. Nothing changed; try again.",
};

/** One table row: a host Identity sees, or a teamMachines name it has not seen. */
type Row = {
  key: string;
  name: string;
  kind: HostKind;
  owner: string;
  status: { status: ReadinessStatus; text: string };
  /** Problems first: 0 conflicts, 1 team names not seen, 2 unclaimed, 3 the rest. */
  rank: number;
  host: HostClassification | null;
  /** Who the name suffix points at, for a person row. */
  derived: Person | null;
};
type Action = "keep" | "repin" | "unpin" | "team-add" | "team-remove";

function rowsFor(hosts: readonly HostClassification[], missing: readonly string[], people: readonly Person[]): Row[] {
  const seen: Row[] = hosts.map((host) => {
    if (host.kind === "team") {
      return { key: host.hostId, name: host.hostName, kind: "team", owner: "Team · teamMachines",
        status: { status: "ok", text: "OK" }, rank: 3, host, derived: null };
    }
    if (host.kind === "unclaimed") {
      return { key: host.hostId, name: host.hostName, kind: "unclaimed", owner: "— · unclaimed",
        status: { status: "off", text: "Unclaimed" }, rank: 2, host, derived: null };
    }
    const derived = personFromHostName(host.hostName, people);
    const pinned = host.conflict !== null || derived?.person !== host.person.person;
    const says = derived === null ? "no one in the directory" : derived.displayName;
    return {
      key: host.hostId, name: host.hostName, kind: "person",
      owner: `${host.person.displayName} · ${pinned ? "pin" : "name suffix"}`,
      status: host.conflict === null ? { status: "ok", text: "OK" } : {
        status: "problem",
        text: `Pin conflict. Pinned to ${host.person.displayName} as ${host.conflict.pinnedName}; its name now says ${says}.`,
      },
      rank: host.conflict === null ? 3 : 0, host, derived,
    };
  });
  const unseen: Row[] = missing.map((name) => ({
    key: `team:${name}`, name, kind: "team", owner: "Team · teamMachines",
    status: { status: "attention", text: "Listed in teamMachines but not seen" }, rank: 1, host: null, derived: null,
  }));
  return [...seen, ...unseen].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}

const matches = (row: Row, filter: string) =>
  [row.name, KINDS[row.kind].label, row.owner, row.status.text].join(" ").toLowerCase().includes(filter);

/**
 * The Machines tab: every host Identity sees, whose it is and why, problems first. Pin
 * conflicts and team membership are resolved here, each through a confirm dialog; adding
 * a team machine by name is additive and reversible, so it is not.
 */
export function MachinesTab({ data }: { data: SettingsData }) {
  const rpc = useRpc<typeof rpcContract>();
  const base = useId();
  const { overview, roster, machines, errors, reload } = data;
  const [filter, setFilter] = useState("");
  const [addName, setAddName] = useState("");
  // null until typed in, so the field follows the settings when a reload lands.
  const [userDraft, setUserDraft] = useState<string | null>(null);
  const [pending, setPending] = useState<{ action: Action; row: Row } | null>(null);
  // Every write button waits while any write is in flight: team writes recompute one shared list.
  const [busy, setBusy] = useState(false);
  // Where a refusal is shown: a row's key, or the form it came from.
  const [error, setError] = useState<{ at: string; sentence: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // After a row write succeeds, the list reloads and may replace or remove the button that
  // opened the dialog. Until both reads that reshape the rows have landed, focus that falls
  // off the page goes to the row's first action, else the filter, else the heading.
  const settle = useRef<{ key: string; overview: typeof overview; machines: typeof machines } | null>(null);

  // The team list this tab last wrote, until a settings read issued after that write lands.
  // A second edit made while the reload is in flight (or after it failed) builds on the first
  // rather than on the stale settings, which would silently drop it.
  const overviewRef = useRef(overview);
  overviewRef.current = overview;
  const [written, setWritten] = useState<{ text: string; over: typeof overview } | null>(null);
  const teamText = written !== null && written.over === overview ? written.text : overview?.settings.teamMachines ?? "";
  const write = (at: string, call: () => Promise<{ ok: true } | { ok: false; sentence: string }>, onOk?: () => void) => {
    setBusy(true);
    setError(null);
    void call().then((answer) => {
      if (!answer.ok) { setError({ at, sentence: answer.sentence }); return; }
      onOk?.();
      reload();
    }).catch((failure: unknown) => setError({ at, sentence: `Identity could not save the change: ${String(failure)}` }))
      .finally(() => { setBusy(false); setPending(null); });
  };
  const writeTeam = (at: string, text: string, onOk?: () => void) => write(at, async () => {
    const answer = await rpc.call("identity_update_settings", { teamMachines: text });
    return answer.ok ? answer : { ok: false, sentence: refusalSentence(answer.reason) };
  }, () => { setWritten({ text, over: overviewRef.current }); onOk?.(); });
  const resolvePin = (row: Row, action: "keep" | "repin" | "unpin", onOk: () => void) => {
    const person = action === "repin" ? row.derived?.person : undefined;
    write(row.key, async () => {
      const answer = await rpc.call("identity_resolve_pin",
        person === undefined ? { hostId: row.key, action } : { hostId: row.key, action, person });
      return answer.ok ? answer : { ok: false, sentence: PIN_REFUSALS[answer.reason](row.name, row.derived?.displayName ?? "") };
    }, onOk);
  };
  const confirm = () => {
    if (pending === null) return;
    const { action, row } = pending;
    const onOk = () => { settle.current = { key: row.key, overview, machines }; };
    if (action === "team-add") writeTeam(row.key, addTeamMachine(teamText, row.name), onOk);
    else if (action === "team-remove") writeTeam(row.key, removeTeamMachine(teamText, row.name), onOk);
    else resolvePin(row, action, onOk);
  };
  const open = (action: Action, row: Row) => (event: MouseEvent<HTMLElement>) => {
    focusOpener(event);
    settle.current = null;
    setError(null);
    setPending({ action, row });
  };

  useEffect(() => {
    const after = settle.current;
    const root = rootRef.current;
    if (after === null || root === null || busy || pending !== null) return;
    const focused = document.activeElement;
    if (focused === null || focused === document.body || !focused.isConnected) {
      const row = [...root.querySelectorAll<HTMLElement>("tr[data-row-key]")].find((tr) => tr.dataset.rowKey === after.key);
      const successor = row?.querySelector<HTMLElement>("button:not(:disabled)")
        ?? root.querySelector<HTMLElement>("input[type=search]")
        ?? root.querySelector<HTMLElement>("h3");
      successor?.focus();
    }
    const landed = (read: "overview" | "machines", before: unknown) =>
      data[read] !== before || errors[read] !== undefined;
    if (landed("overview", after.overview) && landed("machines", after.machines)) settle.current = null;
  });

  const people = roster?.people ?? [];
  const available = machines !== null && machines.unavailable === null;
  const hosts = available ? machines.machines : [];
  const seenNames = new Set(hosts.map((host) => host.hostName.toLowerCase()));
  const missing = available ? parseTeamMachines(teamText).filter((name) => !seenNames.has(name.toLowerCase())) : [];
  const rows = rowsFor(hosts, missing, people);
  const needle = filter.trim().toLowerCase();
  const shown = rows.filter((row) => matches(row, needle));
  const sharedUser = userDraft ?? overview?.settings.sharedMachineUser ?? "";
  const formError = (at: string) => error?.at === at ? <p className="identity-settings-error">{error.sentence}</p> : null;

  return (
    <div ref={rootRef} className="identity-settings-stack">
      <h3 className="identity-settings-heading" tabIndex={-1}>Machines</h3>
      <p className="identity-settings-muted">
        Every machine BB knows, whose it is and why: a name suffix, a pin or the team list. Problems come first.
      </p>
      {machines?.unavailable != null && (
        <p className="identity-settings-muted">Identity cannot list machines: {machines.unavailable}.</p>
      )}
      {available && hosts.length === 0 && <p className="identity-settings-muted">Identity sees no machines yet.</p>}
      {rows.length > 0 && (
        <>
          <div className="identity-settings-field">
            <label htmlFor={`${base}-filter`}>Filter machines</label>
            <input id={`${base}-filter`} type="search" autoComplete="off" value={filter}
              onChange={(event) => setFilter(event.target.value)} />
          </div>
          {shown.length === 0
            ? <p className="identity-settings-muted">No machine matches that filter.</p>
            : (
              <table className="identity-settings-table identity-settings-machines">
                <caption>Machines</caption>
                <thead>
                  <tr>
                    <th scope="col">Machine</th><th scope="col">Kind</th><th scope="col">Owner / from</th>
                    <th scope="col">Status</th><th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row) => (
                    <tr key={row.key} data-row-key={row.key}>
                      <th scope="row" data-label="Machine">{row.name}</th>
                      <td data-label="Kind">
                        <span className="identity-settings-badge" data-kind={row.kind}>
                          <span className="identity-settings-badge-icon" data-status-icon aria-hidden="true">
                            {KINDS[row.kind].icon}
                          </span>
                          <span>{KINDS[row.kind].label}</span>
                        </span>
                      </td>
                      <td data-label="Owner / from">{row.owner}</td>
                      <td data-label="Status"><StatusBadge status={row.status.status} text={row.status.text} /></td>
                      <td data-label="Actions">
                        <div className="identity-settings-stack">
                          <div className="identity-settings-actions">
                            {row.host?.conflict != null && (
                              <>
                                <button type="button" className="identity-settings-button" disabled={busy}
                                  onClick={open("keep", row)}>Keep pin</button>
                                {row.derived !== null && (
                                  <button type="button" className="identity-settings-button" disabled={busy}
                                    onClick={open("repin", row)}>Re-pin to {row.derived.displayName}</button>
                                )}
                                <button type="button" className="identity-settings-button" disabled={busy}
                                  onClick={open("unpin", row)}>Unpin</button>
                              </>
                            )}
                            {row.kind === "team"
                              ? (
                                <button type="button" className="identity-settings-button" disabled={busy}
                                  onClick={open("team-remove", row)}>Remove from team</button>
                              )
                              : (
                                <button type="button" className="identity-settings-button" disabled={busy}
                                  onClick={open("team-add", row)}>Make team machine</button>
                              )}
                          </div>
                          {formError(row.key)}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </>
      )}

      {overview !== null && (
        <>
          <form className="identity-settings-stack" onSubmit={(event) => {
            event.preventDefault();
            const name = addName.trim();
            if (name === "" || busy) return;
            writeTeam("add", addTeamMachine(teamText, name), () => setAddName(""));
          }}>
            <div className="identity-settings-field">
              <label htmlFor={`${base}-add`}>Add a team machine by name</label>
              <input id={`${base}-add`} type="text" autoComplete="off" spellCheck={false} value={addName}
                onChange={(event) => setAddName(event.target.value)} />
            </div>
            <div className="identity-settings-actions">
              <button type="submit" className="identity-settings-button" disabled={addName.trim() === "" || busy}>Add</button>
            </div>
            {formError("add")}
          </form>
          <form className="identity-settings-stack" onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            write("shared-user", async () => {
              const answer = await rpc.call("identity_update_settings", { sharedMachineUser: sharedUser.trim() });
              return answer.ok ? answer : { ok: false, sentence: refusalSentence(answer.reason) };
            });
          }}>
            <div className="identity-settings-field">
              <label htmlFor={`${base}-user`}>Shared machine user</label>
              <input id={`${base}-user`} type="text" autoComplete="off" spellCheck={false} value={sharedUser}
                aria-describedby={`${base}-user-note`} onChange={(event) => setUserDraft(event.target.value)} />
              <p id={`${base}-user-note`} className="identity-settings-muted">
                The account agents run as on team machines. Identity only shows it; it changes nothing on a machine.
              </p>
            </div>
            <div className="identity-settings-actions">
              <button type="submit" className="identity-settings-button" disabled={busy}>Save shared machine user</button>
            </div>
            {formError("shared-user")}
          </form>
        </>
      )}

      {pending !== null && <PendingDialog pending={pending} busy={busy} onConfirm={confirm}
        onCancel={() => { if (!busy) setPending(null); }} />}
    </div>
  );
}

function PendingDialog({ pending: { action, row }, busy, onConfirm, onCancel }: {
  pending: { action: Action; row: Row };
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const host = row.name;
  const pinned = row.host?.kind === "person" ? row.host.person.displayName : "its pinned owner";
  const derived = row.derived?.displayName ?? null;
  const copy: Record<Action, { title: string; confirmLabel: string; destructive?: boolean; consequence: string }> = {
    keep: {
      title: `Keep the pin on ${host}?`, confirmLabel: "Keep pin",
      consequence: derived === null
        ? `${host} stays ${pinned}'s machine even though its name names no one in the directory.`
        : `${host} stays ${pinned}'s machine even though its name says ${derived}.`,
    },
    repin: {
      title: `Re-pin ${host} to ${derived ?? "the name's owner"}?`, confirmLabel: "Re-pin",
      consequence: `${host} becomes ${derived ?? "the name's owner"}'s machine. `
        + `${pinned} starting a thread on ${host} would be refused (rule A) once enforcing.`,
    },
    unpin: {
      title: `Unpin ${host}?`, confirmLabel: "Unpin",
      consequence: `${host} forgets that it is ${pinned}'s. Identity re-derives the owner from the name on next sight.`,
    },
    "team-add": {
      title: `Make ${host} a team machine?`, confirmLabel: "Make team machine",
      consequence: `${host} joins teamMachines. Anyone may start threads here and automations may run here.`,
    },
    "team-remove": {
      title: `Remove ${host} from the team?`, confirmLabel: "Remove from team", destructive: true,
      consequence: `An automation starting a thread on ${host} would be refused (rule C) once enforcing. `
        + "Automations posting into an existing thread are not checked.",
    },
  };
  const { title, confirmLabel, destructive = false, consequence } = copy[action];
  return (
    <ConfirmDialog open title={title} confirmLabel={confirmLabel} destructive={destructive} busy={busy}
      onConfirm={onConfirm} onCancel={onCancel} consequence={<p>{consequence}</p>} />
  );
}
