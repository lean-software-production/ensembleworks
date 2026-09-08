import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  filterPageRows,
  nextPageMenuOpen,
  pageMenuRows,
  type PageMenuEvent,
} from "../page-menu.js";
import { choosePageTabsVisible, nextPageTabsVisible } from "../page-tabs-fit.js";
import { usePageActions } from "./actions.js";
import { PageTabs } from "./page-tabs.js";
import { usePageMenu } from "./page-menu.js";
import { useTabDrag } from "./tab-drag.js";
import { TabMenuView } from "./tab-menu-view.js";
import { useTabMenu } from "./tab-menu.js";
import type { PageSwitcherInput, PageSwitcherNodes } from "./types.js";

export function usePageSwitcher(input: PageSwitcherInput): PageSwitcherNodes {
  const { editor, snapshot, currentPageId, containerWidth } = input;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tabsVisible, setTabsVisible] = useState(() => choosePageTabsVisible(containerWidth));
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const holdTabRef = useCallback((id: string, node: HTMLButtonElement | null): void => {
    if (node === null) tabRefs.current.delete(id);
    else tabRefs.current.set(id, node);
  }, []);

  const dispatchMenu = useCallback((event: PageMenuEvent) => {
    setOpen((current) => nextPageMenuOpen(current, event));
  }, []);
  const rows = useMemo(
    () => pageMenuRows(snapshot.pages, currentPageId),
    [snapshot.pages, currentPageId],
  );
  const visibleRows = useMemo(() => filterPageRows(rows, query), [rows, query]);
  const actions = usePageActions(editor, dispatchMenu);
  const drag = useTabDrag(editor, rows, actions.switchTo);
  const tabMenuState = useTabMenu({
    rows, actions, dragRef: drag.dragRef, dispatchDrag: drag.dispatchDrag, tabRefs,
  });
  const pageMenu = usePageMenu({
    open, query, setQuery, visibleRows, currentPageId, stripRef: drag.stripRef,
    tabRefs, actions, dispatchMenu,
  });

  useEffect(() => {
    setTabsVisible((visible) => nextPageTabsVisible(visible, containerWidth));
  }, [containerWidth]);

  const tabs = !tabsVisible ? null : <PageTabs rows={rows}
    handlers={{ addPage: actions.addPage, rename: actions.rename, openTabMenu: tabMenuState.openTabMenu }}
    drag={drag} holdTabRef={holdTabRef} />;
  const popover = pageMenu;
  const tabMenu = <TabMenuView row={tabMenuState.tabMenuRow} items={tabMenuState.tabMenuItems}
    box={tabMenuState.tabMenuBox} menuRef={tabMenuState.menuRef}
    runTabMenuItem={tabMenuState.runTabMenuItem} />;
  const overlays = <>{popover}{tabMenu}</>;
  return { tabs, overlays };
}
