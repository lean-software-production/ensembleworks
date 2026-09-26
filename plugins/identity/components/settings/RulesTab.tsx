import { useId, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server.js";
import { ENFORCEMENT_MODES, type EnforcementMode } from "../../audit.js";
import type { GuardrailRule } from "../../guardrail.js";
import { AUDIT_JQ_COMMAND, type ReadinessStatus } from "../../settings-admin.js";
import { COVERAGE_ROWS, type CoverageStatus } from "../../lib/coverage.js";
import { simulate, type SimMachine, type SimOutcome, type SimWhat, type SimWho } from "../../lib/simulator.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { refusalSentence } from "./ProfilePanel.js";
import { StatusBadge } from "./StatusBadge.js";
import { useCopy } from "./useCopy.js";
import type { SettingsData } from "./IdentitySettings.js";

const MODES: Record<EnforcementMode, { label: string; sentence: string }> = {
  off: { label: "Off", sentence: "Record and label only; never refuse." },
  audit: { label: "Audit", sentence: "Take the same decision Enforce would and write it to the log — let everything through." },
  enforce: {
    label: "Enforce",
    sentence: "Refuse a known person's start on someone else's machine, their message into someone else's thread, "
      + "and an automation off a team machine.",
  },
};

const WHO: Record<SimWho, string> = {
  "access-person": "A person, from their Access email",
  "browser-name": "A person, from a name chosen in a browser",
  fallback: "The fallback email",
  anonymous: "Nobody identified (an agent or the CLI)",
  automation: "The automations plugin",
};
const WHAT: Record<SimWhat, string> = {
  start: "Start a new thread",
  "follow-up-own": "Send into a thread they started",
  "follow-up-others": "Send into a thread someone else started",
};
const MACHINE: Record<SimMachine, string> = {
  own: "Their own machine",
  "another-persons": "Another person's machine",
  team: "A team machine",
  unclaimed: "An unclaimed machine",
};

const RULES: Record<GuardrailRule, string> = {
  "start-on-another-persons-machine": "Rule A: a start on another person's machine",
  "follow-up-by-non-starter": "Rule B: a message into someone else's thread",
  "automation-off-team-machine": "Rule C: an automation off a team machine",
};
const RESULTS: Record<SimOutcome["result"], { status: ReadinessStatus; text: string }> = {
  allowed: { status: "ok", text: "Allowed" },
  "logged-would-refuse": { status: "attention", text: "Allowed, logged as would refuse" },
  refused: { status: "problem", text: "Refused" },
};

const COVERAGE: Record<CoverageStatus, { status: ReadinessStatus; icon: string; text: string }> = {
  checked: { status: "ok", icon: "✓", text: "Checked" },
  "seen-after": { status: "attention", icon: "◐", text: "Seen after" },
  "logged-only": { status: "off", icon: "≡", text: "Logged only" },
  blind: { status: "problem", icon: "∅", text: "Blind" },
};

/**
 * The Rules tab: the enforcement mode, how to read the audit log (there is deliberately
 * no log in the UI), a simulator over the real guardrail decision, and the coverage map.
 */
export function RulesTab({ data }: { data: SettingsData }) {
  return (
    <div className="identity-settings-stack">
      <h3 className="identity-settings-heading">Rules</h3>
      <p className="identity-settings-muted">
        What the guardrail does in each mode, how to see what it would refuse, and which paths it can see at all.
      </p>
      <Enforcement data={data} />
      <AuditEvidence command={data.overview?.auditCommand ?? AUDIT_JQ_COMMAND} />
      <Simulator />
      <Coverage />
    </div>
  );
}

function Enforcement({ data }: { data: SettingsData }) {
  const rpc = useRpc<typeof rpcContract>();
  const base = useId();
  const { overview, reload } = data;
  const radios = useRef(new Map<EnforcementMode, HTMLInputElement>());
  // The mode just written, shown until a settings read issued after the write lands.
  const [chosen, setChosen] = useState<{ mode: EnforcementMode; over: typeof overview } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (overview === null) return null;
  const saved = overview.settings.enforcement;
  const current = chosen !== null && chosen.over === overview ? chosen.mode : saved;

  const save = (mode: EnforcementMode, acknowledged: boolean) => {
    setBusy(true);
    setError(null);
    const patch = acknowledged ? { enforcement: mode, acknowledgeEnforce: true } : { enforcement: mode };
    void rpc.call("identity_update_settings", patch).then((answer) => {
      if (!answer.ok) { setError(refusalSentence(answer.reason)); return; }
      setChosen({ mode, over: overview });
      reload();
    }).catch((failure: unknown) => setError(`Identity could not save the change: ${String(failure)}`))
      .finally(() => { setBusy(false); setConfirming(false); });
  };
  const choose = (mode: EnforcementMode) => {
    if (mode === current) return;
    if (mode !== "enforce") { save(mode, false); return; }
    // The dialog hands focus back to whatever held it on open: the mode still checked, so
    // cancelling leaves the previous choice both checked and focused.
    radios.current.get(current)?.focus();
    setError(null);
    setConfirming(true);
  };
  const risks = overview.enforceRisks;

  return (
    <section className="identity-settings-stack" aria-labelledby={`${base}-mode`}>
      <h4 id={`${base}-mode`} className="identity-settings-heading">Enforcement</h4>
      <div role="radiogroup" aria-labelledby={`${base}-mode`} className="identity-settings-modes">
        {ENFORCEMENT_MODES.map((mode) => (
          <label key={mode} className="identity-settings-radio identity-settings-mode">
            <input
              ref={(node) => { if (node === null) radios.current.delete(mode); else radios.current.set(mode, node); }}
              type="radio"
              name={`${base}-enforcement`}
              value={mode}
              checked={current === mode}
              disabled={busy}
              aria-labelledby={`${base}-${mode}-label`}
              aria-describedby={`${base}-${mode}-sentence`}
              onChange={() => choose(mode)}
            />
            <span className="identity-settings-stack">
              <span id={`${base}-${mode}-label`} className="identity-settings-rung-label">{MODES[mode].label}</span>
              <span id={`${base}-${mode}-sentence`} className="identity-settings-muted">{MODES[mode].sentence}</span>
            </span>
          </label>
        ))}
      </div>
      {error !== null && <p className="identity-settings-error">{error}</p>}
      <ConfirmDialog
        open={confirming}
        title="Turn on Enforce?"
        confirmLabel="Turn on Enforce"
        destructive
        gate={{ kind: "checkbox", label: "I have read the audit log and understand who would be refused" }}
        busy={busy}
        onConfirm={() => save("enforce", true)}
        onCancel={() => { if (!busy) setConfirming(false); }}
        consequence={
          <>
            <p>Enforce refuses what audit only logs. From machine state, Identity can tell this much:</p>
            {risks.length > 0
              ? <ul>{risks.map((risk) => <li key={risk}>{risk}</li>)}</ul>
              : <p>Identity cannot predict anyone being refused from machine state alone.</p>}
            <p>Rule B (someone else{"'"}s thread) cannot be predicted — check the audit log.</p>
          </>
        }
      />
    </section>
  );
}

function AuditEvidence({ command }: { command: string }) {
  const base = useId();
  const { state, copy } = useCopy();
  return (
    <section className="identity-settings-stack identity-settings-core-zone" aria-labelledby={`${base}-evidence`}>
      <h4 id={`${base}-evidence`} className="identity-settings-heading">Audit evidence</h4>
      <span className="identity-settings-core">Needs BB core: a plugin log query</span>
      <p className="identity-settings-muted">
        Identity keeps no log in the UI — by decision. To see what the guardrail would refuse, run:
      </p>
      <pre className="identity-settings-pre"><code>{command}</code></pre>
      <div className="identity-settings-actions">
        <button type="button" className="identity-settings-button" onClick={() => copy(command)}>Copy command</button>
        {state === "copied" && <span className="identity-settings-muted">Copied.</span>}
        {state === "failed" && (
          <span className="identity-settings-muted">This browser would not copy it. Copy it from here: the command above.</span>
        )}
      </div>
    </section>
  );
}

function Simulator() {
  const base = useId();
  const [who, setWho] = useState<SimWho>("access-person");
  const [what, setWhat] = useState<SimWhat>("start");
  const [machine, setMachine] = useState<SimMachine>("another-persons");
  const outcomes = simulate({ who, what, machine });
  const select = <T extends string>(id: string, label: string, value: T, options: Record<T, string>, set: (next: T) => void) => (
    <div className="identity-settings-field">
      <label htmlFor={`${base}-${id}`}>{label}</label>
      <select id={`${base}-${id}`} value={value} onChange={(event) => set(event.target.value as T)}>
        {(Object.keys(options) as T[]).map((key) => <option key={key} value={key}>{options[key]}</option>)}
      </select>
    </div>
  );
  return (
    <section className="identity-settings-stack" aria-labelledby={`${base}-sim`}>
      <h4 id={`${base}-sim`} className="identity-settings-heading">What would the guardrail do?</h4>
      <div className="identity-settings-sim">
        {select("who", "Who", who, WHO, setWho)}
        {select("what", "What", what, WHAT, setWhat)}
        {select("machine", "Machine", machine, MACHINE, setMachine)}
      </div>
      <table className="identity-settings-table identity-settings-sim-out" aria-live="polite">
        <caption>Outcome in each mode</caption>
        <thead>
          <tr>{outcomes.map((outcome) => <th key={outcome.mode} scope="col">{MODES[outcome.mode].label}</th>)}</tr>
        </thead>
        <tbody>
          <tr>
            {outcomes.map((outcome) => (
              <td key={outcome.mode} data-label={MODES[outcome.mode].label}>
                <div className="identity-settings-stack">
                  <StatusBadge status={RESULTS[outcome.result].status} text={RESULTS[outcome.result].text} />
                  {outcome.rule !== null && (
                    <details>
                      <summary>{RULES[outcome.rule]}</summary>
                      <p className="identity-settings-muted">{outcome.message}</p>
                    </details>
                  )}
                </div>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      {who === "automation" && what !== "start" && (
        <p className="identity-settings-muted">
          An automation sending into an existing thread arrives unstamped, so the guardrail cannot tell it is an
          automation at all.
        </p>
      )}
      <p className="identity-settings-muted">
        Runs Identity{"'"}s real guardrail decision in your browser. Browser names and the fallback email are never
        refused.
      </p>
      <p className="identity-settings-muted">In this example Alex is asking and Sam is someone else.</p>
    </section>
  );
}

function Coverage() {
  return (
    <details className="identity-settings-disclosure">
      <summary>Where the guardrail can and cannot see</summary>
      <table className="identity-settings-table">
        <caption>Coverage of BB paths</caption>
        <thead>
          <tr><th scope="col">Path</th><th scope="col">Guardrail</th><th scope="col">Note</th></tr>
        </thead>
        <tbody>
          {COVERAGE_ROWS.map((row) => (
            <tr key={row.path}>
              <th scope="row" data-label="Path">{row.path}</th>
              <td data-label="Guardrail">
                <span className="identity-settings-badge" data-status={COVERAGE[row.status].status}>
                  <span className="identity-settings-badge-icon" data-status-icon aria-hidden="true">
                    {COVERAGE[row.status].icon}
                  </span>
                  <span>{COVERAGE[row.status].text}</span>
                </span>
              </td>
              <td data-label="Note">{row.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
