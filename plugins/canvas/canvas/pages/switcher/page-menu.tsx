import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject, type ReactNode } from "react";
import {
  POPOVER_EDGE_MARGIN_PX,
  placePopoverBox,
  type PopoverRect,
} from "../../dock/popover-place.js";
import { pageDoor } from "../page-door.js";
import type { PageMenuRow } from "../page-menu.js";
import { anchorOf } from "./dom.js";
import { PageMenuView } from "./page-menu-view.js";
import type { PageActions, DispatchPageMenu } from "./types.js";

export function usePageMenu({
  open, query, setQuery, visibleRows, currentPageId, stripRef, tabRefs, actions, dispatchMenu,
}: {
  readonly open: boolean;
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly visibleRows: readonly PageMenuRow[];
  readonly currentPageId: string;
  readonly stripRef: RefObject<HTMLDivElement | null>;
  readonly tabRefs: MutableRefObject<Map<string, HTMLButtonElement>>;
  readonly actions: PageActions;
  readonly dispatchMenu: DispatchPageMenu;
}): ReactNode {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => pageDoor.setOpener(() => dispatchMenu({ type: "palette" })), [dispatchMenu]);

  useEffect(() => {
    if (!open) return;
    function insideWidget(node: Node): boolean {
      const popover = popoverRef.current;
      return popover !== null && (node === popover || popover.contains(node));
    }
    function onPointerDown(event: PointerEvent): void {
      const target = event.target;
      dispatchMenu({ type: "pointerdown", insideWidget: target instanceof Node && insideWidget(target) });
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      dispatchMenu({ type: "escape" });
      tabRefs.current.get(currentPageId)?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, dispatchMenu, currentPageId, tabRefs]);

  const [box, setBox] = useState<PopoverRect>({
    left: POPOVER_EDGE_MARGIN_PX, top: POPOVER_EDGE_MARGIN_PX,
  });
  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const popover = popoverRef.current?.getBoundingClientRect();
      if (!popover) return;
      setBox(placePopoverBox({
        ...anchorOf(stripRef.current), popoverWidth: popover.width, popoverHeight: popover.height,
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
  }, [open, visibleRows.length, query, stripRef]);

  useLayoutEffect(() => {
    if (!open) return;
    setQuery("");
    filterRef.current?.focus();
  }, [open, setQuery]);

  return <PageMenuView open={open} box={box} popoverRef={popoverRef} filterRef={filterRef}
    query={query} visibleRows={visibleRows} actions={actions} setQuery={setQuery} />;
}
