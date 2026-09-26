import { useCallback, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { ColorWriteAnswer, rpcContract, RosterAnswer } from "../../server.js";
import { seenPhrase, SEEN_UNKNOWN_CAVEAT } from "../../roster.js";
import { recognisedBy } from "../../lib/recognised-by.js";
import { IdentityPicker } from "../IdentityPicker.js";
import { RosterPersonRow } from "./RosterPersonRow.js";
import type { SettingsData } from "./IdentitySettings.js";

type Person = RosterAnswer["people"][number];

/** What an operator pastes back into `ew_bb_people` — the directory's own fields, nothing Identity adds. */
function directoryEntry(row: Person): string {
  return JSON.stringify({ person: row.person, github: row.github, displayName: row.displayName, emails: row.emails }, null, 2);
}

/**
 * The People tab: the directory as a master-detail view. The directory itself is never
 * edited here — infrastructure owns it — so the only write is the colour, through the
 * same two RPCs the old page used.
 */
export function PeopleTab({ data }: { data: SettingsData }) {
  const rpc = useRpc<typeof rpcContract>();
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [colorError, setColorError] = useState<string | null>(null);
  const { overview, roster, machines, reload, adoptWhoami } = data;

  /**
   * One handler for both writes. A refusal comes back as an ANSWER (`ok: false`) rather
   * than a thrown error, so it is shown as a sentence instead of disappearing.
   */
  const write = useCallback((person: string, color: string | null) => {
    setBusy(person);
    const call = color === null
      ? rpc.call("identity_clear_person_color", { person })
      : rpc.call("identity_set_person_color", { person, color });
    void call.then((written: ColorWriteAnswer) => {
      setColorError(written.ok ? null : `Could not change ${person}'s colour: ${written.reason}`);
      reload();
    }).catch((failure: unknown) => {
      setColorError(`Could not change ${person}'s colour: ${String(failure)}`);
    }).finally(() => setBusy(null));
  }, [reload, rpc]);

  const directoryBroken = overview !== null && !overview.directory.ok;
  const people = roster?.people ?? [];
  const current = people.find((row) => row.person === selected) ?? people[0] ?? null;
  const teamMachines = (overview?.settings.teamMachines ?? "").split(/[\s,]+/).filter(Boolean);
  const pickerOn = overview?.settings.selfSelectedIdentity ?? false;

  return (
    <div className="identity-settings-stack">
      <h3 className="identity-settings-heading">People</h3>
      <p className="identity-settings-muted">
        People are managed in infrastructure (<code>ew_bb_people</code>). Colours are Identity{"'"}s own and anyone
        can change them; every change is logged.
      </p>
      <IdentityPicker onIdentityChange={adoptWhoami} />
      <p className="identity-settings-muted">{SEEN_UNKNOWN_CAVEAT}</p>
      {roster?.unavailable != null && (
        <p className="identity-settings-muted">Machines are not listed: {roster.unavailable}.</p>
      )}
      {colorError !== null && <p className="identity-settings-error">{colorError}</p>}
      {directoryBroken
        ? (
          <div role="alert" className="identity-settings-card identity-settings-alert">
            <p>
              The People directory setting is invalid: {overview.directory.error}. Everyone is anonymous and nothing
              is refused until it is fixed.
            </p>
            <p>Fix it either way:</p>
            <ul>
              <li>Fix ew_bb_people in infrastructure and redeploy (the lasting fix).</li>
              <li>Or set it by hand: <code>bb plugin config identity set directory '&lt;json&gt;'</code></li>
            </ul>
          </div>
        )
        : roster === null ? null
        : current === null
          ? (
            <p className="identity-settings-muted">
              Nobody is registered yet. Identity reads its people from the directory setting above, which
              infrastructure manages.
            </p>
          )
          : (
            <div className="identity-settings-master-detail">
              <ul aria-label="People" className="identity-settings-people">
                {people.map((row) => (
                  <li key={row.person}>
                    <button type="button" className="identity-settings-person" aria-pressed={row === current}
                      onClick={() => setSelected(row.person)}>
                      <span aria-hidden="true" className="identity-settings-dot" style={{ background: row.color }} />
                      <span className="identity-settings-person-text">
                        <span className="identity-settings-person-name">{row.displayName}</span>
                        <span className="identity-settings-muted">{seenPhrase(row.seen)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <PersonDetail
                key={current.person}
                row={current}
                busy={busy === current.person}
                onChoose={(color) => write(current.person, color)}
                onReset={() => write(current.person, null)}
                context={{ machines: machines?.machines ?? [], teamMachines, pickerOn }}
              />
            </div>
          )}
    </div>
  );
}

function PersonDetail({ row, busy, onChoose, onReset, context }: {
  row: Person;
  busy: boolean;
  onChoose: (color: string) => void;
  onReset: () => void;
  context: Parameters<typeof recognisedBy>[1];
}) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const entry = directoryEntry(row);
  const copyEntry = () => {
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(entry))
      .then(() => setCopy("copied"), () => setCopy("failed"));
  };
  return (
    <div className="identity-settings-detail">
      <RosterPersonRow row={row} busy={busy} onChoose={onChoose} onReset={onReset} />
      <table className="identity-settings-table">
        <caption>How Identity recognises {row.displayName}</caption>
        <thead>
          <tr><th scope="col">Signal</th><th scope="col">From</th><th scope="col">Counts for</th></tr>
        </thead>
        <tbody>
          {recognisedBy(row, context).map((signal) => (
            <tr key={`${signal.from}:${signal.signal}`}>
              <td data-label="Signal">{signal.signal}</td>
              <td data-label="From">{signal.from}</td>
              <td data-label="Counts for">{signal.countsFor}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="identity-settings-actions">
        <button type="button" className="identity-settings-button" onClick={copyEntry}>Copy directory entry</button>
        {copy === "copied" && <span className="identity-settings-muted">Copied.</span>}
      </div>
      {copy === "failed" && (
        <div className="identity-settings-stack">
          <p className="identity-settings-muted">Copy it from here</p>
          <pre className="identity-settings-pre">{entry}</pre>
        </div>
      )}
    </div>
  );
}
