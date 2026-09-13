import { defineRpcContract, experimental_defineHostEntry } from "@get-bb/plugin-sdk";

/**
 * Attractor host entry point.
 *
 * Scaffold (task T1): declares an empty RPC contract so the host bundle
 * loads. T4 replaces this with the real `exec` contract that runs a
 * `command`-node's `script` in the environment path (see
 * docs/plans/2026-09-13-attractor-runner-plan.md, "BB plugin SDK notes").
 */
export const hostContract = defineRpcContract({});

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {},
});
