import type { RosterAnswer } from "../../server.js";
import { initials } from "../../presence-labels.js";
import { seenPhrase, SEEN_UNKNOWN_CAVEAT } from "../../roster.js";
import { colorInputValue, shouldCommitColor } from "../../person-colors.js";

/**
 * One person's colour row, moved from app.tsx for the People tab's detail pane.
 *
 * Anyone may change anyone's colour. That is the owner's decision and it matches the
 * plugin's trust model (a guardrail against mistakes; the Access email header is never
 * verified), plus a teammate who never opens this page still needs a colour someone can
 * fix for them. What makes it safe is visibility, not permission: every change writes an
 * audit line naming who changed whose, from and to.
 */

/** A small, fixed set of well-separated colours, so the common case is one click. */
export const SWATCHES = [
  "#b4322e", "#b9651b", "#9a7b10", "#3f7d33", "#1f7a6b",
  "#2f6bb8", "#5b4bc4", "#96379a", "#b02e6e", "#5b6570",
] as const;

export function RosterPersonRow({
  row,
  busy,
  onChoose,
  onReset,
}: {
  row: RosterAnswer["people"][number];
  busy: boolean;
  onChoose: (color: string) => void;
  onReset: () => void;
}) {
  const inputId = `identity-color-${row.person}`;
  return (
    <div
      style={{
        alignItems: "flex-start",
        borderTop: "1px solid var(--border)",
        display: "flex",
        gap: 12,
        opacity: busy ? 0.6 : 1,
        padding: "12px 0",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          alignItems: "center",
          background: row.color,
          borderRadius: 999,
          // The ink is chosen FROM the fill, so a pale choice is still readable. See
          // person-colors.ts for why the ink adapts rather than the choice being clamped.
          color: row.ink,
          display: "inline-flex",
          flex: "0 0 auto",
          fontSize: 12,
          fontWeight: 700,
          height: 32,
          justifyContent: "center",
          width: 32,
        }}
      >
        {initials(row.displayName)}
      </span>

      <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 4, minWidth: 0 }}>
        <div style={{ alignItems: "baseline", display: "flex", flexWrap: "wrap", gap: 8 }}>
          <span style={{ fontWeight: 600 }}>{row.displayName}</span>
          <span style={{ color: "var(--muted-foreground)", fontSize: 12 }}>{row.person}</span>
          <span style={{ color: "var(--muted-foreground)", fontSize: 12 }}>@{row.github}</span>
        </div>
        <span style={{ color: "var(--muted-foreground)", fontSize: 12, wordBreak: "break-all" }}>
          {row.emails.join(", ")}
        </span>
        <span style={{ color: "var(--muted-foreground)", fontSize: 12 }}>
          {row.machines.length > 0
            ? `Machines: ${row.machines.join(", ")}`
            : "No machines of their own are known"}
        </span>
        {/* The caveat is stated ONCE, under the heading. Repeating it on every row —
            which is what the first version did, and what looking at the rendered page
            showed — buried the rows it was supposed to qualify under three copies of the
            same sentence. It stays reachable per-row as the title. */}
        <span style={{ color: "var(--muted-foreground)", fontSize: 12 }} title={SEEN_UNKNOWN_CAVEAT}>
          {seenPhrase(row.seen)}
        </span>

        {row.clashesWith.length > 0 && (
          <span style={{ color: "var(--warning, #b45309)", fontSize: 12 }}>
            ⚠ This colour reads the same as {row.clashesWith.join(", ")}
            {"'"}s. Still applied — pick another if you want them to look different.
          </span>
        )}

        <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
          {SWATCHES.map((swatch) => (
            <button
              key={swatch}
              type="button"
              disabled={busy}
              onClick={() => onChoose(swatch)}
              aria-label={`Give ${row.displayName} the colour ${swatch}`}
              aria-pressed={row.color === swatch}
              title={swatch}
              style={{
                background: swatch,
                border: row.color === swatch ? "2px solid var(--foreground)" : "1px solid var(--border)",
                borderRadius: 999,
                cursor: busy ? "default" : "pointer",
                // 40px so every target meets the settings page's minimum.
                height: 40,
                padding: 0,
                width: 40,
              }}
            />
          ))}
          <label htmlFor={inputId} style={{ color: "var(--muted-foreground)", fontSize: 12, marginLeft: 4 }}>
            Custom
          </label>
          <input
            id={inputId}
            type="color"
            disabled={busy}
            // ALWAYS #rrggbb — see colorInputValue. A dealt colour is an hsl() string,
            // which this element cannot hold; handing it one made the browser coerce the
            // value and write the coerced colour back as a "choice" nobody made.
            value={colorInputValue(row)}
            onChange={(event) => {
              // A native picker fires input and change in one tick; a pick that changes
              // nothing is not a pick.
              if (!shouldCommitColor(row, event.target.value)) return;
              onChoose(event.target.value);
            }}
            style={{ background: "none", border: "none", height: 40, padding: 0, width: 48 }}
          />
          <span style={{ color: "var(--muted-foreground)", fontSize: 12 }}>
            {row.overridden ? "chosen" : "dealt"}
          </span>
          {row.overridden && (
            <button
              type="button"
              disabled={busy}
              onClick={onReset}
              style={{
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--foreground)",
                cursor: busy ? "default" : "pointer",
                fontSize: 12,
                minHeight: 40,
                padding: "0 12px",
              }}
            >
              Reset to dealt
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
