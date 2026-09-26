import type { WhoAmI } from "../../server.js";

/**
 * Where your identity came from and what it counts for, in the words the rest of the
 * page uses. "Counts for" is a sentence-case pill, so the bar never repeats the picker's
 * own lowercase disclaimer word for word.
 */
const PROVENANCE: Record<WhoAmI["provenance"], { phrase: string; counts: string }> = {
  "upstream-header": { phrase: "from your Access email, read as-is", counts: "Attribution and the guardrail" },
  "self-selected": { phrase: "from the name this browser chose", counts: "Attribution only — never the guardrail" },
  "configured-fallback": { phrase: "from the Fallback email setting", counts: "Attribution only — never the guardrail" },
  "unknown": { phrase: "anonymous", counts: "Nothing is refused for anonymous requests" },
};

/** Static text, not a live region: it changes only when the page reloads its answers. */
export function IdentityBar({ whoami }: { whoami: WhoAmI | null }) {
  const provenance = whoami?.provenance ?? "unknown";
  const { phrase, counts } = PROVENANCE[provenance];
  const name = whoami?.person?.displayName ?? whoami?.email ?? "Anonymous";
  return (
    <section aria-label="Who you are here" className="identity-settings-bar">
      <p>
        You: <strong>{name}</strong> · {phrase} · {provenance === "unknown" ? null : "counts for "}
        <span className="identity-settings-pill" data-trust={provenance === "upstream-header" ? "guardrail" : "attribution"}>
          {counts}
        </span>
      </p>
      <p className="identity-settings-muted">Identity is a guardrail against mistakes, not a lock.</p>
    </section>
  );
}
