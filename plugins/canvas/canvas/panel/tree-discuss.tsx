// The panel's half of W8: take the node the human selected, and put a
// reference to it in the composer they are writing in.
//
// HANDS ONLY, the split canvas/agent-arms.ts's header states: which composer
// this is, what the reference says, how it merges with a draft in progress and
// what to say afterwards are all canvas/tree/discuss.ts, tested without a DOM.
//
// TWO THINGS WORTH READING TWICE.
//
// `updateText`, NOT `setText`. The human may be mid-sentence. `updateText`
// hands us the latest committed draft and rebases the mentions around our
// edit; `setText` would replace whatever they had typed with our block. That
// is the trade this node refuses to make, and it is why the merge is written
// as an updater (`draftWithReference`) rather than as a string the panel
// assembles.
//
// THE OUTCOME COMES BACK OUT OF THE UPDATER. What happened is only knowable
// inside it — the draft may already carry this reference — so the flag is set
// there and read after. It starts at `unrun`, so a composer that never calls
// the updater is reported as a failure rather than silently reading as "it was
// already there".
//
// W17 — AND WHEN THERE IS NO COMPOSER IN SCOPE, IT NAVIGATES. The canvas is a
// nav panel, and a nav panel's `useComposer()` is the unresolved root
// new-thread scope, which W8 treated as "nowhere to write" and greyed. It is
// not nowhere: `useBbNavigate().toCompose({initialPrompt, focusPrompt})` is
// the host's own "drop the human into chat with a prefilled prompt" entry
// point, and the prompt it is seeded with is the SAME block the in-place
// insert would have written. In-place first (staying on the canvas is worth
// keeping), compose as the fallback — `discussRouteFor` owns that choice.
import { useCallback } from "react";
import { useBbNavigate, useComposer } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { CanvasDocument } from "@ensembleworks/canvas-model";
import {
  discussReport,
  discussRouteFor,
  draftWithReference,
  nodeReferenceFor,
  type DiscussOutcome,
  type DiscussRoute,
} from "../tree/discuss.js";
import type { LiveText } from "../shape-text.js";

export interface TreeDiscuss {
  /** Where a press would land the reference: the composer beside this panel,
   * or the compose surface it would navigate to. Never nowhere. */
  readonly route: DiscussRoute;
  /** `getText` is the live text channel (`editor.doc.getText`), carried
   * alongside the document because a `CanvasDocument` does not hold the
   * per-shape text containers a human types into — see canvas/shape-text.ts. */
  discuss(doc: CanvasDocument, treeId: string, nodeId: string, getText: LiveText): void;
}

export function useTreeDiscuss(): TreeDiscuss {
  const composer = useComposer();
  const navigate = useBbNavigate();
  const route = discussRouteFor(composer?.scope ?? null);

  const discuss = useCallback(
    (doc: CanvasDocument, treeId: string, nodeId: string, getText: LiveText) => {
      // Re-derived at press time rather than closed over: the panel can be
      // mounted for minutes while the composer's scope changes underneath it.
      const where = discussRouteFor(composer?.scope ?? null);
      const reference = nodeReferenceFor(doc, treeId, nodeId, getText);
      if (!reference.ok) {
        // The reader's own sentence: it names the node, which is what a human
        // needs to work out that the tree moved under them.
        toast.error(reference.why);
        return;
      }
      if (where.kind === "compose") {
        // The whole block, and the focus, in one host call. There is no draft
        // to merge with — the compose surface is being opened for this — so
        // `draftWithReference`'s duplicate rule has nothing to say here.
        navigate.toCompose({ initialPrompt: reference.text, focusPrompt: true });
        const report = discussReport("navigated", where.where);
        toast.success(report.text);
        return;
      }
      let outcome: DiscussOutcome = "unrun";
      composer.updateText((current) => {
        const next = draftWithReference(current, reference.text);
        if (next === null) {
          outcome = "duplicate";
          return current;
        }
        outcome = "inserted";
        return next;
      });
      const report = discussReport(outcome, where.where);
      if (report.tone === "success") {
        // The caret lands after the insert, which is where a human continues
        // typing. There is no caret to insert AT — the composer api exposes
        // text, setText, updateText, clear and focus, and nothing finer.
        composer.focus();
        toast.success(report.text);
      } else if (report.tone === "info") toast.info(report.text);
      else toast.error(report.text);
    },
    [composer, navigate],
  );

  return { route, discuss };
}
