/**
 * `start` (Mdiamond) and `exit` (Msquare) handlers. Neither does any work of
 * its own: `start` is the walk's entry point and `exit` is what a
 * successfully-completed walk reaches, so both simply report success. Per
 * engine/engine.ts, an `exit` node's own returned Outcome becomes the run's
 * `finalOutcome` — reaching it at all (as opposed to dead-ending via
 * `on_failure=exit` or an exhausted `max_visits`, both of which terminate
 * without ever visiting the exit node) means the walk got there.
 */

import type { Handler } from "../engine/types";

export const startHandler: Handler = {
  async run() {
    return { status: "succeeded" };
  },
};

export const exitHandler: Handler = {
  async run() {
    return { status: "succeeded" };
  },
};
