import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";

/**
 * The one confirm dialog every destructive or trust-changing action goes through.
 *
 * Cancel is focused on open, so a stray Enter never confirms; Escape and the overlay
 * cancel; and focus returns to whatever opened it. (Radix returns focus to a
 * `Dialog.Trigger`, and these dialogs are opened by ordinary buttons, so the opener is
 * remembered on open and refocused on close.) A gate — a ticked acknowledgement or a typed word — keeps the
 * confirm button disabled until it is met, and is forgotten every time the dialog closes.
 */
export function ConfirmDialog({
  open,
  title,
  consequence,
  confirmLabel,
  destructive = false,
  gate,
  busy = false,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  consequence: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  gate?: { kind: "checkbox"; label: string } | { kind: "typed"; word: string; label: string };
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const gateId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [ticked, setTicked] = useState(false);
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (open) return;
    setTicked(false);
    setTyped("");
  }, [open]);
  const gateMet = gate === undefined || (gate.kind === "checkbox" ? ticked : typed.trim() === gate.word);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="identity-settings-overlay" />
        <Dialog.Content
          className="identity-settings-dialog"
          aria-describedby={descriptionId}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            cancelRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (openerRef.current?.isConnected) openerRef.current.focus();
            openerRef.current = null;
          }}
        >
          <Dialog.Title className="identity-settings-dialog-title">{title}</Dialog.Title>
          <Dialog.Description asChild>
            <div id={descriptionId} className="identity-settings-dialog-consequence">{consequence}</div>
          </Dialog.Description>
          {children}
          {gate?.kind === "checkbox" && (
            <label className="identity-settings-check" htmlFor={gateId}>
              <input id={gateId} type="checkbox" checked={ticked} onChange={(event) => setTicked(event.target.checked)} />
              {gate.label}
            </label>
          )}
          {gate?.kind === "typed" && (
            <div className="identity-settings-field">
              <label htmlFor={gateId}>{gate.label}</label>
              <input id={gateId} type="text" autoComplete="off" spellCheck={false} value={typed}
                onChange={(event) => setTyped(event.target.value)} />
            </div>
          )}
          <div className="identity-settings-actions identity-settings-dialog-actions">
            <button ref={cancelRef} type="button" className="identity-settings-button" onClick={onCancel}>Cancel</button>
            <button
              type="button"
              className="identity-settings-button"
              data-variant={destructive ? "destructive" : "primary"}
              disabled={!gateMet || busy}
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
