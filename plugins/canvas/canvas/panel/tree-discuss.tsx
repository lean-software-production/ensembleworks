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
import { useCallback } from "react";
import { useComposer } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { CanvasDocument } from "@ensembleworks/canvas-model";
import {
  composerDestination,
  discussReport,
  draftWithReference,
  nodeReferenceFor,
  type ComposerDestination,
  type DiscussOutcome,
} from "../tree/discuss.js";

export interface TreeDiscuss {
  /** Where a reference would go, or the reason there is nowhere. The arm is
   * greyed with `why` rather than hidden. */
  readonly destination: ComposerDestination;
  discuss(doc: CanvasDocument, treeId: string, nodeId: string): void;
}

export function useTreeDiscuss(): TreeDiscuss {
  const composer = useComposer();
  const destination = composerDestination(composer?.scope ?? null);

  const discuss = useCallback(
    (doc: CanvasDocument, treeId: string, nodeId: string) => {
      // Re-derived at press time rather than closed over: the panel can be
      // mounted for minutes while the composer's scope changes underneath it.
      const where = composerDestination(composer?.scope ?? null);
      if (!where.ok) {
        toast.error(where.why);
        return;
      }
      const reference = nodeReferenceFor(doc, treeId, nodeId);
      if (!reference.ok) {
        // The reader's own sentence: it names the node, which is what a human
        // needs to work out that the tree moved under them.
        toast.error(reference.why);
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
    [composer],
  );

  return { destination, discuss };
}
