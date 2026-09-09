// `::node{id="shape:…"}` in a message, as a card you can click.
//
// A TRANSCRIPTION, not a decision. Everything this component chooses to show
// is `nodeCard` (canvas/tree/node-reference.ts) and everything a click does is
// `openNodeOnCanvas` (canvas/tree/reveal.ts) — because this project has no
// jsdom, so a rule written inline here is a rule no test can reach. What is
// left is markup, one rpc, and the two lifecycle facts a component owns: a
// stale answer must not overwrite a newer one, and an unmounted card must not
// set state.
import { useEffect, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { nodeCard, nodeIdFromAttributes, type NodeLookup } from "./node-reference.js";
import { openNodeOnCanvas, revealBus } from "./reveal.js";
import type { rpcContract } from "../../server";

export function NodeDirectiveCard({ attributes, source }: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const nodeId = nodeIdFromAttributes(attributes);
  const [lookup, setLookup] = useState<NodeLookup>({ status: "loading" });

  useEffect(() => {
    if (nodeId === null) return;
    let live = true;
    // Re-read on every mount rather than caching: a message is scrolled past,
    // scrolled back to, and re-rendered days later. The point of asking at all
    // is that the answer is current (canvas/rpc-contract.ts argues it next to
    // the method).
    setLookup({ status: "loading" });
    rpc
      .call("canvas_tree_node", { nodeId })
      .then((answer) => {
        if (!live) return;
        setLookup(
          answer.node === null ? { status: "gone" } : { status: "found", node: answer.node },
        );
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setLookup({
          status: "unreadable",
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      });
    return () => {
      live = false;
    };
  }, [rpc, nodeId]);

  const card = nodeCard({ attributes, source, lookup });

  if (card.kind === "dead") {
    return (
      <span
        data-node-card="dead"
        className="my-1 inline-flex max-w-full items-center gap-2 rounded-md border border-dashed border-border px-2.5 py-1.5 text-sm text-muted-foreground"
      >
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />
        <span className="truncate">{card.label}</span>
        <span className="shrink-0 text-xs">· {card.reason}</span>
      </span>
    );
  }

  if (card.kind === "pending") {
    return (
      <span
        data-node-card="pending"
        className="my-1 inline-flex max-w-full items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm text-muted-foreground"
      >
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />
        <span className="truncate">{card.label}</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      data-node-card={card.target.nodeId}
      onClick={() => openNodeOnCanvas(card.target, { bus: revealBus, navigate })}
      title={`${card.target.nodeId} on ${card.target.pageId}`}
      className="my-1 inline-flex max-w-full cursor-pointer items-center gap-2 rounded-md border border-border bg-card py-1.5 pl-2 pr-2.5 text-left text-sm transition-colors hover:bg-muted/50"
    >
      <span
        aria-hidden
        className={`size-2 shrink-0 rounded-full ${
          card.state === "done"
            ? "bg-emerald-500"
            : card.state === "wip"
              ? "bg-amber-500"
              : "bg-muted-foreground/40"
        }`}
      />
      <span
        className="truncate font-medium"
        style={{
          textDecoration: card.state === "done" ? "line-through" : undefined,
          opacity: card.state === "done" ? 0.7 : 1,
        }}
      >
        {card.label}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {card.state}
        {card.ready ? " · ready" : ""}
      </span>
    </button>
  );
}

export default NodeDirectiveCard;
