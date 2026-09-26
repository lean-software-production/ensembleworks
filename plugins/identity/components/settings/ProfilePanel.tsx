import { useId, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, SettingsOverview, WhoAmI } from "../../server.js";
import {
  profileRecommendation,
  SERVER_PROFILES,
  type ServerProfile,
  type WritableSettings,
} from "../../settings-admin.js";

const PROFILE_LABELS: Record<ServerProfile, string> = {
  access: "Cloudflare Access",
  direct: "Direct, without Access",
  solo: "Only me",
};

/** Every refusal `identity_update_settings` can answer with, as a sentence a person can act on. */
export const SETTINGS_REFUSALS: Record<string, string> = {
  "empty-patch": "There was nothing to change.",
  "enforce-needs-acknowledgement": "Enforce needs its risks acknowledged first; nothing changed.",
  "fallback-needs-sole-user": "The fallback email needs confirmation that only one person uses this server; nothing changed.",
  "fallback-not-an-email": "The fallback email is not an email address; nothing changed.",
  "origin-invalid": "The public origin must be an https origin (or http on localhost); nothing changed.",
  "shared-user-invalid": "The shared machine user is not a valid account name; nothing changed.",
  "write-failed": "BB did not save the settings. Nothing changed; try again.",
};

export function refusalSentence(reason: string): string {
  return SETTINGS_REFUSALS[reason] ?? `Identity refused the change (${reason}); nothing changed.`;
}

/**
 * The first-run question: how do people reach this server? Choosing a profile only
 * previews what would change; nothing is written until Apply, and Apply sends exactly
 * the patch the preview shows.
 */
export function ProfilePanel({ overview, whoami, closable, onApplied, onClose }: {
  overview: SettingsOverview;
  whoami: WhoAmI | null;
  closable: boolean;
  onApplied: () => void;
  onClose: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const base = useId();
  const [choice, setChoice] = useState<ServerProfile | null>(null);
  const [email, setEmail] = useState(whoami?.email ?? "");
  const [soleUser, setSoleUser] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { signingKey: _signingKey, ...current } = overview.settings;
  const myEmail = choice === "solo" ? email.trim() : whoami?.email ?? null;
  const recommendation = choice === null ? null
    : profileRecommendation(choice, current satisfies WritableSettings, { myEmail, browserOrigin: window.location.origin });
  const ready = choice !== null && !busy && (choice !== "solo" || (email.trim().length > 0 && soleUser));

  const apply = () => {
    if (recommendation === null) return;
    setBusy(true);
    setError(null);
    void rpc.call("identity_update_settings", recommendation.patch).then((answer) => {
      if (!answer.ok) { setError(refusalSentence(answer.reason)); return; }
      onApplied();
    }).catch((failure: unknown) => setError(`Identity could not save the settings: ${String(failure)}`))
      .finally(() => setBusy(false));
  };

  return (
    <section className="identity-settings-card identity-settings-profile" aria-labelledby={`${base}-question`}>
      <h3 id={`${base}-question`} className="identity-settings-heading">How do people reach this BB server?</h3>
      <div role="radiogroup" aria-labelledby={`${base}-question`} className="identity-settings-radios">
        {SERVER_PROFILES.map((profile) => (
          <label key={profile} className="identity-settings-radio">
            <input type="radio" name={`${base}-profile`} value={profile} checked={choice === profile}
              onChange={() => { setChoice(profile); setError(null); }} />
            {PROFILE_LABELS[profile]}{profile === "access" && overview.accessSeen ? " — detected" : ""}
          </label>
        ))}
      </div>
      {choice === "solo" && (
        <div className="identity-settings-stack">
          <div className="identity-settings-field">
            <label htmlFor={`${base}-email`}>Your email</label>
            <input id={`${base}-email`} type="email" autoComplete="email" value={email}
              onChange={(event) => setEmail(event.target.value)} />
          </div>
          <label className="identity-settings-check">
            <input type="checkbox" checked={soleUser} onChange={(event) => setSoleUser(event.target.checked)} />
            Only one person uses this server
          </label>
        </div>
      )}
      {recommendation !== null && (
        <>
          {recommendation.changes.length === 0
            ? <p className="identity-settings-muted">This server already matches that profile.</p>
            : (
              <table className="identity-settings-table">
                <caption>Now → Recommended</caption>
                <thead>
                  <tr><th scope="col">Setting</th><th scope="col">Now</th><th scope="col">Recommended</th></tr>
                </thead>
                <tbody>
                  {recommendation.changes.map((change) => (
                    <tr key={change.setting}>
                      <td data-label="Setting">{change.label}</td>
                      <td data-label="Now">{change.now}</td>
                      <td data-label="Recommended">{change.recommended}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          {recommendation.notes.map((note) => <p key={note} className="identity-settings-muted">{note}</p>)}
        </>
      )}
      {error !== null && <p className="identity-settings-error">{error}</p>}
      <div className="identity-settings-actions">
        <button type="button" className="identity-settings-button" data-variant="primary" disabled={!ready} onClick={apply}>
          Apply
        </button>
        {closable && <button type="button" className="identity-settings-button" onClick={onClose}>Close</button>}
      </div>
    </section>
  );
}
