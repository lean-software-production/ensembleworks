import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, WhoAmI } from "../server.js";

const REFRESH_MS = 5_000;

/**
 * The browser-name picker, moved out of app.tsx so both the app overlays and the settings
 * page can mount it without an import cycle. Behaviour and accessible names are unchanged.
 */
export function IdentityPicker({ onIdentityChange }: { onIdentityChange?: (identity: WhoAmI) => void } = {}) {
  const rpc = useRpc<typeof rpcContract>();
  const selectorId = useId();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const onIdentityChangeRef = useRef(onIdentityChange);
  onIdentityChangeRef.current = onIdentityChange;
  const [me, setMe] = useState<WhoAmI | null>(null);
  const [choice, setChoice] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const result = await rpcRef.current.call("identity_whoami");
    setMe(result);
    onIdentityChangeRef.current?.(result);
    return result;
  }, []);
  useEffect(() => {
    void refresh().catch(() => undefined);
    const timer = window.setInterval(() => void refresh().catch(() => undefined), REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh().catch(() => undefined); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [refresh]);
  const mutate = async (action: "select" | "forget") => {
    setBusy(true);
    setError(null);
    try {
      const prepared = await rpcRef.current.call("identity_prepare_selection",
        action === "select" ? { action, personId: choice } : { action });
      if (!prepared.ok) throw new Error(`Identity could not prepare this choice: ${prepared.reason}.`);
      const response = await fetch(prepared.url, { method: "GET", credentials: "same-origin", cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { reason?: unknown } | null;
        const reason = typeof payload?.reason === "string" ? `: ${payload.reason}` : "";
        throw new Error(`Identity could not ${action === "select" ? "select" : "forget"} this name (${response.status}${reason}).`);
      }
      const current = await refresh();
      if (action === "select" && (current.provenance !== "self-selected" || current.person?.person !== choice)) {
        throw new Error("The browser did not retain this choice. Check whether site cookies are allowed.");
      }
      setEditing(false);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  if (me === null || me.picker.status === "off" || me.provenance === "upstream-header") return null;
  if (!me.picker.enabled) return <p role="status" style={{ fontSize: 12 }}>Browser identity is unavailable: {me.picker.status}.</p>;
  if (me.picker.people.length === 0) return <p role="status" style={{ fontSize: 12 }}>No names are configured in Identity yet.</p>;
  const chosen = me.provenance === "self-selected" && me.person !== null;
  return <div className="identity-picker" aria-label="Browser identity" style={{ marginTop: 12, paddingTop: 12,
    borderTop: "1px solid var(--border)", minWidth: 0 }}>
    <strong style={{ display: "block" }}>This browser</strong>
    <p style={{ margin: "4px 0 8px", fontSize: 12 }}>{chosen
      ? `Shown as ${me.person!.displayName} (chosen here; attribution only).`
      : me.selection?.status === "stale"
        ? "Your earlier choice is no longer in the directory. Choose again."
        : "Choose a name for attribution in this browser. This does not verify who you are."}</p>
    {chosen && !editing ? <div className="identity-picker-actions">
      <button type="button" onClick={() => setEditing(true)}>Switch</button>
      <button type="button" disabled={busy} onClick={() => void mutate("forget")}>Forget</button>
    </div> : <div className="identity-picker-actions">
      <label htmlFor={selectorId}>Your name</label>
      <select id={selectorId} value={choice} onChange={(event) => setChoice(event.target.value)}>
        <option value="">Choose a name</option>
        {me.picker.people.map((person) => <option key={person.person} value={person.person}>{person.displayName}</option>)}
      </select>
      <button type="button" disabled={busy || !choice} onClick={() => void mutate("select")}>Use this name</button>
      {chosen && <button type="button" onClick={() => setEditing(false)}>Cancel</button>}
    </div>}
    {error && <p role="alert" style={{ color: "var(--destructive, #b91c1c)", fontSize: 12 }}>{error}</p>}
  </div>;
}
