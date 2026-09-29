import type { Ref } from "react";
import type { ReadinessItem } from "../../settings-admin.js";
import { StatusBadge } from "./StatusBadge.js";

/**
 * The six readiness facts, condensed to one wrapping strip. Each item is a button that
 * takes you to where it is fixed: its tab, or the profile question. `profileRef` reaches
 * the Profile item, where focus lands when the profile question closes.
 */
export function ReadinessStrip({ items, onActivate, profileRef }: {
  items: readonly ReadinessItem[];
  onActivate: (target: ReadinessItem["tab"]) => void;
  profileRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <ol aria-label="Identity readiness" className="identity-settings-readiness">
      {items.map((item) => (
        <li key={item.id}>
          <button ref={item.tab === "profile" ? profileRef : undefined} type="button"
            className="identity-settings-readiness-item" data-status={item.status} onClick={() => onActivate(item.tab)}>
            <StatusBadge status={item.status} text={`${item.label}: ${item.text}`} />
          </button>
        </li>
      ))}
    </ol>
  );
}
