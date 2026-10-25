// WHICH BB THREADS THE ATTACH PICKER OFFERS, in what order, and how a typed
// query narrows them. Task 2b.
//
// EVERY LINE HERE IS A DECISION, which is why none of it lives in server.ts's
// rpc handler or in agents-ui.tsx. This project has no jsdom and may not gain
// one (see the spike README), so a rule written inline in a component is a rule
// no test can reach; and a rule written inline in a handler is one that can
// only be checked by driving the whole plugin. Same split canvas/pages/
// page-menu.ts makes for the page popover — and this module is deliberately
// shaped like it, down to `filterThreadOptions` mirroring `filterPageRows`,
// because the two surfaces answer the same question about different nouns.
//
// NO SDK TYPES ARE IMPORTED. `ThreadListRow` below is a LOCAL structural type
// naming exactly the eight fields these decisions read. The same call
// canvas/agents.ts's `ThreadLiveness` already makes and for the same stated
// reason: a two-field probe is something a test can hand over without building
// a whole thread DTO, and this module is bundled into the frontend by
// agents-ui.tsx, which must not drag the server SDK along with it.

/**
 * The most threads the picker will ever show.
 *
 * 50, and it is a cap on the SORTED list, not a `limit` handed to bb — see
 * `threadListArgsFor`. Fifty rows is already more than anyone scrolls; the
 * filter box is the answer beyond that, and `threads.search` (a different
 * affordance, not built here) is the answer beyond THAT.
 *
 * STATED AS A LIMIT, NOT HIDDEN: a thread that is not among the 50 most
 * recently updated in the project is not reachable from this picker at all,
 * even by typing its exact id. If that starts to bite, the fix is a
 * server-side search, not a bigger number.
 */
export const THREAD_PICKER_LIMIT = 50;

/**
 * The fields of one `bb.sdk.threads.list()` row that this module reads.
 * Verified against @get-bb/plugin-sdk 0.4.21's `threadListResponseSchema`
 * (bundled-types/bb-plugin-sdk.d.ts) on 2026-09-06.
 */
export interface ThreadListRow {
  readonly id: string;
  readonly title: string | null;
  readonly titleFallback: string | null;
  readonly projectId: string;
  readonly archivedAt: number | null;
  readonly deletedAt: number | null;
  readonly updatedAt: number;
  readonly visibility: "hidden" | "visible";
}

/** One row of the picker. */
export interface ThreadOption {
  readonly threadId: string;
  /** What the row is called — never empty, see `threadOptionLabel`. */
  readonly label: string;
  /** bb's own last-updated stamp, epoch ms, passed straight through so the UI
   * can say how stale a thread is without a second source of truth. */
  readonly updatedAt: number;
  /** The shape this thread is ALREADY on, or null. Marked rather than
   * excluded — see `threadPickerOptions`. */
  readonly attachedShapeId: string | null;
}

/**
 * The arguments the backend hands `bb.sdk.threads.list`.
 *
 * A FUNCTION RATHER THAN AN INLINE OBJECT so the two scoping decisions in it
 * are unit-testable, and so a parser guard can pin that the handler passes THIS
 * and not a hand-rolled literal beside it.
 *
 * `projectId` — THE CANVAS'S PROJECT, ALWAYS. Attaching a shape to a thread in
 * some other project produces a badge that opens a conversation the user's
 * sidebar is not showing, which is precisely the confusion Task 2d exists to
 * end. Cross-project attach is refused again at the point of record
 * (canvas/agent-attach.ts), because this list is only the offer.
 *
 * `archived: false` — an archived thread is one this plugin's own sweep
 * (canvas/agents.ts's `sweep`) would drop on the next gc tick, so offering one
 * would mint a link with a scheduled death. NOT VERIFIED: the exact semantics
 * of `ThreadListArgs.archived` were read off the type (`archived?: boolean`)
 * and not exercised against a running bb, so `threadPickerOptions` filters
 * archived rows again defensively and that filter, not this argument, is the
 * guarantee.
 *
 * NO `limit`. `ThreadListArgs` offers `limit`/`offset` but documents no
 * ORDERING, so a server-side limit would give "some 50 threads" rather than
 * "the 50 most recent" — and a picker that silently omits the thread you were
 * in ten seconds ago is worse than one that costs a full list. The cap is
 * applied after sorting, in `threadPickerOptions`. WHAT THIS COSTS, stated: a
 * project with thousands of threads pays for all of them on every picker open.
 */
export function threadListArgsFor(projectId: string): {
  readonly projectId: string;
  readonly archived: false;
} {
  return { projectId, archived: false };
}

/**
 * What a thread is called in the picker.
 *
 * Title, then bb's own `titleFallback`, then the id. THE ID IS A BAD LABEL AND
 * IS STILL THE RIGHT LAST RESORT: a row with no text is a row with nothing to
 * aim at, and an ugly row you can click beats an invisible one. Whitespace-only
 * counts as absent at every step, because a title of three spaces renders
 * exactly like the blank row this is avoiding.
 */
export function threadOptionLabel(row: ThreadListRow): string {
  const title = (row.title ?? "").trim();
  if (title.length > 0) return title;
  const fallback = (row.titleFallback ?? "").trim();
  if (fallback.length > 0) return fallback;
  return row.id;
}

