import { createPortal } from "react-dom";
import type { PageMenuRow } from "../page-menu.js";
import type { PageTabMenuItem, PageTabMenuItemId } from "../page-tab-menu.js";
import { pageTabMenuLabel } from "../page-tab-menu.js";
import { tabMenuItemStyle, tabMenuStyle } from "./styles.js";

export function TabMenuView({
  row, items, box, menuRef, runTabMenuItem,
}: {
  readonly row: PageMenuRow | null;
  readonly items: readonly PageTabMenuItem[];
  readonly box: { left: number; top: number };
  readonly menuRef: React.RefObject<HTMLDivElement | null>;
  readonly runTabMenuItem: (row: PageMenuRow, id: PageTabMenuItemId) => void;
}) {
  if (row === null) return null;
  return createPortal(
    <div ref={menuRef} data-canvas-page-tab-menu
      role="menu" aria-label={pageTabMenuLabel(row)}
      style={{ ...tabMenuStyle, left: box.left, top: box.top }}>
      {items.map((item) => <button key={item.id} type="button" role="menuitem"
        data-canvas-page-tab-menu-item={item.id} disabled={!item.enabled}
        onClick={() => runTabMenuItem(row, item.id)} style={tabMenuItemStyle(item.enabled)}>{item.label}</button>)}
    </div>,
    document.body,
  );
}
