import { onTestFinished, vi } from "vitest";

/**
 * What a jsdom test needs before it opens an <Explain> (a Radix Popover). Call it from
 * `beforeEach` or at the start of a test; it undoes itself when the test finishes.
 *
 * - jsdom has no `ResizeObserver`, which Radix Popper measures with.
 * - floating-ui asks every ancestor of the popover `matches(":popover-open")` and
 *   `matches(":modal")` on each position update, and jsdom's selector engine (nwsapi
 *   2.2) answers `:modal` by recursing through `:fullscreen` — tens of seconds per
 *   popover. Nothing in a test is in the top layer, so both are answered `false`, which
 *   is what a browser would say.
 */
export function stubPopoverDom(): void {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const matches = Element.prototype.matches;
  const spy = vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
    return selector === ":modal" || selector === ":popover-open" ? false : matches.call(this, selector);
  });
  onTestFinished(() => spy.mockRestore());
}
