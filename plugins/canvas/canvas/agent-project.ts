// WHICH BB PROJECT THE CANVAS'S THREADS LIVE IN. Task 2d.
//
// THIS FILE EXISTS BECAUSE THE PREVIOUS ANSWER WAS A GUESS, AND THE GUESS SHIPPED
// AND BIT THE OWNER. `resolveProjectId` in server.ts used to return the
// `project` setting when set and otherwise "the first project
// bb.sdk.projects.list() returns". That setting was unset, so every canvas
// thread silently spawned into an unrelated project while the owner watched a
// different project's sidebar and reasonably concluded the threads had never
// been created. Nothing in the app said otherwise: the badge went amber, the
// note looked linked, and the conversation was somewhere else.
//
// The function's own docstring already argued against its own fallback — "a
// thread spawned somewhere the user did not choose is worse than an error that
// says what to do" — and then did it anyway for the unset case. This module is
// that sentence, applied.
//
// WHY REFUSE RATHER THAN ASK PER LAUNCH. Making the project an argument of the
// launch flow (a picker in front of the run button) was the other candidate. It
// is rejected because it puts a second decision in front of a one-click
// affordance, every time, to fix a state that is configured once — and because
// bb already has the right surface for "which project does this plugin work
// in": the plugin's own settings page, where the `project` descriptor already
// lives. An error that names that setting sends the user to the place the
// answer belongs.
//
// WHY NOT "GUESS WHEN THERE IS EXACTLY ONE PROJECT". That middle ground is
// genuinely unambiguous at the moment it runs, and that is exactly what makes
// it dangerous: the behaviour would change the day a second project is created,
// silently, on a machine where it had always worked. A rule whose failure is
// deferred to an unrelated future event is worse than one that fails on day
// one.
//
// PURE AND EXPORTED so the refusal is unit-testable at all: written inline in
// the handler it could only be reached by driving the whole plugin, which is
// how the original fallback survived unexamined. Same shape as canvas/av.ts's
// `NOT_CONFIGURED_DETAIL`, the other "you have not told me a thing I need"
// message in this plugin.

/**
 * What the user is told when no project is configured.
 *
 * A CONSTANT because it is asserted on: it reaches the browser as an rpc
 * rejection and is toasted verbatim (canvas/CanvasPanel.tsx toasts
 * `cause.message`), so it is a product surface, not a log line. It names the
 * setting rather than describing the fault, because "what do I do" is the only
 * question a reader of a toast has.
 */
export const PROJECT_NOT_SET_DETAIL =
  "No project is configured for canvas agents. Open the Canvas plugin's project setting and choose the project these threads should live in.";

/**
 * The canvas's project id, from the plugin's `project` setting.
 *
 * `value` is whatever `bb.settings.get()` handed back, hence `unknown`:
 * anything that is not a non-blank string is "not configured", including a
 * number from a mis-declared descriptor. Trimmed, because a project id pasted
 * out of bb's UI routinely arrives with a trailing space and refusing that
 * would be a puzzle rather than a message.
 *
 * THROWS rather than returning null. Every caller's only sane response to "no
 * project" is to abandon what it was doing and show this sentence, and a
 * nullable return is an invitation for one of them to invent a fallback — which
 * is the exact mistake this module is undoing.
 */
export function resolveCanvasProjectId(value: unknown): string {
  if (typeof value === "string") {
    const projectId = value.trim();
    if (projectId.length > 0) return projectId;
  }
  throw new Error(PROJECT_NOT_SET_DETAIL);
}
