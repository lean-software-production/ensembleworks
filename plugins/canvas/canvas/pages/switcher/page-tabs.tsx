import { Fragment } from "react";
import type { PageMenuRow } from "../page-menu.js";
import { showsDropLineAt, tabDragPaint } from "../tab-drag.js";
import { decideTabContextMenuKey } from "../page-tab-menu.js";
import { dropLineStyle, newTabStyle, pageTabStyle, tabBarStyle } from "./styles.js";
import type { TabDragController } from "./tab-drag.js";

export interface TabStripHandlers {
  readonly addPage: () => void;
  readonly rename: (row: PageMenuRow) => void;
  readonly openTabMenu: (id: string) => void;
}

export function PageTabs({
  rows, handlers, drag, holdTabRef,
}: {
  readonly rows: readonly PageMenuRow[];
  readonly handlers: TabStripHandlers;
  readonly drag: TabDragController;
  readonly holdTabRef: (id: string, node: HTMLButtonElement | null) => void;
}) {
  const { addPage, rename, openTabMenu } = handlers;
  const { presentation, beginTabDrag, dispatchDrag, stripRef } = drag;
  return <div ref={stripRef} style={tabBarStyle} data-canvas-page-tabs>
    {rows.map((row, index) => <Fragment key={row.id}>
      {showsDropLineAt(presentation, index) ? <span data-canvas-page-drop-line style={dropLineStyle} /> : null}
      <button ref={(node) => holdTabRef(row.id, node)} type="button" data-canvas-page-tab={row.id}
        aria-pressed={row.current}
        title="Click to switch pages, drag to reorder, double-click to rename, right-click for more"
        onPointerDown={(event) => beginTabDrag(event, index, row.id)}
        onPointerMove={(event) => dispatchDrag({ type: "move", pointerId: event.pointerId, x: event.clientX })}
        onPointerUp={(event) => dispatchDrag({ type: "up", pointerId: event.pointerId, x: event.clientX })}
        onPointerCancel={() => dispatchDrag({ type: "cancel" })}
        onLostPointerCapture={() => dispatchDrag({ type: "cancel" })}
        onContextMenu={(event) => {
          event.preventDefault();
          openTabMenu(row.id);
        }}
        onKeyDown={(event) => {
          if (!decideTabContextMenuKey(event)) return;
          event.preventDefault();
          openTabMenu(row.id);
        }}
        onClick={() => dispatchDrag({ type: "click", index, id: row.id })}
        onDoubleClick={() => rename(row)}
        style={{ ...pageTabStyle(row.current), ...tabDragPaint(presentation, index) }}>
        {row.name}
      </button>
    </Fragment>)}
    {showsDropLineAt(presentation, rows.length) ? <span data-canvas-page-drop-line style={dropLineStyle} /> : null}
    <button type="button" data-canvas-new-page-tab aria-label="New page" title="New page" onClick={addPage} style={newTabStyle}>＋</button>
  </div>;
}