/**
 * The offer, in the order it is drawn.
 *
 * DEAD THREADS ARE DROPPED — archived, deleted, or `visibility: "hidden"`. The
 * first two are the states `sweep` retires a link for; the third is a thread bb
 * deliberately keeps out of its own sidebar, and the owner's ask was for a
 * shape bound to a thread "that also appears in the regular BB sidebar".
 *
 * AN ALREADY-ATTACHED THREAD IS MARKED, NOT DROPPED, and this is the one place
 * the two obvious answers really differ. Dropping it makes "why is my thread
 * missing?" unanswerable from the UI — the user is looking at a list and the
 * thing they want is simply not in it, with no way to tell whether the picker
 * is broken or the thread is elsewhere. Marking says which shape holds it, and
 * lets the refusal (canvas/agent-attach.ts's `other-shape`) explain itself
 * against a row the user can see rather than against a row that never rendered.
 * A row marked with THIS shape's own id is the re-attach case, which is legal.
 *
 * SORTED BY `updatedAt` DESC, NOT BY WHAT BB HANDED BACK. `ThreadListArgs`
 * documents no ordering, so relying on the response order would be relying on
 * an implementation detail; and the recency order is the useful one, because
 * the thread you want to attach is nearly always one you were just in. Ties
 * break on the id ascending so two tabs listing the same project draw the same
 * list — an unstable sort here would make the picker reorder under the cursor
 * between opens.
 *
 * CAPPED LAST, so the cap keeps the most recent rather than an arbitrary
 * window. See `THREAD_PICKER_LIMIT`.
 */
export function threadPickerOptions(
  rows: readonly ThreadListRow[],
  /** threadId -> the shape already linked to it. */
  attachedBy: Readonly<Record<string, string>>,
): ThreadOption[] {
  return rows
    .filter(
      (row) =>
        row.archivedAt === null &&
        row.deletedAt === null &&
        row.visibility !== "hidden",
    )
    .sort((a, b) => (b.updatedAt - a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, THREAD_PICKER_LIMIT)
    .map((row) => ({
      threadId: row.id,
      label: threadOptionLabel(row),
      updatedAt: row.updatedAt,
      attachedShapeId: attachedBy[row.id] ?? null,
    }));
}

/**
 * Narrow the offer to what the user typed.
 *
 * LABEL SUBSTRING, case-insensitive, ORDER-PRESERVING — no relevance ranking,
 * so the row under the cursor does not jump between keystrokes and the list
 * stays the recency order the picker opened in. The same three properties
 * `filterPageRows` has, for the same reasons, stated there.
 *
 * PLUS ONE RULE THE PAGE FILTER DOES NOT HAVE: a query that IS a thread id
 * matches that thread. Pasting an id is a real way to say "this exact thread"
 * (bb puts thread ids in its own URLs), and it is the only way to reach a
 * thread whose title is not what you remember. EXACT, never a substring: every
 * id shares a `th_` prefix, so a substring rule would make "th" — two letters
 * of half the English language — select everything, which is the mistake
 * `filterPageRows` explicitly refuses to make with `page:`.
 */
export function filterThreadOptions(
  options: readonly ThreadOption[],
  query: string,
): ThreadOption[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...options];
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(needle) ||
      option.threadId.toLowerCase() === needle,
  );
}

/**
 * What Enter in the filter box goes to: the top match, or nothing. The same
 * one-line rule `pageMenuEnterTarget` is, and here for the same reason — it is
 * the difference between "Enter is the fast path" and "Enter does something
 * surprising when the filter matched nothing".
 */
export function threadPickerEnterTarget(
  options: readonly ThreadOption[],
): ThreadOption | null {
  return options[0] ?? null;
}

/**
 * What a picker row says about a thread that is already on a shape, or null
 * when it is on none.
 *
 * THE MARK HAS TO ANSWER THE QUESTION THE ROW RAISES. `threadPickerOptions`
 * shows held threads rather than hiding them, precisely so "where is my thread
 * then?" is answerable from the list — so a mark that only said "taken" would
 * throw away the reason for showing the row at all.
 *
 * The shape id is NOT repeated back when the holder is the shape the user has
 * selected: they are looking at it, and naming it is noise. It IS named for any
 * other shape, because that is the shape they have to go and unlink.
 */
export function threadOptionNote(
  option: ThreadOption,
  currentShapeId: string,
): string | null {
  if (option.attachedShapeId === null) return null;
  if (option.attachedShapeId === currentShapeId) return "already on this shape";
  return `on ${option.attachedShapeId}`;
}

/**
 * May this row be clicked?
 *
 * The affordance half of canvas/agent-attach.ts's `other-shape` refusal,
 * hoisted so the row is disabled rather than dead — the same duplication
 * `PageMenuRow.canDelete` makes against `deletePageIntents`, and carrying the
 * same risk: an enabled row whose attach the backend would refuse is the bug
 * this pair could introduce. Both halves are tested (tests/agent-attach.test.ts
 * pins the backend's).
 *
 * Re-choosing the thread this shape already has is ALLOWED, matching the
 * verdict exactly: it is idempotent, not an error.
 */
export function threadOptionSelectable(
  option: ThreadOption,
  currentShapeId: string,
): boolean {
  return (
    option.attachedShapeId === null || option.attachedShapeId === currentShapeId
  );
}
