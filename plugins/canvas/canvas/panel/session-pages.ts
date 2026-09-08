import { useEffect, useMemo, useRef } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Editor } from "@ensembleworks/canvas-editor";
import { writeLastPage } from "../pages/last-page.js";
import { usePageSwitcher } from "../pages/PageSwitcher.js";
import {
  createPageRouter,
  pageIdFromSubPath,
  type PageRouter,
} from "../pages/page-route.js";
import {
  createPageDocumentTitle,
  type DocumentTitleHost,
  type PageDocumentTitle,
} from "../pages/page-title.js";
import { ROOM_ID } from "../wire.js";
import { pageMemoryStore } from "./page-memory.js";

type PageSwitcherArgs = Parameters<typeof usePageSwitcher>[0];
type PageSnapshot = PageSwitcherArgs["snapshot"];
type PageEditorState = PageSwitcherArgs["currentPageId"] extends string
  ? { currentPageId: string }
  : never;

export function useSessionPages({
  editor,
  snapshot,
  editorState,
  subPath,
  columnWidth,
}: {
  readonly editor: Editor;
  readonly snapshot: PageSnapshot;
  readonly editorState: PageEditorState;
  readonly subPath: string;
  readonly columnWidth: number;
}) {
  const navigate = useBbNavigate();
  const pageRouterRef = useRef<PageRouter | null>(null);
  pageRouterRef.current ??= createPageRouter();
  const pageRouter = pageRouterRef.current;
  useEffect(() => {
    pageRouter.reconcile(
      {
        subPath,
        currentPageId: editorState.currentPageId,
        livePageIds: snapshot.pages.map((page) => page.id),
      },
      {
        apply: (intent) => editor.apply(intent),
        navigate,
      },
    );
  }, [pageRouter, editor, navigate, subPath, editorState.currentPageId, snapshot.pages]);

  const titleHost = useMemo<DocumentTitleHost>(
    () => ({
      read: () => document.title,
      write: (title) => {
        document.title = title;
      },
    }),
    [],
  );
  const pageTitleRef = useRef<PageDocumentTitle | null>(null);
  pageTitleRef.current ??= createPageDocumentTitle(titleHost);
  const pageTitle = pageTitleRef.current;
  useEffect(() => {
    pageTitle.sync({
      pages: snapshot.pages,
      currentPageId: editorState.currentPageId,
    });
  }, [pageTitle, snapshot.pages, editorState.currentPageId]);
  useEffect(() => () => pageTitle.restore(), [pageTitle]);

  useEffect(() => {
    writeLastPage(pageMemoryStore(), ROOM_ID, editorState.currentPageId);
  }, [editorState.currentPageId]);

  const pageSwitcher = usePageSwitcher({
    editor,
    snapshot,
    currentPageId: editorState.currentPageId,
    containerWidth: columnWidth,
  });

  return { navigate, pageSwitcher };
}

export { pageIdFromSubPath };
