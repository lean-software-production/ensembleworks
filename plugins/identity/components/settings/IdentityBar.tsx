import type { WhoAmI } from "../../server.js";
import type { GlossaryId } from "../../lib/glossary.js";
import { Explain } from "../Explain.js";

/** Where your identity came from and what it counts for; each phrase explains itself. */
const PROVENANCE: Record<WhoAmI["provenance"], { phrase: string; counts: string; term: GlossaryId }> = {
  "upstream-header": { phrase: "from your Access email", counts: "Attribution and the guardrail", term: "guardrail" },
  "self-selected": { phrase: "chosen in this browser", counts: "Attribution only", term: "attribution-only" },
  "configured-fallback": { phrase: "from the fallback email", counts: "Attribution only", term: "attribution-only" },
  "unknown": { phrase: "anonymous", counts: "Never refused", term: "guardrail" },
};

/** Static text, not a live region: it changes only when the page reloads its answers. */
export function IdentityBar({ whoami }: { whoami: WhoAmI | null }) {
  const provenance = whoami?.provenance ?? "unknown";
  const { phrase, counts, term } = PROVENANCE[provenance];
  const name = whoami?.person?.displayName ?? whoami?.email ?? "Anonymous";
  return (
    <section aria-label="Who you are here" className="identity-settings-bar">
      <p>
        You: <strong>{name}</strong> · <Explain term="precedence">{phrase}</Explain> · {provenance === "unknown" ? null : "counts for "}
        <span className="identity-settings-pill" data-trust={provenance === "upstream-header" ? "guardrail" : "attribution"}>
          <Explain term={term}>{counts}</Explain>
        </span>
      </p>
      <p className="identity-settings-muted">Changes here are <Explain term="logged-changes">logged</Explain>.</p>
    </section>
  );
}
