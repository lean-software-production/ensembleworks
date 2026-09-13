/**
 * `ui/human-gate.tsx` — the `pendingInteraction` renderer for a human-gate
 * stage's `bb.ui.requestInput` call, per
 * docs/plans/2026-09-13-attractor-runner-plan.md T6: "handlers/human.ts +
 * pendingInteraction renderer + server wiring". Buttons per outgoing-edge
 * option (accelerator prefix parsed by handlers/human.ts, shown here as
 * `[K] text`), plus a free-text field when any outgoing edge declared
 * `freeform=true`. `submit()`'s value is a `HumanGateValue`
 * (server/human.ts validates it on the way back).
 *
 * Reads only `server/contracts.ts` (never `server/service.ts`/`server/
 * store.ts`, which pull in `better-sqlite3`) — see ui/dag.tsx's header
 * comment on why every ui/*.tsx module holds to that boundary.
 */

import { useState } from "react";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { humanGatePayloadSchema, type HumanGateValue } from "../server/contracts";

export function HumanGate({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const [text, setText] = useState("");
  const parsed = humanGatePayloadSchema.safeParse(interaction.payload);

  if (!parsed.success) {
    return <p role="alert">This human gate&apos;s request could not be read.</p>;
  }
  const payload = parsed.data;

  const choose = (raw: string) => {
    void submit({ kind: "choice", raw } satisfies HumanGateValue);
  };

  const submitText = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    void submit({ kind: "text", text: trimmed } satisfies HumanGateValue);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p>{payload.question}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {payload.options.map((option) => (
          <button key={option.raw} type="button" data-option-raw={option.raw} onClick={() => choose(option.raw)}>
            {option.key ? `[${option.key}] ${option.text}` : option.text}
          </button>
        ))}
      </div>
      {payload.freeform ? (
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="text"
            value={text}
            placeholder="Type an answer…"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitText();
            }}
          />
          <button type="button" onClick={submitText}>
            Submit
          </button>
        </div>
      ) : null}
      <div>
        <button type="button" onClick={() => void cancel()}>
          Cancel
        </button>
      </div>
    </div>
  );
}
