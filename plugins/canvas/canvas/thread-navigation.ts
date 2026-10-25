import type { Editor } from "@ensembleworks/canvas-editor";
import type { PageMemoryStore } from "./pages/last-page.js";
import { createReturnMemory, type ReturnBookmark } from "./thread-return.js";

function browserReturnStore(): PageMemoryStore | null {
  try { return window.sessionStorage; } catch { return null; }
}

// Local to this browser tab. Every entry is addressed by thread AND return token;
// there is no global pending return for another split pane to accidentally consume.
export const threadReturnMemory = createReturnMemory(browserReturnStore());
export const THREAD_RETURN_CHANGED = "canvas-thread-return-changed";

export function openThreadFromCanvas(
  editor: Editor,
  threadId: string,
  navigate: { toThread(threadId: string): void },
  save: (bookmark: ReturnBookmark) => void = (bookmark) => {
    threadReturnMemory.save(bookmark);
    window.dispatchEvent(new Event(THREAD_RETURN_CHANGED));
  },
  token: string = crypto.randomUUID(),
): void {
  const state = editor.get();
  save({
    token,
    threadId,
    pageId: state.currentPageId,
    pageName: (editor.doc.listPages().find((page) => page.id === state.currentPageId)?.name.trim() || "Canvas").slice(0, 300),
    camera: { ...state.camera },
    selection: [...state.selection],
  });
  navigate.toThread(threadId);
}
