/**
 * `ui/primitives.tsx` — the small presentational pieces the run UI shares
 * (run-panel redesign): theme colour tokens, buttons, the status pill and
 * dot, the collapsible section header, the timeline bar, and a
 * `localStorage`-backed state hook for remembered UI choices.
 *
 * Colours come from the host theme's CSS variables, each with a fallback for
 * a host that doesn't define it, so nothing renders in a fixed light palette
 * whatever the theme. SVG presentation attributes cannot read CSS variables,
 * so anything SVG takes these through `style`, never `fill=`/`stroke=`.
 */

import { useCallback, useState, type CSSProperties, type ReactNode } from "react";
import type { PillTone, StoryTone } from "./run-model";

export const TOKENS = {
  success: "var(--success, #16a34a)",
  warning: "var(--warning, #d97706)",
  warningText: "var(--warning-text, var(--warning, #b45309))",
  destructive: "var(--destructive, #dc2626)",
  destructiveText: "var(--destructive-text, var(--destructive, #dc2626))",
  brand: "var(--brand, var(--primary, #2563eb))",
  primary: "var(--primary, #2563eb)",
  primaryFg: "var(--primary-foreground, #fff)",
  secondary: "var(--secondary, transparent)",
  secondaryFg: "var(--secondary-foreground, inherit)",
  muted: "var(--muted, rgba(127, 127, 127, 0.15))",
  mutedFg: "var(--muted-foreground, #64748b)",
  border: "var(--border, rgba(127, 127, 127, 0.3))",
  card: "var(--card, transparent)",
  cardFg: "var(--card-foreground, inherit)",
  recessed: "var(--surface-recessed, var(--muted, rgba(127, 127, 127, 0.12)))",
  ring: "var(--ring, var(--primary, #2563eb))",
  radius: "var(--radius, 8px)",
  fontMono: "var(--font-mono, ui-monospace, monospace)",
} as const;

export const TONE_COLOR: Record<PillTone | StoryTone, string> = {
  run: TOKENS.brand,
  warn: TOKENS.warning,
  bad: TOKENS.destructive,
  ok: TOKENS.success,
  muted: TOKENS.mutedFg,
};

export const TONE_TEXT_COLOR: Record<PillTone | StoryTone, string> = {
  run: TOKENS.brand,
  warn: TOKENS.warningText,
  bad: TOKENS.destructiveText,
  ok: TOKENS.success,
  muted: TOKENS.mutedFg,
};

export function Dot({ tone, hollow, title }: { tone: PillTone | StoryTone; hollow?: boolean; title?: string }) {
  return (
    <span
      aria-hidden={title ? undefined : true}
      title={title}
      data-dot={hollow ? "pending" : tone}
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        display: "inline-block",
        flex: "none",
        background: hollow ? "transparent" : TONE_COLOR[tone],
        border: hollow ? `1.5px solid ${TOKENS.mutedFg}` : undefined,
        boxSizing: "border-box",
      }}
    />
  );
}

export function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span
      data-pill={tone}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "1px 8px",
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 600,
        border: `1px solid ${TOKENS.border}`,
        whiteSpace: "nowrap",
      }}
    >
      <Dot tone={tone} />
      {children}
    </span>
  );
}

export type BtnVariant = "primary" | "secondary" | "ghost" | "danger";

const BTN_BASE: CSSProperties = {
  fontFamily: "inherit",
  fontSize: 12,
  lineHeight: 1.3,
  padding: "3px 9px",
  borderRadius: `calc(${TOKENS.radius} - 2px)`,
  border: `1px solid ${TOKENS.border}`,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const BTN_VARIANTS: Record<BtnVariant, CSSProperties> = {
  primary: { background: TOKENS.primary, color: TOKENS.primaryFg, borderColor: TOKENS.primary },
  secondary: { background: TOKENS.secondary, color: TOKENS.secondaryFg },
  ghost: { background: "transparent", color: "inherit" },
  danger: { background: "transparent", color: TOKENS.destructiveText },
};

export function Btn({
  variant = "secondary",
  onClick,
  disabled,
  children,
  title,
  pressed,
  ...rest
}: {
  variant?: BtnVariant;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
  title?: string;
  /** For a toggle (view switchers, chips): rendered with a stronger outline, and exposed as `aria-pressed`. */
  pressed?: boolean;
  "aria-label"?: string;
  "data-testid"?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={pressed}
      {...rest}
      style={{ ...BTN_BASE, ...BTN_VARIANTS[variant], ...(pressed ? { borderColor: "currentColor", fontWeight: 600 } : {}), ...(disabled ? { opacity: 0.55, cursor: "default" } : {}) }}
    >
      {children}
    </button>
  );
}

/** A two-way view switch ("By pass" / "List"), rendered as pressed toggle buttons. */
export function ViewSwitch<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} style={{ display: "flex", gap: 4 }}>
      {options.map((o) => (
        <Btn key={o.value} variant="ghost" pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </Btn>
      ))}
    </div>
  );
}

