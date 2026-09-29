import type { ReactNode } from "react";
import type { ReadinessStatus } from "../../settings-admin.js";
import { StatusBadge } from "./StatusBadge.js";

/** A checklist folded to its one-line verdict; it starts open when something needs fixing. */
export function ChecklistSummary({ status, summary, open, children }: {
  status: ReadinessStatus; summary: string; open: boolean; children: ReactNode;
}) {
  return (
    <details className="identity-settings-checklist" open={open}>
      <summary><StatusBadge status={status} text={summary} /></summary>
      {children}
    </details>
  );
}
