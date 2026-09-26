import type { PickerStatus } from "../../settings-admin.js";
import { PICKER_CHAIN } from "../../lib/precedence.js";
import { StatusBadge } from "./StatusBadge.js";

/** The picker's readiness chain: passed steps, the current one with its fix, the rest not checked yet. */
export function PickerChain({ status }: { status: PickerStatus }) {
  const at = PICKER_CHAIN.findIndex((step) => step.status === status);
  return (
    <ol aria-label="Picker readiness" className="identity-settings-chain">
      {PICKER_CHAIN.map((step, index) => {
        const here = index === at;
        const ready = step.status === "ready";
        return (
          <li key={step.status} aria-current={here ? "step" : undefined}>
            <StatusBadge status={index < at || (here && ready) ? "ok" : here ? "attention" : "off"} text={step.label} />
            <span className="identity-settings-muted">
              {index < at ? "Passed." : here ? step.fix : "Not checked yet."}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
