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

  it("tells a thread with no record apart from one with no person on it", () => {
    // A Send-now start leaves no record, so the next dispatch is judged as a start and the
    // own-machine rule can refuse it (guardrail.ts rule A); only a record carries rule B's "open".
    expect(text("rule-own-thread")).not.toContain("no recorded starter");
    expect(text("rule-own-thread")).toContain("A thread with no record, such as one begun with Send now, counts as a new start");
    expect(text("rule-own-thread")).toContain("own-machine rule");
  });

  it("limits the composer's refusal to someone identified by their Access email", () => {
    // makeGuardrail passes no requester for a browser name or the fallback email, and rule A
    // needs one; only a stamped automation is refused without a person.
    expect(text("composer-check")).toContain("If you are identified by your Access email, Enforce refuses");
    expect(text("composer-check")).toContain("A browser name or the fallback email is never refused");
  });

  it("checks the machine at Send only in Audit and Enforce", () => {
    // makeGuardrail returns before classifying the host when the mode is Off.
    expect(text("composer-check")).not.toContain("When you press Send, Identity checks the machine");
    expect(text("composer-check")).toContain("In Audit and Enforce, pressing Send checks the machine");
    expect(text("blind-spots")).not.toContain("nothing is checked until you press Send");
    expect(text("blind-spots")).toContain("In Audit and Enforce, the check comes when you press Send");
  });

  it("says which logged changes name who made them", () => {
    // Settings, colour and pin lines carry adminActor(); a browser name's select line carries
    // the chosen person and its forget line no person (server.ts /select- and /forget-identity).
    expect(text("logged-changes")).not.toContain("Every change made in this section");
    expect(text("logged-changes")).toContain("Settings, colour and machine changes made here write a line to BB's log naming who made them");
    expect(text("logged-changes")).toContain("Choosing a browser name logs the name chosen; forgetting one logs no name. Neither says who did it.");
  });
});
