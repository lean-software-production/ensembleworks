// The one seam between the dock's transcript button and the hook that can open
// the room transcript panel.
//
// WHY A SEAM IS NEEDED AT ALL. The strip is a content script: imperative DOM,
// no React fiber, no context. `PluginContentScriptContext` carries exactly four
// fields (`pluginId`, `generation`, `signal`, `experimental_setThreadRowStatus`
// — confirmed against the RUNNING bundle, not just the .d.ts), and
// `globalThis.__bbPluginRuntime` exposes React, Radix, sonner and the SDK's
// hooks and nothing imperative. So the strip cannot open a panel by itself.
//
// AND THE PANEL IS NOT URL-ADDRESSABLE, which is what rules out the obvious
// answer. Measured on the running app (2026-09-01, bb 0.40.0, SDK 0.4.21):
// opening the transcript from the thread panel's launcher and from the quick
// palette both leave `location.pathname`, `search`, `hash`, `history.state`
// (`{"idx":0}`) and `history.length` untouched. The identity of the open tab
// lives in localStorage under `bb.thread.fixedPanelTabsState-<threadId>-1`.
// Reloading the same URL re-opens the panel FROM THAT RECORD, not from the URL,
// so the same link opens or does not open the panel depending on per-browser
// state — it is not a deep link. The guarded client-side navigation in
// navigate.ts is therefore no help here: there is nothing to push.
// `useBbNavigate().toPluginPanel` is a real router navigate, but it addresses
// NAV panels (`/plugins/canvas/canvas/...`), which the transcript is not.
//
// WHAT IS LEFT IS THE HOOK, RELAYED. `useBbNavigate().openThreadPanel` resolves
// its opener from a React context bb provides inside the thread route. Walking
// `__reactFiber$` ancestor chains on the live app placed that provider above
// the page-header row (`YES@28`) and above the actions cluster the strip is
// prepended into (`YES@29`), and NOT above the plugin's sidebar accessory (`NO`
// across its whole 92-fiber chain) — which is what rules out the tempting
// always-mounted relay. `experimental_threadHeaderAction` renders into that
// same header action row, so its component is inside the provider and can
// publish the function here.
//
// This is the identical trick canvas/panel-bus.ts uses for `panTo`, for the
// identical reason: two mount points with no common plugin ancestor, one plugin
// bundle in one window, so a module singleton reaches both.
//
// TWO HONEST LIMITS, both properties of the object rather than of the
// workaround:
//   * THREAD ROUTES ONLY. The slot is not rendered on the compose screen or any
//     non-thread route, and there is no door on /plugins/canvas/canvas,
//     /settings or / — bb's own palette row hides itself there by the same
//     `threadId !== null` test. A button that lights only on thread routes is
//     the honest maximum, so `decideDoorVisible` hides it everywhere else
//     rather than drawing a dead control.
//   * LAST WRITER WINS in a split layout, which renders one header per pane.
//     bb's own quick palette resolves its opener from a module-level Map the
//     same way (`for (let t of _B.values()) e = t`), so the failure mode is the
//     host's, not one invented here.

/** What came back from an attempt to open the panel, and what to tell the user.
 * `status` is the sentence the strip's status line shows — the strip reports a
 * refusal rather than looking like a button that does nothing. */
export type TranscriptOpenOutcome =
  | { readonly kind: "opened" }
  | { readonly kind: "declined"; readonly status: string }
  | { readonly kind: "no-door"; readonly status: string };

/** Should the dock draw the transcript button at all? */
export function decideDoorVisible(input: { hasOpener: boolean }): boolean {
  return input.hasOpener;
}

/**
 * Read the host's answer.
 *
 * `true`  — the host accepted the open.
 * `false` — the host declined: no thread side panel on this surface, or the
 *           action is unavailable. Reported, never swallowed; a decline that
 *           looks like a dead button is the worst of the three outcomes.
 * `null`  — there was nobody to ask, because no thread header is mounted. This
 *           is not an error, it is the non-thread routes, and the button is
 *           hidden there; the branch exists so a click that races an unmount
 *           still says something true.
 */
export function interpretOpen(result: boolean | null): TranscriptOpenOutcome {
  if (result === null) {
    return {
      kind: "no-door",
      status: "The room transcript opens in a thread's side panel — open a thread first.",
    };
  }
  if (result) return { kind: "opened" };
  return {
    kind: "declined",
    status: "BB declined to open the room transcript panel here.",
  };
}

/** What a click on the button does to the two things it can touch: the status
 * line, and whether the popover folds.
 *
 * Pure, and here rather than inline in the click handler, because the fold is
 * the one thing about this control that must never be got wrong and dock.ts is
 * where no test can reach. ONLY AN ACCEPTED OPEN FOLDS: the other two outcomes
 * answer on the status line, and the status line is rendered INSIDE the
 * popover, so folding on a refusal deletes the only explanation the user gets.
 * The accepted open clears the status in the same breath, so a second click
 * after an earlier refusal does not leave the stale complaint on screen. */
export function decideTranscriptClick(outcome: TranscriptOpenOutcome): {
  readonly status: string;
  readonly fold: boolean;
} {
  if (outcome.kind === "opened") return { status: "", fold: true };
  return { status: outcome.status, fold: false };
}

type Opener = () => boolean;

let opener: Opener | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  // Copy: a listener that unsubscribes itself while we iterate must not mutate
  // the set being walked.
  for (const listener of [...listeners]) listener();
}

export const transcriptDoor = {
  /**
   * Publish this thread header's `openThreadPanel`. Returns an unregister, so
   * the component's effect cleanup is a one-liner — and the unregister only
   * fires if this handler is still the current one, because React runs the
   * departing component's cleanup AFTER the arriving one has registered.
   */
  setOpener(open: Opener): () => void {
    opener = open;
    emit();
    return () => {
      if (opener !== open) return;
      opener = null;
      emit();
    };
  },

  /** Is a thread header mounted right now? */
  hasOpener(): boolean {
    return opener !== null;
  },

  /** Try to open the panel, and say honestly what happened. */
  open(): TranscriptOpenOutcome {
    const current = opener;
    return interpretOpen(current === null ? null : current());
  },

  /** The dock is imperative DOM and has to be told when the door appears or
   * goes, so it can show or hide the button. */
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
