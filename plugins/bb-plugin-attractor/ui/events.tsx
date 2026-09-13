/**
 * `ui/events.tsx` — the paged event timeline, per
 * docs/plans/2026-09-13-attractor-runner-plan.md T5: "Panel: … event
 * timeline (paged)". Reads only `engine/types.ts`'s pure `RunEvent` union
 * (see ui/dag.tsx's header comment on the app-bundle boundary).
 */

import { useState } from "react";
import type { RunEvent } from "../engine/types";

export const PAGE_SIZE = 50;

export type EventView = RunEvent & { seq: number };

/** One-line human summary of a run event, for the timeline row. */
export function describeEvent(event: EventView): string {
  switch (event.type) {
    case "run.started":
      return "Run started";
    case "run.completed":
      return `Run completed: ${event.status}${event.goalGateFailures.length ? ` (goal gate failed: ${event.goalGateFailures.join(", ")})` : ""}`;
    case "run.failed":
      return `Run failed: ${event.error}`;
    case "run.cancelled":
      return "Run cancelled";
    case "stage.started":
      return `${event.nodeId} started (visit ${event.visit}, attempt ${event.attempt})`;
    case "stage.completed":
      return `${event.nodeId} completed: ${event.outcome.status}`;
    case "stage.failed":
      return `${event.nodeId} failed: ${event.error}${event.willRetry ? " (will retry)" : ""}`;
    case "stage.skipped":
      return `${event.nodeId} skipped: ${event.reason}`;
    case "edge.selected":
      return `${event.from} → ${event.to} (${event.reason}${event.edgeLabel ? `: ${event.edgeLabel}` : ""})`;
    case "agent.thread":
      return `${event.stageId}: worker thread ${event.threadId}`;
    case "human.requested":
      return `${event.nodeId}: human input requested`;
    case "human.answered":
      return `${event.nodeId}: human answered${event.answer ? `: ${event.answer}` : ""}`;
    case "checkpoint.saved":
      return `Checkpoint saved at ${event.stageId}`;
    case "log":
      return event.message;
    default:
      return (event as { type: string }).type;
  }
}

export interface EventTimelineProps {
  events: EventView[];
}

/** Paged, oldest-first-within-page event log. Starts on the most recent page. */
export function EventTimeline({ events }: EventTimelineProps) {
  const pageCount = Math.max(1, Math.ceil(events.length / PAGE_SIZE));
  const [page, setPage] = useState(pageCount - 1);
  const clampedPage = Math.min(page, pageCount - 1);
  const start = clampedPage * PAGE_SIZE;
  const pageEvents = events.slice(start, start + PAGE_SIZE);

  if (events.length === 0) return <p>No events yet.</p>;

  return (
    <div data-testid="attractor-event-timeline">
      <ul style={{ listStyle: "none", margin: 0, padding: 0, fontSize: 12, fontFamily: "monospace" }}>
        {pageEvents.map((event) => (
          <li key={event.seq} data-event-seq={event.seq} data-event-type={event.type}>
            <span style={{ color: "#64748b" }}>#{event.seq}</span> {describeEvent(event)}
          </li>
        ))}
      </ul>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={clampedPage === 0}>
          Older
        </button>
        <span>
          Page {clampedPage + 1} of {pageCount}
        </span>
        <button type="button" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={clampedPage >= pageCount - 1}>
          Newer
        </button>
      </div>
    </div>
  );
}
