/**
 * One stylesheet, owned and removed by the content script that injected it.
 *
 * Two rules it does not break:
 *
 * - EVERY SELECTOR IS SCOPED to a root this widget owns (`#ewzp-row-root` or
 *   `#ewzp-popover`), so nothing here can restyle bb. The ids come from the same
 *   constants the DOM is built from, so the sheet and the elements cannot drift
 *   apart. tests/presence-styles.test.ts holds that invariant.
 * - IT INHERITS COLOUR, NOT VARIABLES. A host's CSS custom properties are not a
 *   contract offered to plugins, so the row takes `color: inherit` from the
 *   sidebar it sits in and paints its own surfaces with neutral alphas that land
 *   correctly on a light and a dark theme alike. The popover lives in `<body>`
 *   and therefore states a colour of its own.
 */

export const ROW_ROOT_ID = "ewzp-row-root";
export const POPOVER_ID = "ewzp-popover";
export const STYLE_ID = "ewzp-styles";

export const presenceStyles = (): string => `
#${ROW_ROOT_ID} {
  display: block;
  width: 100%;
  flex: 0 0 auto;
  padding: 0 4px 2px;
  box-sizing: border-box;
  font: inherit;
  color: inherit;
}
#${ROW_ROOT_ID} .ewzp-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  height: 36px;
  min-height: 36px;
  max-height: 36px;
  padding: 0 8px;
  margin: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  box-sizing: border-box;
}
#${ROW_ROOT_ID} .ewzp-row:hover,
#${ROW_ROOT_ID} .ewzp-row[aria-expanded="true"] { background: rgba(128, 134, 145, 0.16); }
#${ROW_ROOT_ID} .ewzp-row:focus-visible { outline: 2px solid rgba(128, 134, 145, 0.9); outline-offset: -2px; }
#${ROW_ROOT_ID} .ewzp-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#${ROW_ROOT_ID} .ewzp-note { flex: 0 0 auto; opacity: 0.65; font-size: 11px; }
#${ROW_ROOT_ID} .ewzp-count { flex: 0 0 auto; font-size: 11px; opacity: 0.8; }
#${ROW_ROOT_ID} .ewzp-chevron { flex: 0 0 auto; opacity: 0.5; font-size: 10px; }
#${ROW_ROOT_ID}[data-tier="rail"] { padding: 0 2px 2px; }
#${ROW_ROOT_ID}[data-tier="rail"] .ewzp-row { justify-content: center; gap: 4px; padding: 0 4px; }
.ewzp-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(128, 134, 145, 0.8);
}
.ewzp-dot[data-state="live"] { background: #4cae72; }
.ewzp-dot[data-state="connecting"] { background: #b58b46; }
.ewzp-dot[data-state="interrupted"] { background: #c98a3a; }
.ewzp-faces { display: flex; align-items: center; gap: 3px; flex: 0 0 auto; }
.ewzp-face {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: rgba(128, 134, 145, 0.26);
  color: inherit;
  font-size: 9px;
  line-height: 1;
  letter-spacing: 0.02em;
  overflow: hidden;
  flex: 0 0 auto;
}
.ewzp-face img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ewzp-face[data-speaking="true"] { box-shadow: 0 0 0 1.5px #4cae72; }
.ewzp-face.ewzp-more { background: rgba(128, 134, 145, 0.18); font-size: 9px; }
#${POPOVER_ID} {
  position: fixed;
  z-index: 2147483000;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid rgba(128, 134, 145, 0.35);
  /* Follows the app's own colour scheme rather than declaring one: bb sets it
     on the document, and a popover that insisted on light would be a white
     card in the middle of a dark app. */
  background: light-dark(#ffffff, #1d1e24);
  color: light-dark(#1b1c20, #ededee);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.35);
  font: 12px/1.45 system-ui, -apple-system, sans-serif;
  overflow: hidden;
}
#${POPOVER_ID}[hidden] { display: none; }
#${POPOVER_ID} .ewzp-pop-header { display: flex; align-items: center; gap: 6px; }
#${POPOVER_ID} .ewzp-pop-title { flex: 1 1 auto; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${POPOVER_ID} .ewzp-close {
  flex: 0 0 auto;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 16px;
  line-height: 1;
  padding: 2px 4px;
  cursor: pointer;
  border-radius: 4px;
}
#${POPOVER_ID} .ewzp-close:hover { background: rgba(128, 134, 145, 0.2); }
#${POPOVER_ID} .ewzp-status { margin: 0; opacity: 0.75; font-size: 11px; }
#${POPOVER_ID} .ewzp-room-picker { display: flex; align-items: center; gap: 6px; font-size: 11px; }
#${POPOVER_ID} .ewzp-room-picker select {
  flex: 1 1 auto;
  min-width: 0;
  font: inherit;
  color: inherit;
  background: transparent;
  border: 1px solid rgba(128, 134, 145, 0.4);
  border-radius: 5px;
  padding: 3px 5px;
}
#${POPOVER_ID} .ewzp-people {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
}
#${POPOVER_ID} .ewzp-person { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
#${POPOVER_ID} .ewzp-person-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${POPOVER_ID} .ewzp-person-status { flex: 0 0 auto; font-size: 10px; opacity: 0.7; }
#${POPOVER_ID} .ewzp-person-status[data-speaking="true"] { color: #3f8f5d; opacity: 1; }
#${POPOVER_ID} .ewzp-empty { margin: 0; font-size: 11px; opacity: 0.75; }
#${POPOVER_ID} .ewzp-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-top: 1px solid rgba(128, 134, 145, 0.25);
  padding-top: 8px;
}
#${POPOVER_ID} .ewzp-actions a {
  color: inherit;
  font-size: 11px;
  text-decoration: none;
  border-radius: 5px;
  padding: 3px 7px;
  border: 1px solid rgba(128, 134, 145, 0.4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#${POPOVER_ID} .ewzp-actions a:hover { background: rgba(128, 134, 145, 0.18); }
#${POPOVER_ID} .ewzp-actions a[aria-disabled="true"] { opacity: 0.5; pointer-events: none; }
#${POPOVER_ID} .ewzp-footnote { margin: 0; font-size: 10px; opacity: 0.6; }
`;
