// "Jump to where they are" — try client-side, fall back to a reload.
//
// THE SHAPE OF THE AFFORDANCE IS A REAL LINK. The popover renders
// `<a href="/projects/…/threads/…">`, so middle-click, ⌘-click, right-click →
// copy link address and the browser's own status bar all behave by the strip
// doing nothing whatsoever. Only a PLAIN left click is intercepted, and only to
// spare the user a full reload of the bb app.
//
// THE CLIENT-SIDE ATTEMPT IS A PUSHED HISTORY ENTRY. bb's router answers
// `history.pushState` + a `popstate` event — verified against the running app
// during this feature's preflight, where the pushed entry re-routed a thread
// page in under two frames. But that is an undocumented behaviour of somebody
// else's router: it is the single most likely thing in this feature to stop
// working silently the next time bb changes, and a jump link that quietly does
// nothing is worse than one that reloads.
//
// So the attempt is VERIFIED and the fallback is PINNED BY TESTS
// (tests/dock-navigate.test.ts). The two questions dock.ts asks — "is this
// click mine to take?" and "did the attempt take?" — are here, pure, because
// this project has no jsdom and a decision made inline in dock.ts is a decision
// no test can reach.

/** The bits of a MouseEvent this decision looks at. */
export interface ClickIntent {
  /** 0 = left/primary, 1 = middle, 2 = right. */
  readonly button: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly defaultPrevented: boolean;
}

/** What the page looked like at a moment in time. */
export interface RouteProbe {
  /** `location.pathname`. */
  readonly path: string;
  /** `document.title` — the observable that says whether the APP moved, as
   * opposed to whether the URL did. */
  readonly title: string;
}

/**
 * Is this click the strip's to intercept?
 *
 * Everything else — middle, right, and every modifier — falls through to the
 * browser untouched, because every one of them means something the strip has no
 * business reinterpreting (new tab, new window, download, context menu). A
 * click something upstream already handled is likewise left alone.
 */
export function shouldTryClientSide(intent: ClickIntent): boolean {
  return (
    intent.button === 0 &&
    !intent.ctrlKey &&
    !intent.metaKey &&
    !intent.shiftKey &&
    !intent.altKey &&
    !intent.defaultPrevented
  );
}

/**
 * Did the client-side attempt actually take, or must the browser finish the
 * job?
 *
 * "Did the path change" is NOT evidence: `pushState` changes
 * `location.pathname` whether or not any router was listening, so after a
 * failed attempt the URL bar is already showing the destination while the page
 * still shows the old one. The evidence that the APP moved is that it
 * repainted, and the cheapest honest proxy for that is the document title —
 * bb sets a placeholder ("Thread thr_cjny") within a frame or two and the real
 * title later, so even a slow route is caught by the placeholder.
 *
 * THE ASYMMETRY IS DELIBERATE. Two pages sharing a title read as "did not
 * take", and the cost is a full page load that lands in exactly the right
 * place. The opposite mistake — believing an attempt that failed — strands the
 * user on the old page with the new URL in the bar, which they can only escape
 * by reloading by hand. So this errs towards falling back.
 */
export function clientSideTook(
  before: RouteProbe,
  after: RouteProbe,
  targetPath: string,
): boolean {
  const target = trimSlash(targetPath);
  // Already there: the click was a no-op and there is nothing to verify. A
  // "fallback" here would be a gratuitous reload of the page you are on.
  if (trimSlash(before.path) === target) return true;
  if (trimSlash(after.path) !== target) return false;
  return after.title !== before.title;
}

function trimSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}
