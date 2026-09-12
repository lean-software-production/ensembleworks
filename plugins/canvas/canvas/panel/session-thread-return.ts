import { useCallback, useEffect, useRef } from "react";
import type { Editor } from "@ensembleworks/canvas-editor";
import { toast } from "sonner";
import { openThreadFromCanvas, threadReturnMemory } from "../thread-navigation.js";
import { restoreThreadReturn } from "../thread-return.js";
import { parseThreadReturnRoute } from "../thread-return-route.js";
import { pageIdFromSubPath } from "../pages/page-route.js";

export function useThreadReturn({ editor, subPath, navigate, cancelAndReset }: {
  editor: Editor;
  subPath: string;
  navigate: { toThread(threadId: string): void };
  cancelAndReset: () => void;
}) {
  const restored = useRef<string | null>(null);
  useEffect(() => {
    const route = parseThreadReturnRoute(subPath);
    if (route === null) { restored.current = null; return; }
    if (restored.current === route.token) return;
    restored.current = route.token;
    const bookmark = threadReturnMemory.forToken(route.token);
    if (bookmark === null || bookmark.pageId !== pageIdFromSubPath(subPath)) return;
    cancelAndReset();
    if (!restoreThreadReturn(editor, bookmark)) {
      toast.message("The original canvas page was deleted. Showing an available page.");
    }
  }, [editor, subPath, cancelAndReset]);

  return useCallback((threadId: string) => {
    cancelAndReset();
    openThreadFromCanvas(editor, threadId, navigate);
  }, [editor, navigate, cancelAndReset]);
}
