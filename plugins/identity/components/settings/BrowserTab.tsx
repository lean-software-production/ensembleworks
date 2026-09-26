import { useId, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, WhoAmI } from "../../server.js";
import {
  fallbackReach,
  redactEmail,
  validateSelectionOrigin,
  type SettingsPatch,
  type SigningKeyStatus,
} from "../../settings-admin.js";
import { PICKER_CHAIN, precedenceLadder, type RungState } from "../../lib/precedence.js";
import { IdentityPicker } from "../IdentityPicker.js";
import { ConfirmDialog, focusOpener } from "./ConfirmDialog.js";
import { refusalSentence } from "./ProfilePanel.js";
import { StatusBadge } from "./StatusBadge.js";
import type { SettingsData } from "./IdentitySettings.js";

const RUNG_BADGES: Record<RungState, { status: "ok" | "off"; text: string }> = {
  decided: { status: "ok", text: "You are here" },
  skipped: { status: "off", text: "Skipped" },
  "not-reached": { status: "off", text: "Not reached" },
};

const KEY_BADGES: Record<SigningKeyStatus, "ok" | "problem" | "attention"> = {
  valid: "ok",
  invalid: "problem",
  missing: "attention",
};

type Section = "picker" | "origin" | "fallback" | "key";
type Pending =
  | { kind: "picker"; on: boolean }
  | { kind: "origin"; value: string }
  | { kind: "fallback"; value: string }
  | { kind: "rotate" };
type Answer = { ok: true } | { ok: false; reason: string };

/**
 * The This browser tab: why this browser is shown as who it is (the precedence ladder),
 * the picker itself, and the settings the picker depends on. Every write that changes who
 * requests are attributed to — or forgets browsers' choices — is confirmed first.
 */
