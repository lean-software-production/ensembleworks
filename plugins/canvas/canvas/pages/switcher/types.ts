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

export interface PageActions {
  readonly switchTo: (row: PageMenuRow) => void;
  readonly addPage: () => void;
  readonly rename: (row: PageMenuRow) => void;
  readonly remove: (row: PageMenuRow) => void;
  readonly move: (row: PageMenuRow, dir: MoveDir) => void;
}

export type DispatchPageMenu = (event: PageMenuEvent) => void;
