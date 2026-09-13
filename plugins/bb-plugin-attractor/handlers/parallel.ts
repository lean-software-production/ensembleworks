/**
 * `parallel` (component, fan-out) and `parallel.fan_in` (tripleoctagon)
 * handlers. Per engine/engine.ts, the engine itself runs a fork node's own
 * stage through `forkHandler`, then — only for the `parallel` handler kind —
 * does the actual fan-out (branch execution, `parallel.results`/
 * `parallel.branch_count` context writes) as walker logic, not through the
 * handler registry; a `parallel.fan_in` node is likewise entered as an
 * ordinary stage once every branch has converged on it. Neither handler has
 * any work of its own to do.
 */

import type { Handler } from "../engine/types";

export const forkHandler: Handler = {
  async run() {
    return { status: "succeeded" };
  },
};

export const joinHandler: Handler = {
  async run() {
    return { status: "succeeded" };
  },
};