export function BrowserTab({ data }: { data: SettingsData }) {
  const rpc = useRpc<typeof rpcContract>();
  const base = useId();
  const { overview, roster, whoami, reload, adoptWhoami, revision } = data;
  // null until typed in, so each field follows the settings when a reload lands.
  const [originDraft, setOriginDraft] = useState<string | null>(null);
  const [fallbackDraft, setFallbackDraft] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ section: Section; sentence: string } | null>(null);

  const write = (section: Section, call: () => Promise<Answer>, refused: (reason: string) => string) => {
    setBusy(true);
    setError(null);
    void call().then((answer) => {
      if (!answer.ok) { setError({ section, sentence: refused(answer.reason) }); return; }
      reload();
    }).catch((failure: unknown) => setError({ section, sentence: `Identity could not save the change: ${String(failure)}` }))
      .finally(() => { setBusy(false); setPending(null); });
  };
  const update = (section: Section, patch: SettingsPatch) =>
    write(section, () => rpc.call("identity_update_settings", patch), refusalSentence);
  const confirm = () => {
    if (pending === null) return;
    if (pending.kind === "picker") update("picker", { selfSelectedIdentity: pending.on });
    else if (pending.kind === "origin") update("origin", { selectionPublicOrigin: pending.value });
    else if (pending.kind === "fallback") update("fallback", { fallbackEmail: pending.value, confirmSoleUser: true });
    else {
      write("key", () => rpc.call("identity_rotate_signing_key", { confirm: "rotate" }),
        (reason) => `Identity could not rotate the signing key (${reason}); nothing changed.`);
    }
  };
  const sentenceFor = (section: Section) => error?.section === section
    ? <p className="identity-settings-error">{error.sentence}</p>
    : null;

  const settings = overview?.settings ?? null;
  const origin = (originDraft ?? settings?.selectionPublicOrigin ?? "").trim();
  const originInvalid = origin !== "" && validateSelectionOrigin(origin) === null;
  const saveOrigin = () => {
    if (settings === null || originInvalid) return;
    // The selection cookie is bound to the origin: changing a set one forgets every browser's choice.
    if (settings.selectionPublicOrigin !== "" && origin !== settings.selectionPublicOrigin) {
      setPending({ kind: "origin", value: origin });
    } else update("origin", { selectionPublicOrigin: origin });
  };
  const fallback = (fallbackDraft ?? settings?.fallbackEmail ?? "").trim();
  const saveFallback = () => {
    if (fallback === "") update("fallback", { fallbackEmail: "" });
    else setPending({ kind: "fallback", value: fallback });
  };
  // People seen using this server, not merely listed: a directory names everyone the team might add.
  const looksShared = (overview?.accessSeen ?? false) || (roster?.people.filter((row) => row.seen).length ?? 0) > 1;
  const chainAt = overview === null ? -1 : PICKER_CHAIN.findIndex((step) => step.status === overview.pickerStatus);

  return (
    <div className="identity-settings-stack">
      <h3 className="identity-settings-heading">This browser</h3>
      <p className="identity-settings-muted">
        Which name this browser shows, why, and the settings that let browsers choose one.
      </p>
      {whoami !== null && <Ladder whoami={whoami} fallbackConfigured={(settings?.fallbackEmail ?? "") !== ""} />}
      <IdentityPicker onIdentityChange={adoptWhoami} refreshKey={revision} />

      {settings !== null && overview !== null && (
        <>
          <section className="identity-settings-stack" aria-labelledby={`${base}-picker`}>
            <h4 id={`${base}-picker`} className="identity-settings-heading">Browser names</h4>
            <label className="identity-settings-check">
              <input type="checkbox" checked={settings.selfSelectedIdentity} disabled={busy}
                onChange={(event) => { event.currentTarget.focus(); setPending({ kind: "picker", on: event.target.checked }); }} />
              Let browsers choose a name (Attribution only)
            </label>
            {sentenceFor("picker")}
            <div className="identity-settings-field">
              <label htmlFor={`${base}-origin`}>Public origin</label>
              <input id={`${base}-origin`} type="url" inputMode="url" autoComplete="off" spellCheck={false}
                placeholder="https://bb.example.com" value={originDraft ?? settings.selectionPublicOrigin}
                aria-invalid={originInvalid ? "true" : undefined}
                aria-describedby={originInvalid ? `${base}-origin-error` : undefined}
                onChange={(event) => setOriginDraft(event.target.value)} />
              {originInvalid && (
                <p id={`${base}-origin-error`} className="identity-settings-error">
                  This must be an https origin (or http on localhost) with no path, such as https://bb.example.com.
                </p>
              )}
            </div>
            <div className="identity-settings-actions">
              <button type="button" className="identity-settings-button" disabled={originInvalid || busy}
                onClick={(event) => { focusOpener(event); saveOrigin(); }}>
                Save origin
              </button>
            </div>
            {sentenceFor("origin")}
            <ol aria-label="Picker readiness" className="identity-settings-chain">
              {PICKER_CHAIN.map((step, index) => {
                const here = index === chainAt;
                const ready = step.status === "ready";
                return (
                  <li key={step.status} aria-current={here ? "step" : undefined}>
                    <StatusBadge
                      status={index < chainAt || (here && ready) ? "ok" : here ? "attention" : "off"}
                      text={step.label}
                    />
                    <span className="identity-settings-muted">
                      {index < chainAt ? "Passed." : here ? step.fix : "Not checked yet."}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>

          <section className="identity-settings-stack" aria-labelledby={`${base}-fallback`}>
            <h4 id={`${base}-fallback`} className="identity-settings-heading">Fallback email</h4>
            <p className="identity-settings-muted">
              For a server only one person uses: requests with no Access email and no browser name are attributed to
              it. It never counts for the guardrail.
            </p>
            <div className="identity-settings-field">
              <label htmlFor={`${base}-fallback-email`}>Fallback email</label>
              <input id={`${base}-fallback-email`} type="email" autoComplete="off"
                value={fallbackDraft ?? settings.fallbackEmail} onChange={(event) => setFallbackDraft(event.target.value)} />
            </div>
            <div className="identity-settings-actions">
              <button type="button" className="identity-settings-button" disabled={busy}
                onClick={(event) => { focusOpener(event); saveFallback(); }}>
                Save fallback email
              </button>
            </div>
            {sentenceFor("fallback")}
          </section>

          <section className="identity-settings-stack" aria-labelledby={`${base}-key`}>
            <h4 id={`${base}-key`} className="identity-settings-heading">Signing key</h4>
            <p className="identity-settings-muted">
              Browsers{"'"} chosen names are signed with a key that never leaves the server; only its status is shown.
            </p>
            <StatusBadge status={KEY_BADGES[settings.signingKey]} text={`Signing key: ${settings.signingKey}`} />
            <div className="identity-settings-actions">
              <button type="button" className="identity-settings-button" disabled={busy}
                onClick={(event) => { focusOpener(event); setError(null); setPending({ kind: "rotate" }); }}>
                Rotate signing key
              </button>
            </div>
            {sentenceFor("key")}
          </section>
        </>
      )}

      {pending?.kind === "picker" && (
        <ConfirmDialog
          open
          title={pending.on ? "Let browsers choose a name?" : "Stop browsers choosing a name?"}
          confirmLabel={pending.on ? "Turn on" : "Turn off"}
          busy={busy}
          onConfirm={confirm}
          onCancel={() => { if (!busy) setPending(null); }}
          consequence={pending.on
            ? <p>Anyone who opens BB can pick any name in the directory. A chosen name counts for attribution, never the guardrail.</p>
            : <p>Every browser{"'"}s chosen name stops counting: those browsers show as anonymous, or as the fallback email if one is set.</p>}
        />
      )}
      {pending?.kind === "origin" && (
        <ConfirmDialog
          open
          title="Change the public origin?"
          confirmLabel="Change origin"
          destructive
          busy={busy}
          onConfirm={confirm}
          onCancel={() => { if (!busy) setPending(null); }}
          consequence={
            <>
              <p>
                Every browser{"'"}s chosen name is bound to the current origin, so all of them are forgotten at once;
                each person chooses again.
              </p>
              {pending.value === "" && <p>With no origin set, browsers cannot choose a name until one is saved.</p>}
            </>
          }
        />
      )}
      {pending?.kind === "fallback" && (
        <ConfirmDialog
          open
          title="Set a fallback email?"
          confirmLabel="Set fallback email"
          gate={{ kind: "checkbox", label: "Only one person uses this server" }}
          busy={busy}
          onConfirm={confirm}
          onCancel={() => { if (!busy) setPending(null); }}
          consequence={
            <p>
              {fallbackReach(redactEmail(pending.value))} The guardrail never refuses on it.
              {looksShared ? " This server looks shared." : ""}
            </p>
          }
        />
      )}
      {pending?.kind === "rotate" && (
        <ConfirmDialog
          open
          title="Rotate the signing key?"
          confirmLabel="Rotate key"
          destructive
          gate={{ kind: "typed", word: "rotate", label: "Type rotate to confirm" }}
          busy={busy}
          onConfirm={confirm}
          onCancel={() => { if (!busy) setPending(null); }}
          consequence={<p>Every browser{"'"}s chosen name expires at once. How many browsers that affects cannot be known.</p>}
        />
      )}
    </div>
  );
}

/** "Why am I shown as …?": the four rungs, the deciding one marked. */
function Ladder({ whoami, fallbackConfigured }: { whoami: WhoAmI; fallbackConfigured: boolean }) {
  const headingId = useId();
  const rungs = precedenceLadder(whoami, { fallbackConfigured });
  const shownAs = whoami.person?.displayName ?? whoami.email ?? "anonymous";
  return (
    <section className="identity-settings-stack" aria-labelledby={headingId}>
      <h4 id={headingId} className="identity-settings-heading">Why am I shown as {shownAs}?</h4>
      <ol aria-label="Precedence ladder" className="identity-settings-ladder">
        {rungs.map((rung) => (
          <li key={rung.id} aria-current={rung.state === "decided" ? "step" : undefined}>
            <StatusBadge status={RUNG_BADGES[rung.state].status} text={RUNG_BADGES[rung.state].text} />
            <span className="identity-settings-rung-label">{rung.label}</span>
            {rung.state !== "not-reached" && <span className="identity-settings-muted">{rung.detail}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