export const SMALL: CSSProperties = { fontSize: 11.5 };
export const MUTED: CSSProperties = { color: TOKENS.mutedFg };
export const ROW: CSSProperties = { display: "flex", alignItems: "center", gap: 8, minWidth: 0 };
export const SECTION_HEAD: CSSProperties = { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: TOKENS.mutedFg, display: "flex", alignItems: "center", gap: 6 };

/** A bordered-top section of the panel with an uppercase heading. */
export function Section({ title, count, children, testId }: { title: string; count?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} style={{ borderTop: `1px solid ${TOKENS.border}`, paddingTop: 9 }}>
      <div style={SECTION_HEAD}>
        {title}
        {count !== undefined ? <span style={{ textTransform: "none", letterSpacing: 0 }}>· {count}</span> : null}
      </div>
      <div style={{ marginTop: 6 }}>{children}</div>
    </section>
  );
}

/** A collapsible panel section. Not `<details>`: the open state is controlled, so the caller can remember it. */
export function Accordion({ id, title, count, open, onToggle, children }: { id: string; title: string; count?: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section data-accordion={id} data-open={open} style={{ borderTop: `1px solid ${TOKENS.border}`, paddingTop: 9 }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        style={{ ...SECTION_HEAD, background: "none", border: "none", padding: 0, cursor: "pointer", width: "100%", textAlign: "left", fontFamily: "inherit", fontSize: 11 }}
      >
        <span aria-hidden style={{ display: "inline-block", width: 12, fontSize: 14, lineHeight: 1 }}>
          {open ? "▾" : "▸"}
        </span>
        {title}
        {count !== undefined ? <span style={{ textTransform: "none", letterSpacing: 0 }}>· {count}</span> : null}
      </button>
      {open ? <div style={{ marginTop: 8 }}>{children}</div> : null}
    </section>
  );
}

export interface BarSegment {
  /** 0..1 along the shared axis. */
  left: number;
  width: number;
  tone: PillTone | StoryTone;
  faint?: boolean;
}

/** A thin timeline bar: segments placed on one shared axis (a pass, or a fan-out). */
export function TimelineBar({ segments, label }: { segments: BarSegment[]; label?: string }) {
  return (
    <div role={label ? "img" : undefined} aria-label={label} style={{ height: 6, borderRadius: 3, background: TOKENS.muted, position: "relative", flex: 1, minWidth: 40, overflow: "hidden" }}>
      {segments.map((s, i) => (
        <i
          key={i}
          data-segment={s.tone}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            borderRadius: 3,
            left: `${Math.max(0, Math.min(1, s.left)) * 100}%`,
            width: `${Math.max(0.006, Math.min(1, s.width)) * 100}%`,
            background: TONE_COLOR[s.tone],
            opacity: s.faint ? 0.45 : 1,
          }}
        />
      ))}
    </div>
  );
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw === null || raw === undefined ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** `useState` remembered in `localStorage` under `key` (per browser, not per run) — for the panel's open sections and chosen views. */
export function useStoredState<T>(key: string, fallback: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => readStored(key, fallback));
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(next));
      } catch {
        // Storage can be unavailable (private mode, quota): the choice simply isn't remembered.
      }
    },
    [key],
  );
  return [value, set];
}

export const STORAGE_PREFIX = "attractor.run-panel.";
