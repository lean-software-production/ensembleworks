import type { CSSProperties } from "react";
import { decideTabRenameKey } from "../tab-rename.js";
import type { PageMenuRow } from "../page-menu.js";
import type { TabRenameEdit } from "./types.js";

/**
 * The inline rename `<input>` — ONE component, drawn by BOTH surfaces that
 * can show a page row (the tab strip and the Pages popover), because "which
 * row is being renamed" has to behave identically in both and a second copy
 * of these four handlers is a second set of answers.
 *
 * WHY THE POPOVER NEEDS IT TOO, rather than always sending the user to the
 * tab: the tab strip is hidden entirely on a narrow panel (page-tabs-fit.ts),
 * and the popover's ✎ has to keep working there — otherwise this fix would
 * only have moved the silent no-op from Electron to a phone.
 *
 * BLUR COMMITS, ESCAPE CANCELS. Clicking away is not a destructive gesture
 * and must not throw typing away; Escape is the one that does, which is the
 * same split canvas-react's FrameNameEditor draws between its end-edit keys.
 * `stopPropagation` on the keydown is load-bearing for Escape specifically:
 * the drag machine and both popovers listen for Escape on window/document,
 * and without it one press would cancel the rename AND dismiss the menu the
 * rename was started from.
 *
 * `select()` ON FOCUS so typing replaces the seeded name instead of appending
 * to it — the same call `handleFrameNameFocus` makes for the frame-header
 * rename, for the same reason.
 */
export function RenameBox({
  row, draft, edit, style, label,
}: {
  readonly row: PageMenuRow;
  readonly draft: string;
  readonly edit: TabRenameEdit;
  readonly style: CSSProperties;
  readonly label: string;
}) {
  return <input type="text" autoFocus
    data-canvas-page-rename={row.id}
    aria-label={label}
    value={draft}
    style={style}
    onChange={(event) => edit.type(row.id, event.target.value)}
    onFocus={(event) => event.target.select()}
    onBlur={() => edit.commit(row)}
    onKeyDown={(event) => {
      const action = decideTabRenameKey(event.key);
      if (action === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === "commit") edit.commit(row);
      else edit.cancel();
    }}
    onPointerDown={(event) => event.stopPropagation()} />;
}
