// WHETHER DELETING A PAGE ASKS FIRST, AND WHAT IT ASKS.
//
// Confirm-before-destructive is a behavioural policy, not a rendering detail,
// so it is here rather than inline in canvas/pages/PageSwitcher.tsx. That
// component's own header states the rule this module exists to keep true —
// "There is no threshold, no pixel comparison and no behavioural `if` below
// that is not a call into one of those" — and until this module existed the
// `remove` handler's `if (!window.confirm(...)) return;` was the single
// exception to it in 585 lines. This project has no jsdom and may not gain
// one, so a branch written in a .tsx is a branch nothing can ever check.
//
// WRITING IT DOWN FOUND A BUG, which is the argument for doing so. The inline
// version asked unconditionally. But `deletePageIntents` (page-intents.ts)
// REFUSES the doc's only page — `if (pages.length <= 1) return []` — so on a
// single-page doc the old handler put up "Delete "Canvas"? This deletes every
// shape on it.", and then did nothing whichever button was pressed. A modal
// whose two answers are indistinguishable is worse than no modal: it teaches
// the user that this dialog does not mean what it says, on the one control
// where they most need to believe it.
//
// WHAT THIS MODULE IS NOT. It does not decide whether the delete is possible —
// `deletePageIntents` owns that, and it is the caller's job to ask it and pass
// the answer in as `deletable`. Duplicating that rule here would give the spike
// two places to change when it moves.
//
// THE HAND-OFF IS THE WEAK POINT, AND IT IS GUARDED SEPARATELY. Everything
// this module gets right is undone if the caller passes a constant, and with
// no jsdom nothing behavioural can see that happen. Review demonstrated it on
// 2026-09-05: PageSwitcher.tsx's `pageDeletePrompt(row.name, intents.length >
// 0)` mutated to `pageDeletePrompt(row.name, true)` restores the single-page
// bug above verbatim and the whole suite stayed green, 810/810. So
// tests/page-delete-confirm.test.ts now reads that argument out of the .tsx as
// source text (through `stripComments`, never raw) and pins it to the
// emptiness of the very intents the handler goes on to apply.

/**
 * What the hands should do about a delete the user just asked for.
 *
 * `ask` — put `message` in front of the user and proceed only on assent.
 * `proceed` — go straight on without a dialog. Reached only when the caller
 * has already established there is nothing to delete, so "proceeding" runs the
 * caller's empty intent list and changes nothing; the point is that the user is
 * not asked to authorise a no-op.
 */
export type PageDeletePrompt =
  | { readonly kind: "ask"; readonly message: string }
  | { readonly kind: "proceed" };

/**
 * Decide whether deleting the page called `name` warrants a confirmation, and
 * what it should say.
 *
 * `deletable` is the CALLER's report of whether the delete would actually do
 * anything — in practice `deletePageIntents(editor, id).length > 0`. Passed in
 * rather than re-derived so this module needs no Editor and stays a pure
 * function of two plain values.
 *
 * The wording is carried over byte-identical from the inline version this
 * replaces (including the plain `"` quotes around the name, which read oddly
 * for a page whose own name contains one — left exactly as it was rather than
 * "improved" under cover of a refactor).
 */
export function pageDeletePrompt(name: string, deletable: boolean): PageDeletePrompt {
  if (!deletable) return { kind: "proceed" };
  return { kind: "ask", message: `Delete "${name}"? This deletes every shape on it.` };
}
