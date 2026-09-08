import { useCallback } from "react";
import type { Editor } from "@ensembleworks/canvas-editor";
import {
  deletePageIntents,
  movePageIntents,
  newPageIntents,
  type MoveDir,
} from "../page-intents.js";
import {
  renamePageIntents,
  switchPageIntents,
  type PageMenuRow,
} from "../page-menu.js";
import { pageDeletePrompt } from "../page-delete-confirm.js";
import type { DispatchPageMenu, PageActions } from "./types.js";

export function usePageActions(
  editor: Editor,
  dispatchMenu: DispatchPageMenu,
): PageActions {
  const switchTo = useCallback((row: PageMenuRow) => {
    const intents = switchPageIntents(row);
    if (intents.length > 0) editor.applyAll(intents);
    dispatchMenu({ type: "acted", action: "switch" });
  }, [editor, dispatchMenu]);

  const addPage = useCallback(() => {
    editor.applyAll(newPageIntents(editor));
    dispatchMenu({ type: "acted", action: "create" });
  }, [editor, dispatchMenu]);

  const rename = useCallback((row: PageMenuRow) => {
    const intents = renamePageIntents(row, window.prompt("Rename page", row.name));
    if (intents.length > 0) editor.applyAll(intents);
    dispatchMenu({ type: "acted", action: "rename" });
  }, [editor, dispatchMenu]);

  const remove = useCallback((row: PageMenuRow) => {
    const intents = deletePageIntents(editor, row.id);
    const prompt = pageDeletePrompt(row.name, intents.length > 0);
    if (prompt.kind === "ask" && !window.confirm(prompt.message)) return;
    if (intents.length > 0) editor.applyAll(intents);
    dispatchMenu({ type: "acted", action: "delete" });
  }, [editor, dispatchMenu]);

  const move = useCallback((row: PageMenuRow, dir: MoveDir) => {
    const intents = movePageIntents(editor, row.id, dir);
    if (intents.length > 0) editor.applyAll(intents);
    dispatchMenu({ type: "acted", action: "move" });
  }, [editor, dispatchMenu]);

  return { switchTo, addPage, rename, remove, move };
}
