import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";
import type { PageMenuRow } from "../page-menu.js";
import {
  CLOSED_PAGE_TAB_MENU,
  nextPageTabMenu,
  pageTabMenuFocusItem,
  pageTabMenuFocusReturn,
  pageTabMenuItems,
  pageTabMenuTarget,
  type PageTabMenuEvent,
  type PageTabMenuItemId,
  type PageTabMenuState,
} from "../page-tab-menu.js";
import { tabDragBlocksContextMenu, type TabDragEvent, type TabDragState } from "../tab-drag.js";
import {
  POPOVER_EDGE_MARGIN_PX,
  placePopoverBox,
  type PopoverRect,
} from "../../dock/popover-place.js";
import { anchorOf } from "./dom.js";
import type { PageActions } from "./types.js";

export interface TabMenuController {
  readonly menuRef: RefObject<HTMLDivElement | null>;
  readonly tabMenuOpenId: PageTabMenuState;
  readonly tabMenuRow: PageMenuRow | null;
  readonly tabMenuItems: ReturnType<typeof pageTabMenuItems>;
  readonly tabMenuBox: PopoverRect;
  readonly openTabMenu: (id: string) => void;
  readonly dispatchTabMenu: (event: PageTabMenuEvent) => void;
  readonly runTabMenuItem: (row: PageMenuRow, id: PageTabMenuItemId) => void;
}

export function useTabMenu({
  rows, actions, dragRef, dispatchDrag, tabRefs,
}: {
  readonly rows: readonly PageMenuRow[];
  readonly actions: PageActions;
  readonly dragRef: MutableRefObject<TabDragState>;
  readonly dispatchDrag: (event: TabDragEvent) => void;
  readonly tabRefs: MutableRefObject<Map<string, HTMLButtonElement>>;
}): TabMenuController {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const tabMenuRef = useRef<PageTabMenuState>(CLOSED_PAGE_TAB_MENU);
  const [tabMenuOpenId, setTabMenuOpenId] = useState<PageTabMenuState>(CLOSED_PAGE_TAB_MENU);

  const dispatchTabMenu = useCallback((event: PageTabMenuEvent): void => {
    const before = tabMenuRef.current;
    const next = nextPageTabMenu(before, event);
    tabMenuRef.current = next;
    setTabMenuOpenId(next);
    const back = pageTabMenuFocusReturn(before, next, event);
    if (back !== null) tabRefs.current.get(back)?.focus();
  }, [tabRefs]);

  const openTabMenu = useCallback((id: string): void => {
    if (tabDragBlocksContextMenu(dragRef.current)) return;
    dispatchDrag({ type: "context-menu" });
    dispatchTabMenu({ type: "open", id });
  }, [dispatchDrag, dispatchTabMenu]);

  const tabMenuRow = pageTabMenuTarget(rows, tabMenuOpenId);
  const tabMenuItems = useMemo(
    () => (tabMenuRow === null ? [] : pageTabMenuItems(tabMenuRow)),
    [tabMenuRow],
  );

  const runTabMenuItem = useCallback((row: PageMenuRow, id: PageTabMenuItemId): void => {
    if (id === "rename") actions.rename(row);
    if (id === "delete") actions.remove(row);
    dispatchTabMenu({ type: "acted" });
  }, [actions, dispatchTabMenu]);

  useLayoutEffect(() => {
    if (tabMenuOpenId === null) return;
    const first = pageTabMenuFocusItem(tabMenuItems);
    if (first === null) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>(`[data-canvas-page-tab-menu-item="${first}"]`)
      ?.focus();
  }, [tabMenuOpenId, tabMenuItems]);

  useEffect(() => {
    if (tabMenuOpenId === null) return;
    function insideMenu(node: Node): boolean {
      const menu = menuRef.current;
      return menu !== null && (node === menu || menu.contains(node));
    }
    function onPointerDown(event: PointerEvent): void {
      const target = event.target;
      dispatchTabMenu({
        type: "pointerdown",
        insideMenu: target instanceof Node && insideMenu(target),
      });
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      dispatchTabMenu({ type: "escape" });
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [tabMenuOpenId, dispatchTabMenu]);

  const [tabMenuBox, setTabMenuBox] = useState<PopoverRect>({
    left: POPOVER_EDGE_MARGIN_PX, top: POPOVER_EDGE_MARGIN_PX,
  });
  useLayoutEffect(() => {
    if (tabMenuOpenId === null) return;
    const place = (): void => {
      const menu = menuRef.current?.getBoundingClientRect();
      if (!menu) return;
      setTabMenuBox(placePopoverBox({
        ...anchorOf(tabRefs.current.get(tabMenuOpenId) ?? null),
        popoverWidth: menu.width, popoverHeight: menu.height,
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
      }));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [tabMenuOpenId, tabMenuItems.length, tabRefs]);

  return { menuRef, tabMenuOpenId, tabMenuRow, tabMenuItems, tabMenuBox, openTabMenu, dispatchTabMenu, runTabMenuItem };
}
