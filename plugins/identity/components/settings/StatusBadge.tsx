import type { LintSeverity, ReadinessStatus } from "../../settings-admin.js";

/** A glyph per status, so no status is ever told by colour alone. */
const ICONS: Record<ReadinessStatus | LintSeverity, string> = {
  ok: "✓",
  attention: "!",
  off: "○",
  problem: "✕",
  error: "✕",
  warning: "!",
  info: "i",
};

/** Icon + text. The icon is decorative: the text always carries the status on its own. */
export function StatusBadge({ status, text }: { status: ReadinessStatus | LintSeverity; text: string }) {
  return (
    <span className="identity-settings-badge" data-status={status}>
      <span className="identity-settings-badge-icon" data-status-icon aria-hidden="true">{ICONS[status]}</span>
      <span>{text}</span>
    </span>
  );
}
