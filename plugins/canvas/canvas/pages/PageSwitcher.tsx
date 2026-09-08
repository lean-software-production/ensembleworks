/**
 * Public façade for the page switcher hook. The implementation is split under
 * switcher/ by responsibility: actions, DOM views, drag coordination, menu
 * coordination, styles, and composition.
 *
 * ux-contract: none — this is a behavior-preserving structural refactor of
 * the existing page chrome, outside the enumerated interaction-contract paths.
 */
export { usePageSwitcher } from "./switcher/use-page-switcher.js";
export type { PageSwitcherInput, PageSwitcherNodes } from "./switcher/types.js";
