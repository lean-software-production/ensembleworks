// The panel's half of W18's three edits: call the server, and say what
// happened.
//
// SHAPED LIKE `useTreeGestures`, deliberately — same `rpcRef`, same `pending`
// idea, same toast-not-banner rule (a refused write is not a broken
// connection). NOT OPTIMISTIC, for the reason rpc-contract.ts gives beside the
// methods: the write runs on the server, and the change appears when the
// room's delta arrives. There is nothing to paint here in the meantime and
// nothing to roll back if the engine refuses.
//
// THE ONE THING IT ADDS OVER `useTreeGestures`: a save reports back whether it
// LANDED, because the context editor has to know — a save that was refused as
// `stale-write` must leave the human's draft exactly where it is, with the
// conflict still on screen.
import { useCallback, useState } from "react";
import { toast } from "sonner";
import type { NodeState } from "../tree/encoding.js";
import type { RpcClient } from "./connection-types.js";

interface TreeWriteAnswer {
  readonly nodeId: string;
  readonly changed: readonly string[];
  readonly problems: readonly string[];
}

export type InspectorEdit = "state" | "approached" | "context";

export interface TreeInspectorEdits {
  /** Which edit is in flight, if any. */
  readonly pending: InspectorEdit | null;
  setState(nodeId: string, state: NodeState): void;
  setApproached(nodeId: string, approached: boolean): void;
  /** Resolves TRUE only when the note was actually written. `expected` is what
   * the editor read when it opened the draft; the engine refuses the write if
   * the document no longer holds it. */
  writeContext(nodeId: string, context: string, expected: string): Promise<boolean>;
}

export function useTreeInspectorEdits(rpcRef: { current: RpcClient }): TreeInspectorEdits {
  const [pending, setPending] = useState<InspectorEdit | null>(null);

  const run = useCallback(
    (kind: InspectorEdit, method: string, input: unknown, failure: string): Promise<boolean> => {
      setPending(kind);
      return (rpcRef.current.call as (name: string, input: unknown) => Promise<TreeWriteAnswer>)(
        method,
        input,
      )
        .then((answer) => {
          if (answer.problems.length > 0) {
            toast.warning(`Saved, but the tree needs attention: ${answer.problems.join("; ")}`);
          }
          return true;
        })
        .catch((cause: unknown) => {
          // The engine's own sentence, unedited — for a `stale-write` it says
          // how much writing was NOT overwritten, which is the whole point of
          // the refusal.
          toast.error(`${failure}: ${cause instanceof Error ? cause.message : String(cause)}`);
          return false;
        })
        .finally(() => setPending(null));
    },
    [rpcRef],
  );

  return {
    pending,
    setState: useCallback(
      (nodeId: string, state: NodeState) => {
        void run("state", "canvas_tree_set_state", { nodeId, state }, "Could not set that state");
      },
      [run],
    ),
    setApproached: useCallback(
      (nodeId: string, approached: boolean) => {
        void run(
          "approached",
          "canvas_tree_set_approached",
          { nodeId, approached },
          "Could not change that",
        );
      },
      [run],
    ),
    writeContext: useCallback(
      (nodeId: string, context: string, expected: string) =>
        run(
          "context",
          "canvas_tree_write_context",
          { nodeId, context, expected },
          "Could not save that note",
        ),
      [run],
    ),
  };
}
