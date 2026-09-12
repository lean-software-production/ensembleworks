// The panel's half of W4's two gestures: call the server, and say what
// happened.
//
// SHAPED LIKE `useAgentSync`, deliberately — same `rpcRef`, same `pending`
// idea, same toast-not-banner rule (the canvas connection is perfectly healthy
// when a write is refused; the banner is about the connection being broken).
//
// NOT OPTIMISTIC, and this is the one place the choice is visible to a human.
// The write runs on the server (canvas/rpc-contract.ts argues why, next to the
// two methods), so the new node appears when the room's delta arrives — there
// is nothing to paint here in the meantime and nothing to roll back if the
// engine refuses. `pending` is what the button uses to say so.
import { useCallback, useState } from "react";
import { toast } from "sonner";
import type { RpcClient } from "./connection-types.js";

export interface TreeWriteAnswer {
  readonly nodeId: string;
  readonly changed: readonly string[];
  readonly problems: readonly string[];
}

export interface TreeGestures {
  /** Non-null while a gesture's write is in flight. */
  readonly pending: "goal" | "blocker" | null;
  addGoal(treeId: string, title: string): void;
  addBlocker(parentId: string, title: string): void;
}

export function useTreeGestures(rpcRef: { current: RpcClient }): TreeGestures {
  const [pending, setPending] = useState<"goal" | "blocker" | null>(null);

  const run = useCallback(
    (kind: "goal" | "blocker", method: string, input: unknown, failure: string) => {
      setPending(kind);
      (rpcRef.current.call as (name: string, input: unknown) => Promise<TreeWriteAnswer>)(
        method,
        input,
      )
        .then((answer) => {
          // A write that LANDED and left damage behind is not a failure — it
          // is a concurrent editor, and W11's subject. Saying nothing would
          // leave the human planning against a tree that is no longer there.
          if (answer.problems.length > 0) {
            toast.warning(
              `Added it, but the tree needs attention: ${answer.problems.join("; ")}`,
            );
          }
        })
        .catch((cause: unknown) => {
          // The engine's own sentence, unedited: it names the reason code and
          // the ids, which is exactly what a human needs to pick another move.
          toast.error(
            `${failure}: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        })
        .finally(() => setPending(null));
    },
    [rpcRef],
  );

  const addGoal = useCallback(
    (treeId: string, title: string) =>
      run("goal", "canvas_tree_add_goal", { treeId, title }, "Could not add that goal"),
    [run],
  );
  const addBlocker = useCallback(
    (parentId: string, title: string) =>
      run("blocker", "canvas_tree_add_blocker", { parentId, title }, "Could not add that blocker"),
    [run],
  );

  return { pending, addGoal, addBlocker };
}
