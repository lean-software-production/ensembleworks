import { useId, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, SettingsOverview } from "../../server.js";
import type { LintSeverity, ReadinessStatus } from "../../settings-admin.js";
import { PickerChain } from "./PickerChain.js";
import { StatusBadge } from "./StatusBadge.js";
import { useCopy } from "./useCopy.js";
import type { SettingsData } from "./IdentitySettings.js";

type Leg = { label: string; status: ReadinessStatus; text: string; detail: string };

/** The self-test's three legs: the first two share its result, the cookie bridge has its own. */
function selfTestLegs(selfTest: SettingsOverview["selfTest"]): Leg[] {
  const labels = ["Patch live", "Access email reaches Identity", "Cookie bridge"];
  if (selfTest === null) {
    return labels.map((label) => ({ label, status: "off", text: "Not run yet", detail: "" }));
  }
  const leg = (label: string, ok: boolean, detail: string): Leg => ok
    ? { label, status: "ok", text: "Passed", detail }
    : { label, status: "problem", text: "Failed", detail };
  return [
    leg(labels[0]!, selfTest.ok, selfTest.detail),
    leg(labels[1]!, selfTest.ok, selfTest.detail),
    leg(labels[2]!, selfTest.cookie.ok, selfTest.cookie.detail),
  ];
}

const SEVERITY: Record<LintSeverity, { rank: number; text: string }> = {
  error: { rank: 0, text: "Error" },
  warning: { rank: 1, text: "Warning" },
  info: { rank: 2, text: "Info" },
};

/**
 * The Health tab: the self-test and its re-run, the picker chain, how full the ledgers
 * are, configuration checks worst first, and a redacted diagnostics bundle to copy.
 */
export function HealthTab({ data }: { data: SettingsData }) {
  const { overview } = data;
  return (
    <div className="identity-settings-stack">
      <h3 className="identity-settings-heading">Health</h3>
      <p className="identity-settings-muted">
        Whether Identity can see who is asking, whether browsers can choose a name, and what to fix first.
      </p>
      {overview !== null && (
        <>
          <SelfTest data={data} />
          <section className="identity-settings-stack">
            <h4 className="identity-settings-heading">Browser names</h4>
            <PickerChain status={overview.pickerStatus} />
          </section>
          <Ledgers ledgers={overview.ledgers} />
          <Checks lint={overview.lint} />
        </>
      )}
      <Diagnostics />
    </div>
  );
}

function SelfTest({ data }: { data: SettingsData }) {
  const rpc = useRpc<typeof rpcContract>();
  const base = useId();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rerun = () => {
    setRunning(true);
    setError(null);
    void rpc.call("identity_rerun_self_test", {})
      .then(() => data.reload())
      .catch((failure: unknown) => setError(`Identity could not run the self-test: ${String(failure)}`))
      .finally(() => setRunning(false));
  };
  return (
    <section className="identity-settings-stack" aria-labelledby={`${base}-self-test`}>
      <h4 id={`${base}-self-test`} className="identity-settings-heading">Self-test</h4>
      <ul aria-label="Self-test" className="identity-settings-chain">
        {selfTestLegs(data.overview?.selfTest ?? null).map((leg) => (
          <li key={leg.label}>
            <span className="identity-settings-rung-label">{leg.label}</span>
            <StatusBadge status={leg.status} text={leg.text} />
            {leg.detail !== "" && <span className="identity-settings-muted">{leg.detail}</span>}
          </li>
        ))}
      </ul>
      <div className="identity-settings-actions">
        <button type="button" className="identity-settings-button" disabled={running}
          aria-busy={running ? "true" : undefined} onClick={rerun}>
          {running ? "Running the self-test again…" : "Run the self-test again"}
        </button>
      </div>
      {error !== null && <p className="identity-settings-error">{error}</p>}
    </section>
  );
}

function Ledgers({ ledgers }: { ledgers: SettingsOverview["ledgers"] }) {
  const base = useId();
  const rows = [
    { key: "starters", label: "Thread starters", ...ledgers.starters },
    { key: "queued", label: "Queued requesters", ...ledgers.queued },
  ];
  return (
    <section className="identity-settings-stack" aria-labelledby={`${base}-ledgers`}>
      <h4 id={`${base}-ledgers`} className="identity-settings-heading">Ledgers</h4>
      {rows.map((row) => (
        <div key={row.key} className="identity-settings-ledger">
          <span>{row.label}: {row.count ?? "unknown"} of {row.max}</span>
          {row.count !== null && <meter min={0} max={row.max} value={row.count} aria-label={row.label} />}
        </div>
      ))}
      <p className="identity-settings-muted">Oldest entries are dropped beyond the limit.</p>
    </section>
  );
}

function Checks({ lint }: { lint: SettingsOverview["lint"] }) {
  const base = useId();
  const sorted = [...lint].sort((a, b) => SEVERITY[a.severity].rank - SEVERITY[b.severity].rank);
  return (
    <section className="identity-settings-stack" aria-labelledby={`${base}-checks`}>
      <h4 id={`${base}-checks`} className="identity-settings-heading">Configuration checks</h4>
      {sorted.length === 0
        ? <p className="identity-settings-muted">No configuration problems found.</p>
        : (
          <ul aria-label="Configuration checks" className="identity-settings-chain">
            {sorted.map((issue) => (
              <li key={issue.id}>
                <StatusBadge status={issue.severity} text={SEVERITY[issue.severity].text} />
                <span>{issue.message}</span>
                <span className="identity-settings-muted">{issue.fix}</span>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

function Diagnostics() {
  const rpc = useRpc<typeof rpcContract>();
  const base = useId();
  const { state, copy, reset } = useCopy();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read only on request: the bundle is built fresh each time it is copied, so an
  // earlier "Copied." or hand-copy text never stands in for this request's outcome.
  const collect = () => {
    setError(null);
    setText(null);
    reset();
    void rpc.call("identity_diagnostics", {}).then((answer) => {
      setText(answer.text);
      copy(answer.text);
    }).catch((failure: unknown) => setError(`Identity could not build the diagnostics: ${String(failure)}`));
  };
  return (
    <section className="identity-settings-stack" aria-labelledby={`${base}-diagnostics`}>
      <h4 id={`${base}-diagnostics`} className="identity-settings-heading">Diagnostics</h4>
      <p className="identity-settings-muted">
        Emails are shortened, people{"'"}s names and the signing key are left out. Host names are included.
      </p>
      <div className="identity-settings-actions">
        <button type="button" className="identity-settings-button" onClick={collect}>Copy diagnostics</button>
        {state === "copied" && <span className="identity-settings-muted">Copied.</span>}
      </div>
      {error !== null && <p className="identity-settings-error">{error}</p>}
      {state === "failed" && text !== null && (
        <>
          <p className="identity-settings-muted">This browser would not copy it. Copy it from here:</p>
          <pre className="identity-settings-pre">{text}</pre>
        </>
      )}
    </section>
  );
}
