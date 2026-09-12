import { Markdown, experimental_useSidebarThreads } from "@get-bb/plugin-sdk/app";
import { useState, type ReactNode } from "react";
import type { Camera } from "@ensembleworks/canvas-editor";
import { pageIdOf, type CanvasDocument } from "@ensembleworks/canvas-model";
import type { ViewportSize } from "@ensembleworks/canvas-react";
import { screenBoxFor } from "./agents-view.js";
import { THREAD_CARD_HEIGHT, THREAD_CARD_WIDTH, threadCardPosition, threadOverviewRows } from "./thread-overview.js";
import { useThreadExcerpts } from "./thread-excerpts-ui.js";
import type { CanvasAgentLink } from "./wire.js";

export interface ThreadExcerpt {
  readonly text: string;
  readonly label: string;
}

export type ThreadExcerptMap = Readonly<Record<string, ThreadExcerpt>>;

interface ThreadOverviewProps {
  readonly doc: CanvasDocument;
  readonly camera: Camera;
  readonly viewportSize: ViewportSize;
  readonly currentPageId: string;
  readonly selection: ReadonlySet<string>;
  readonly links: Readonly<Record<string, CanvasAgentLink>>;
  /** Optional host-provided excerpts; the card never invents conversation text. */
  readonly excerpts?: ThreadExcerptMap;
  readonly onOpen: (threadId: string) => void;
}

/** Spatial cards for linked threads, positioned from the linked shape bounds. */
export function ThreadOverview({
  doc,
  camera,
  viewportSize,
  currentPageId,
  selection,
  links,
  excerpts,
  onOpen,
}: ThreadOverviewProps): ReactNode {
  const { threads, projects } = experimental_useSidebarThreads();
  const [visible, setVisible] = useState(true);
  const rows = threadOverviewRows(links, threads, projects);
  const pageThreadIds = new Set(rows.filter((row) => {
    const shape = doc.byId.get(row.link.shapeId);
    return shape !== undefined && pageIdOf(doc, shape) === currentPageId;
  }).map((row) => row.link.threadId));

  const positioned = visible ? rows.flatMap((row) => {
    if (selection.has(row.link.shapeId)) return [];
    const box = screenBoxFor(doc, camera, viewportSize, row.link.shapeId, currentPageId);
    const position = box === null ? null : threadCardPosition(box, viewportSize, camera.z);
    return position === null ? [] : [{ row, position }];
  }) : [];
  const liveExcerpts = useThreadExcerpts(excerpts === undefined ? positioned.map(({ row }) => row.link.threadId) : []);
  const cardExcerpts = excerpts ?? liveExcerpts;
  if (pageThreadIds.size === 0) return null;

  return (
    <div data-canvas-thread-overview className="absolute inset-0 overflow-hidden" style={{ pointerEvents: "none" }}>
      <button
        type="button"
        aria-label={visible ? "Hide linked thread cards" : "Show linked thread cards"}
        aria-pressed={visible}
        onClick={() => setVisible((value) => !value)}
        className="absolute right-2 top-2 z-10 rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground shadow-sm hover:bg-accent"
        style={{ pointerEvents: "auto" }}
      >
        {visible ? `Hide threads (${pageThreadIds.size})` : `Threads (${pageThreadIds.size})`}
      </button>
      {positioned.map(({ row, position }) => {
        const excerpt = cardExcerpts[row.link.threadId];
        const fallbackExcerpt = "Open thread to see the conversation";
        const hasAttention = row.attentionLabel !== null;
        const accentClass = row.state === "attention" ? "border-amber-500/70"
          : row.state === "failed" ? "border-destructive/70"
          : row.state === "running" ? "border-emerald-500/70" : "border-border";
        const stateLabel = { running: "Running", idle: "Idle", attention: "Needs input", failed: "Failed" }[row.state];
        const stateColor = { running: "bg-emerald-500 motion-safe:animate-pulse", idle: "bg-muted-foreground", attention: "bg-amber-500", failed: "bg-destructive" }[row.state];
        const activityLabel = row.activityCount === 0 ? "BB thread" : row.activityCount === 1 ? "1 activity" : `${row.activityCount} activities`;
        return (
          <article
            key={row.link.shapeId}
            data-canvas-thread-card={row.link.threadId}
            aria-label={`Open thread: ${row.title}`}
            onClick={(event) => {
              if (event.target instanceof Element && event.target.closest("a, button, input, textarea, select, [role=button]")) return;
              onOpen(row.link.threadId);
            }}
            className={`absolute overflow-hidden rounded-lg border-2 bg-card p-3 text-left text-xs shadow-md transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${accentClass}`}
            style={{ left: position.left, top: position.top, width: THREAD_CARD_WIDTH, height: THREAD_CARD_HEIGHT, transform: `scale(${camera.z})`, transformOrigin: "top left", pointerEvents: "auto" }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-sm font-semibold text-foreground" title={row.title}>{row.title}</span>
              <span data-canvas-thread-state={row.state} title={row.thread?.indicatorLabel || stateLabel}
                className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-foreground">
                <span aria-hidden className={`size-1.5 rounded-full ${stateColor}`} />{stateLabel}
              </span>
            </div>
            <span className="mt-1 block truncate text-[11px] font-medium text-muted-foreground">{row.statusLabel}</span>
            <span className="mt-2 block text-[10px] uppercase tracking-wide text-muted-foreground">{excerpt?.label || "Conversation"}</span>
            <div className="mt-1 h-[60px] overflow-hidden text-sm leading-5 text-foreground">
              <Markdown
                content={excerpt?.text.trim() || fallbackExcerpt}
                className="text-sm leading-5 [&_p]:my-0 [&_ul]:my-0 [&_ol]:my-0 [&_pre]:my-0 [&_pre]:max-w-full [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm"
              />
            </div>
            <span className="absolute inset-x-3 bottom-9 flex items-center justify-between gap-2">
              <span className={hasAttention ? "min-w-0 truncate font-medium text-amber-700 dark:text-amber-300" : "min-w-0 truncate text-muted-foreground"}>
                {row.attentionLabel ?? activityLabel}
              </span>
              <button type="button" onClick={() => onOpen(row.link.threadId)}
                aria-label={`Open thread: ${row.title}`}
                className="shrink-0 rounded-sm font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Open thread →</button>
            </span>
            <div data-canvas-thread-location className="absolute inset-x-3 bottom-2 flex min-w-0 items-center gap-2 border-t border-border pt-1.5 text-[10px] text-muted-foreground"
              title={`Project: ${row.projectName} · Machine: ${row.machineName}`}>
              <span className="min-w-0 flex-1 truncate" aria-label={`Project: ${row.projectName}`}>{row.projectName}</span>
              <span aria-hidden>·</span>
              <span className="min-w-0 flex-1 truncate text-right" aria-label={`Machine: ${row.machineName}`}>{row.machineName}</span>
            </div>
          </article>
        );
      })}
    </div>
  );
}
