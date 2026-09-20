import { useCallback, useEffect, useState, type PointerEvent, type RefObject } from "react";
import { type CanvasDocument } from "@ensembleworks/canvas-model";
import { screenToWorld, type Editor } from "@ensembleworks/canvas-editor";
import type { CanvasSession } from "@ensembleworks/canvas-ui";
import { createUnlinkedIssueShape } from "./github-draft-model.js";

export function useGithubIssueDraft(editor: Editor, canvas: CanvasSession, snapshot: CanvasDocument, viewportRef: RefObject<HTMLDivElement | null>) {
  const [placing, setPlacing] = useState(false); const cancel = useCallback(() => setPlacing(false), []);
  const arm = useCallback(() => {
    if (placing) { cancel(); return; } canvas.selectTool("select"); setPlacing(true);
  }, [canvas, placing, cancel]);
  const createAt = useCallback((screenX: number, screenY: number) => {
    const pageId = editor.get().currentPageId; const shape = createUnlinkedIssueShape({ point: screenToWorld(editor.get().camera, { x: screenX, y: screenY }),
      pageId, siblings: snapshot.shapes.filter((candidate) => candidate.parentId === pageId), newId: () => `shape:${crypto.randomUUID()}` });
    canvas.dispatch([{ type: "CreateShape", shape }, { type: "SetSelection", ids: [shape.id] }]);
    setPlacing(false);
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`[data-shape-id="${shape.id}"] input[aria-label="GitHub issue URL"]`)?.focus());
  }, [canvas, editor, snapshot]);
  const place = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!placing || (event.target as Element).closest("[data-canvas-interactive]")) return;
    const viewport = viewportRef.current; if (!viewport) return;
    event.preventDefault(); event.stopPropagation(); const bounds = viewport.getBoundingClientRect();
    createAt(event.clientX - bounds.left, event.clientY - bounds.top);
  }, [placing, viewportRef, createAt]);
  const openAtCenter = useCallback(() => {
    if (!placing) return;
    const viewport = viewportRef.current; if (!viewport) return; createAt(viewport.clientWidth / 2, viewport.clientHeight / 2);
  }, [placing, viewportRef, createAt]);
  useEffect(() => {
    if (!placing) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); } };
    document.addEventListener("keydown", onKey, true); return () => document.removeEventListener("keydown", onKey, true);
  }, [placing, cancel]);
  return { placing, arm, place, openAtCenter, cancel };
}
