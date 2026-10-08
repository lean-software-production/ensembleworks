import { useCallback, useRef, useState } from "react";
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
import {
  NO_TAB_RENAME,
  nextTabRename,
  tabRenameDraft,
  type TabRenameEvent,
  type TabRenameState,
} from "../tab-rename.js";
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

  // THE OPEN EDITOR IS MIRRORED IN A REF because the two handlers that end an
  // edit — the box's own keydown and its blur — both have to read the draft
  // that is current at the moment they fire, and a blur can arrive from an
  // input React is in the middle of unmounting, i.e. from a closure older
  // than the last keystroke. The ref is the value; the state exists to
  // re-render the two surfaces that draw the box.
  const renameRef = useRef<TabRenameState | null>(NO_TAB_RENAME);
  const [renameState, setRenameState] = useState<TabRenameState | null>(NO_TAB_RENAME);
  const dispatchRename = useCallback((event: TabRenameEvent): void => {
    const next = nextTabRename(renameRef.current, event);
    renameRef.current = next;
    setRenameState(next);
  }, []);

  // RENAME NOW OPENS AN EDITOR RATHER THAN A DIALOG — see canvas/pages/
  // tab-rename.ts's header for why the `window.prompt` this replaced could
  // never have worked in bb (Electron does not implement it). The `acted`
  // dispatch stays exactly as it was: it is what the Pages popover folds on,
  // and `nextPageMenuOpen` deliberately keeps the popover OPEN for a rename,
  // which is what lets the popover row draw the box the user is about to
  // type in.
  const rename = useCallback((row: PageMenuRow) => {
    dispatchRename({ type: "begin", id: row.id, name: row.name });
    dispatchMenu({ type: "acted", action: "rename" });
  }, [dispatchRename, dispatchMenu]);

  // THE ONLY WRITE PATH, and still through `renamePageIntents` — that
  // function's three refusals (no answer, an emptied box, an unchanged name)
  // are unchanged and still the only place text is judged. What changed is
  // where the text comes from.
  const commitRename = useCallback((row: PageMenuRow) => {
    const draft = tabRenameDraft(renameRef.current, row.id);
    if (draft === null) return;
    dispatchRename({ type: "end" });
    const intents = renamePageIntents(row, draft);
    if (intents.length > 0) editor.applyAll(intents);
  }, [dispatchRename, editor]);

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

  const renameEdit = {
    draftFor: useCallback((id: string) => tabRenameDraft(renameState, id), [renameState]),
    type: useCallback((id: string, text: string) => dispatchRename({ type: "type", id, text }), [dispatchRename]),
    commit: commitRename,
    cancel: useCallback(() => dispatchRename({ type: "end" }), [dispatchRename]),
  };

  return { switchTo, addPage, rename, remove, move, renameEdit };
}
