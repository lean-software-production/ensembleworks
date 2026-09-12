import type { PluginSidebarProject, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { ViewportSize } from "@ensembleworks/canvas-react";
import type { ScreenBox } from "./agents-view.js";
import type { CanvasAgentLink } from "./wire.js";

/** The small, host-owned slice shown for one canvas-linked thread. */
export interface ThreadOverviewRow {
  readonly link: CanvasAgentLink;
  readonly thread: PluginSidebarThread | null;
  readonly title: string;
  readonly statusLabel: string;
  readonly attentionLabel: string | null;
  readonly activityCount: number;
  readonly projectName: string;
  readonly machineName: string;
  readonly state: "running" | "idle" | "attention" | "failed";
} 

export function threadCardState(link: CanvasAgentLink, thread: PluginSidebarThread | null): ThreadOverviewRow["state"] {
  if (thread?.hasPendingInteraction || thread?.indicator === "waiting-for-input") return "attention";
  if (thread?.indicator === "unread-error") return "failed";
  if (thread?.indicator === "runtime" || thread?.indicator === "working-draft" || threadActivityCount(thread) > 0) return "running";
  if (thread !== null) return thread.indicator === "none" || thread.indicator === "unread-success" || thread.indicator === "draft" ? "idle" : link.status;
  return link.status;
}

/** The live work count exposed by BB for one sidebar thread. */
export function threadActivityCount(thread: PluginSidebarThread | null): number {
  if (thread === null) return 0;
  const { workflows, backgroundAgents, backgroundCommands, planMode, goals } = thread.activity;
  return workflows + backgroundAgents + backgroundCommands + planMode + goals;
}

function titleFor(thread: PluginSidebarThread | null, threadId: string): string {
  const title = thread?.title?.trim() ?? "";
  if (title.length > 0) return title;
  const fallback = thread?.titleFallback?.trim() ?? "";
  return fallback.length > 0 ? fallback : threadId;
}

function statusLabelFor(
  link: CanvasAgentLink,
  thread: PluginSidebarThread | null,
): ThreadOverviewRow["statusLabel"] {
  // The host's label is the current truth when available (including waiting
  // and error states the canvas lifecycle cache cannot represent). The cache
  // remains the honest fallback while the sidebar row is loading or absent.
  if (thread?.indicatorLabel !== null && thread?.indicatorLabel !== undefined) {
    return thread.indicatorLabel;
  }
  switch (link.status) {
    case "running":
      return "Running";
    case "failed":
      return "Failed";
    case "idle":
      return "Idle";
  }
}

/**
 * Join the plugin's durable links to BB's live sidebar cache.
 *
 * Missing rows are retained with the real thread id and lifecycle status. A
 * sidebar cache can briefly lag a link update, and inventing a prompt or
 * summary in that gap would be more misleading than showing the id.
 */
export function threadOverviewRows(
  links: Readonly<Record<string, CanvasAgentLink>>,
  threads: readonly PluginSidebarThread[],
  projects: readonly PluginSidebarProject[] = [],
): ThreadOverviewRow[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  return Object.values(links).map((link) => {
    const thread = byId.get(link.threadId) ?? null;
    let attentionLabel: string | null = null;
    if (thread?.hasPendingInteraction === true) {
      attentionLabel = thread.indicatorLabel ?? "Needs your input";
    } else if (thread?.isUnread === true) {
      attentionLabel = "Unread";
    }
    return {
      link,
      thread,
      title: titleFor(thread, link.threadId),
      statusLabel: statusLabelFor(link, thread),
      attentionLabel,
      activityCount: threadActivityCount(thread),
      projectName: projects.find((project) => project.id === thread?.projectId)?.name ?? thread?.projectId ?? "Project unavailable",
      machineName: thread?.host?.name?.trim() || "Machine unavailable",
      state: threadCardState(link, thread),
    };
  });
}

export const THREAD_CARD_WIDTH = 280;
export const THREAD_CARD_HEIGHT = 208;

/** Stay attached to the shape; never park an offscreen thread at a viewport edge. */
export function threadCardPosition(
  box: ScreenBox,
  viewportSize: ViewportSize,
  zoom = 1,
): { readonly left: number; readonly top: number } | null {
  const left = box.left;
  const top = box.bottom + 8 * zoom;
  // The card is world-sized, including its gap. Keep partially visible cards
  // mounted; the overview layer clips them at the canvas boundary.
  if (left >= viewportSize.width || top >= viewportSize.height ||
    left + THREAD_CARD_WIDTH * zoom <= 0 || top + THREAD_CARD_HEIGHT * zoom <= 0) return null;
  return { left, top };
}
