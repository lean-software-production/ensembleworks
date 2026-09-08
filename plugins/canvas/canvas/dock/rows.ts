import { canvasBus } from "../panel-bus.js";
import {
  planRowDecorations,
  rowDecorationState,
  threadRowPresence,
  type RowPresence,
  type RowSlot,
} from "./thread-status.js";
import { locatedTabs, mergeRoster, resolveSelfName, type DockRosterEntry } from "./model.js";
import { parseLocation } from "./where.js";

const THREAD_ROW_LINK = "a[data-sidebar-thread-id]";
const ROW_TITLE_INSET = "span.bb-sidebar-hover-actions-inset";
const ROW_DECORATION = "[data-canvas-row-presence]";

export interface DockRows {
  readonly sync: () => void;
  readonly clear: () => void;
  readonly retire: () => void;
}

export interface DockRowsOptions {
  readonly root: HTMLElement;
  readonly roster: () => readonly DockRosterEntry[];
  readonly selfIdentity: () => string | null;
  readonly isDisposed: () => boolean;
  readonly clearHostStatus: ((threadId: string, value: null) => void) | undefined;
}

export function createDockRows(options: DockRowsOptions): DockRows {
  let writes = 0;

  const decorationOf = (inset: HTMLElement): HTMLElement | null => {
    const found = inset.querySelectorAll<HTMLElement>(ROW_DECORATION);
    for (let index = 1; index < found.length; index += 1) found[index]!.remove();
    return found[0] ?? null;
  };

  const sync = (): void => {
    if (options.isDisposed()) return;
    const { roster, av } = canvasBus.snapshot();
    const presence = threadRowPresence(
      locatedTabs(mergeRoster(roster, options.roster())).map((tab) => ({
        name: tab.name,
        location: parseLocation(tab.path),
      })),
      resolveSelfName(roster, av.self, options.selfIdentity()),
    );
    let failed = false;
    let rows: { readonly threadId: string; readonly inset: HTMLElement }[] = [];
    try {
      rows = Array.from(document.querySelectorAll<HTMLElement>(THREAD_ROW_LINK))
        .map((link) => ({
          threadId: link.dataset.sidebarThreadId ?? "",
          inset: link.parentElement?.querySelector<HTMLElement>(ROW_TITLE_INSET) ?? null,
        }))
        .filter((row): row is { threadId: string; inset: HTMLElement } =>
          row.threadId !== "" && row.inset !== null,
        );
      const slots: RowSlot[] = rows.map((row) => {
        const existing = decorationOf(row.inset);
        return {
          threadId: row.threadId,
          signature: existing?.dataset.canvasRowPresence ?? null,
          leading: existing !== null && row.inset.firstChild === existing,
        };
      });
      for (const step of planRowDecorations(slots, presence)) {
        const inset = rows[step.index]!.inset;
        writes += 1;
        if (step.action === "remove") {
          decorationOf(inset)?.remove();
        } else if (step.action === "move") {
          inset.insertBefore(decorationOf(inset)!, inset.firstChild);
        } else {
          const node = decorationOf(inset) ?? createRowDecoration();
          paintRowDecoration(node, step.presence);
          if (inset.firstChild !== node) inset.insertBefore(node, inset.firstChild);
        }
      }
    } catch {
      failed = true;
    }
    options.root.dataset.dockRowDecor = rowDecorationState(rows.length, failed);
    options.root.dataset.dockRows = String(document.querySelectorAll(ROW_DECORATION).length);
    options.root.dataset.dockRowWrites = String(writes);
  };

  return {
    sync,
    clear: () => {
      for (const node of Array.from(document.querySelectorAll(ROW_DECORATION))) node.remove();
    },
    retire: () => {
      if (options.clearHostStatus === undefined) return;
      try {
        for (const link of Array.from(document.querySelectorAll<HTMLElement>(THREAD_ROW_LINK))) {
          const id = link.dataset.sidebarThreadId;
          if (id !== undefined && id !== "") options.clearHostStatus(id, null);
        }
      } catch {
        // Host status cleanup is best effort during migration.
      }
    },
  };
}

function createRowDecoration(): HTMLElement {
  const node = document.createElement("span");
  node.className = "canvas-row-presence";
  node.setAttribute("role", "img");
  node.dataset.canvasRowPresence = "";
  return node;
}

function paintRowDecoration(node: HTMLElement, presence: RowPresence): void {
  node.textContent = "";
  for (const face of presence.faces) {
    const circle = document.createElement("span");
    circle.className = "canvas-row-face";
    circle.dataset.canvasRowFace = face.name;
    circle.dataset.canvasRowSelf = face.isSelf ? "true" : "false";
    circle.style.background = face.color;
    circle.textContent = face.initials;
    circle.setAttribute("aria-hidden", "true");
    node.appendChild(circle);
  }
  if (presence.overflow > 0) {
    const more = document.createElement("span");
    more.className = "canvas-row-more";
    more.textContent = `+${presence.overflow}`;
    more.setAttribute("aria-hidden", "true");
    node.appendChild(more);
  }
  node.title = presence.label;
  node.setAttribute("aria-label", presence.label);
  node.dataset.canvasRowPresence = presence.signature;
}
