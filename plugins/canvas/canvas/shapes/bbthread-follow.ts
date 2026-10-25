// bb-thread-frame "autoscroll while idle" follow-up (docs/plans/2026-09-15-
// bb-thread-frame.md's continuation): while a bbthread's pane is NOT
// interactive (view mode, `ThreadChat variant="timeline"`), keep the host
// `ThreadChat` pinned to its newest content — the host component exposes no
// scroll API of its own, so this reaches into its rendered DOM instead.
//
// DOM-ONLY, DELIBERATELY UNTESTED HERE: this plugin has no jsdom (see
// tests/lib/source.ts's own header for why), so this file cannot be unit
// tested the way the rest of the plugin is. The pure decision of WHICH
// descendant counts as a follow target lives in bbthread-model.ts
// (`isScrollable`/`pickScrollTargets`, real unit tests in
// bbthread-model.test.ts) — this file is only the DOM plumbing around it:
// walk the real tree, read computed style, set `scrollTop`. The strongest
// honest statement left about THIS file is a source-guard
// (tests/bbthread-wiring.test.ts) proving BbThreadShape.tsx calls it with
// the right `enabled` flag and that it disconnects everything it observes.
import { useEffect, type RefObject } from "react";
import { pickScrollTargets, type ScrollCandidate } from "./bbthread-model.js";

/** Every element under (and including) `root`, paired with the scroll
 * metrics `isScrollable`/`pickScrollTargets` need — read fresh each call
 * (elements come and go as the chat streams in new content), never cached. */
function collectCandidates(root: HTMLElement): ScrollCandidate<HTMLElement>[] {
  const elements: HTMLElement[] = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
  return elements.map((element) => {
    const style = getComputedStyle(element);
    return { element, overflowY: style.overflowY, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
  });
}

/**
 * While `enabled`, keeps every scrollable descendant of `rootRef.current`
 * (per `isScrollable`) pinned to its own bottom (`scrollTop = scrollHeight`).
 * Re-checks on mount, on every DOM mutation under the root (`MutationObserver`
 * — childList/subtree/characterData, so a streamed-in message or an edited
 * one both trigger it), and on the root's own resize (`ResizeObserver`, when
 * available — a pane resize or a reflow changes how much is scrolled past).
 * Work within a burst of mutations/resizes is coalesced onto a single
 * `requestAnimationFrame`, since a streaming response can fire many mutation
 * records inside one frame.
 *
 * Disconnects both observers (and cancels any pending frame) the instant
 * `enabled` goes false, or on unmount — a focused user's own scroll position
 * must never be fought once the pane leaves view mode.
 */
export function useFollowLatest(rootRef: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const root = rootRef.current;
    if (!root) return;

    let frame: number | null = null;
    const followLatest = (): void => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        for (const target of pickScrollTargets(collectCandidates(root))) {
          target.scrollTop = target.scrollHeight;
        }
      });
    };

    followLatest();

    const mutationObserver = new MutationObserver(followLatest);
    mutationObserver.observe(root, { childList: true, subtree: true, characterData: true });

    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(followLatest);
    resizeObserver?.observe(root);

    return () => {
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [rootRef, enabled]);
}
