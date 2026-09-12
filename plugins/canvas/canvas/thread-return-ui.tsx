import { useEffect, useState } from "react";
import { useBbNavigate, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { CANVAS_PANEL_PATH } from "./pages/page-route.js";
import { THREAD_RETURN_CHANGED, threadReturnMemory } from "./thread-navigation.js";
import { threadReturnSubPath } from "./thread-return-route.js";

export function CanvasReturnAction({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  const [bookmarks, setBookmarks] = useState(() => threadReturnMemory.visitsForThread(threadId));
  useEffect(() => {
    const refresh = () => setBookmarks(threadReturnMemory.visitsForThread(threadId));
    refresh();
    window.addEventListener(THREAD_RETURN_CHANGED, refresh);
    return () => window.removeEventListener(THREAD_RETURN_CHANGED, refresh);
  }, [threadId]);
  // A reused header may render once with the previous thread's state.
  const visits = bookmarks.filter((bookmark) => bookmark.threadId === threadId);
  const target = visits[0] ?? null;
  const label = target === null ? "Open canvas" : `Back to canvas: ${target.pageName}`;
  // The host exposes a thread id, not the origin pane. Let the user choose
  // when that thread has been entered from several places in this browser tab.
  if (visits.length > 1) return (
    <select
      data-canvas-return={threadId}
      aria-label="Choose a canvas return location"
      title="This thread was opened from several canvas locations"
      value=""
      className="h-7 max-w-44 rounded-md bg-transparent text-xs text-muted-foreground"
      onChange={(event) => {
        const visit = visits.find((bookmark) => bookmark.token === event.target.value);
        if (visit) navigate.toPluginPanel(CANVAS_PANEL_PATH, {
          subPath: threadReturnSubPath(visit.pageId, visit.token),
        });
      }}
    >
      <option value="" disabled>{isCompactViewport ? "← Canvas" : "Back to canvas…"}</option>
      {visits.map((visit, index) => (
        <option key={visit.token} value={visit.token}>
          {visit.pageName} · {index === 0 ? "most recent" : `earlier visit ${index}`}
        </option>
      ))}
    </select>
  );
  return (
    <button
      type="button"
      data-canvas-return={threadId}
      aria-label={label}
      title={label}
      className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={() => navigate.toPluginPanel(CANVAS_PANEL_PATH, {
        subPath: target === null ? "" : threadReturnSubPath(target.pageId, target.token),
      })}
    >
      <span aria-hidden>←</span>
      {isCompactViewport ? null : target === null ? "Canvas" : "Back to canvas"}
    </button>
  );
}
