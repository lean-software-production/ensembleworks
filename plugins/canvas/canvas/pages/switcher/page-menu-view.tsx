import { createPortal } from "react-dom";
import { pageMenuEnterTarget, type PageMenuRow } from "../page-menu.js";
import {
  buttonStyle,
  emptyStyle,
  filterStyle,
  microButtonStyle,
  nameButtonStyle,
  popoverStyle,
  rowStyle,
} from "./styles.js";
import type { PageActions } from "./types.js";

export function PageMenuView({
  open,
  box,
  popoverRef,
  filterRef,
  query,
  visibleRows,
  actions,
  setQuery,
}: {
  readonly open: boolean;
  readonly box: { left: number; top: number };
  readonly popoverRef: React.RefObject<HTMLDivElement | null>;
  readonly filterRef: React.RefObject<HTMLInputElement | null>;
  readonly query: string;
  readonly visibleRows: readonly PageMenuRow[];
  readonly actions: PageActions;
  readonly setQuery: (query: string) => void;
}) {
  const { switchTo, addPage, rename, remove, move } = actions;
  if (!open) return null;
  return createPortal(
    <div ref={popoverRef} data-canvas-page-menu
      role="dialog" aria-label="Pages"
      style={{ ...popoverStyle, left: box.left, top: box.top }}>
      <input ref={filterRef} type="text" value={query} aria-label="Filter pages"
        placeholder="Filter pages…" data-canvas-page-filter style={filterStyle}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          const target = pageMenuEnterTarget(visibleRows);
          if (target !== null) switchTo(target);
        }} />
      {visibleRows.length === 0 ? <div style={emptyStyle}>No page matches “{query.trim()}”.</div> :
        visibleRows.map((row) => <div key={row.id} style={rowStyle}>
          <button type="button" data-canvas-page={row.id} aria-pressed={row.current}
            title="Click to switch pages, double-click to rename" onClick={() => switchTo(row)}
            onDoubleClick={() => rename(row)} style={nameButtonStyle(row.current)}>{row.name}</button>
          <button type="button" aria-label={`Rename ${row.name}`} onClick={() => rename(row)} style={microButtonStyle(true)}>✎</button>
          <button type="button" aria-label={`Move ${row.name} left`} disabled={!row.canMoveLeft} onClick={() => move(row, "left")} style={microButtonStyle(row.canMoveLeft)}>◂</button>
          <button type="button" aria-label={`Move ${row.name} right`} disabled={!row.canMoveRight} onClick={() => move(row, "right")} style={microButtonStyle(row.canMoveRight)}>▸</button>
          <button type="button" aria-label={`Delete ${row.name}`} disabled={!row.canDelete} onClick={() => remove(row)} style={microButtonStyle(row.canDelete)}>×</button>
        </div>)}
      <button type="button" data-canvas-new-page onClick={addPage} style={{ ...buttonStyle, marginTop: 2 }}>＋ New page</button>
    </div>,
    document.body,
  );
}
