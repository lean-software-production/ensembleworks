import type { CanvasDocument } from "@ensembleworks/canvas-model";
import type { Editor } from "@ensembleworks/canvas-editor";
import type { ReactNode } from "react";
import type { MoveDir } from "../page-intents.js";
import type { PageMenuEvent, PageMenuRow } from "../page-menu.js";

export interface PageSwitcherInput {
  readonly editor: Editor;
  readonly snapshot: CanvasDocument;
  readonly currentPageId: string;
  readonly containerWidth: number;
}

export interface PageSwitcherNodes {
  readonly tabs: ReactNode;
  readonly overlays: ReactNode;
}

/**
 * The open inline rename editor, as the two surfaces that draw a page row
 * need to see it. `draftFor` returns `null` for every row that is not being
 * renamed — i.e. "draw the ordinary button" — never `""`, which is a real
 * draft (a box the user cleared). See canvas/pages/tab-rename.ts.
 */
export interface TabRenameEdit {
  readonly draftFor: (id: string) => string | null;
  readonly type: (id: string, text: string) => void;
  readonly commit: (row: PageMenuRow) => void;
  readonly cancel: () => void;
}

export interface PageActions {
  readonly switchTo: (row: PageMenuRow) => void;
  readonly addPage: () => void;
  /** OPENS the inline editor on `row`. It does NOT write — `renameEdit.commit`
   * is the only write path (a `window.prompt` used to be this function's whole
   * body; bb's Electron host never showed it). */
  readonly rename: (row: PageMenuRow) => void;
  readonly remove: (row: PageMenuRow) => void;
  readonly move: (row: PageMenuRow, dir: MoveDir) => void;
  readonly renameEdit: TabRenameEdit;
}

export type DispatchPageMenu = (event: PageMenuEvent) => void;
