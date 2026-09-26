import { describe, expect, it } from "vitest";
import { SETTINGS_TABS } from "../settings-admin.js";
import type { GuardrailRule } from "../guardrail.js";
import { GLOSSARY, RULE_NAMES, RULE_TERMS, type GlossaryId } from "./glossary.js";

const RULES: GuardrailRule[] = ["start-on-another-persons-machine", "follow-up-by-non-starter", "automation-off-team-machine"];
const text = (id: GlossaryId) => GLOSSARY[id].body.join(" ");

describe("the glossary", () => {
  it("keeps every entry short, titled and pointed at a real tab", () => {
    for (const [id, entry] of Object.entries(GLOSSARY)) {
      expect(entry.title, id).not.toBe("");
      expect(entry.body.length, id).toBeGreaterThan(0);
      expect(entry.body.join(" ").split(/\s+/).filter(Boolean).length, id).toBeLessThanOrEqual(70);
      if (entry.more !== undefined) expect(SETTINGS_TABS, id).toContain(entry.more);
    }
  });

  it("names each rule the way the log does not, and says what the log calls it", () => {
    for (const rule of RULES) {
      expect(GLOSSARY[RULE_TERMS[rule]].title.toLowerCase()).toBe(RULE_NAMES[rule]);
      expect(text(RULE_TERMS[rule])).toContain(`In the log: ${rule}.`);
    }
  });

  it("states the facts the rest of the UI leans on", () => {
    expect(text("guardrail")).toContain("Only two kinds of request can be refused");
    expect(text("attribution-only")).toContain("never refused");
    expect(text("precedence")).toContain("never falls through to the fallback email");
    // Spike S3-lite: a new-thread composer customization never sees the selected machine.
    expect(text("composer-check")).toContain("doesn't tell Identity which machine");
    expect(text("composer-check")).toContain("In Audit it is logged and goes ahead");
  });

  it("keeps automations out of the machines people may use freely", () => {
    // Rule C refuses a stamped automation on an unclaimed machine, so "open to everyone" lies.
    for (const id of ["rule-own-machine", "machine-owner"] as const) {
      expect(text(id), id).not.toMatch(/open to everyone|anyone may start/);
      expect(text(id), id).toMatch(/an automation (still needs a team machine|may not)/);
    }
  });

  it("describes the own-thread rule by the recorded starter, inherited ones included", () => {
    // An agent's child thread inherits its parent's starter (decideAttribution), and rule B
    // judges that record, not how the thread was started.
    expect(text("rule-own-thread")).not.toContain("started any other way");
    expect(text("rule-own-thread")).toContain("recorded starter");
    expect(text("rule-own-thread")).toContain("inherits its starter");
    expect(text("rule-own-thread")).toContain("recorded from a browser name or the fallback email");
  });
});
