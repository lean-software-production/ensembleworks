import { describe, expect, it } from "vitest";
import {
  composerBanner,
  readOnlyBanner,
  headerChip,
  ownershipRowStatus,
  runsAs,
  starterPhrase,
  type OwnershipView,
} from "./ownership-labels.js";
import type { HostClassification } from "./hosts.js";
import type { StarterSummary } from "./attribution.js";

const david: StarterSummary = { person: "mrdavidlaing", displayName: "David", github: "mrdavidlaing" };
const matt: StarterSummary = { person: "mattwynne", displayName: "Matt", github: "mattwynne" };

const davidsMachine: HostClassification = {
  kind: "person",
  hostId: "h1",
  hostName: "ew-lsp-001-mrdavidlaing",
  person: david,
  conflict: null,
};
const mattsMachine: HostClassification = {
  kind: "person",
  hostId: "h2",
  hostName: "ew-lsp-001-mattwynne",
  person: matt,
  conflict: null,
};
const teamMachine: HostClassification = { kind: "team", hostId: "h3", hostName: "ew-lsp-001-main", conflict: null };
const unclaimed: HostClassification = { kind: "unclaimed", hostId: "h4", hostName: "ew-scratch-002", conflict: null };

function view(overrides: Partial<OwnershipView> = {}): OwnershipView {
  return { starter: david, via: "browser", inheritedFrom: null, host: davidsMachine, ...overrides };
}

describe("starterPhrase", () => {
  it("names the person for a browser start", () => {
    expect(starterPhrase(view())).toBe("David");
  });

  it("names the agent and the human behind it", () => {
    expect(starterPhrase(view({ via: "agent", inheritedFrom: "thr_parent" }))).toBe("an agent for David");
  });

  it("names an automation, which bb records no creator for", () => {
    expect(starterPhrase(view({ starter: null, via: "plugin" }))).toBe("an automation");
  });

  it("is honest, not alarming, when nothing was recorded", () => {
    expect(starterPhrase(view({ starter: null, via: "unknown" }))).toBe("someone not recorded");
  });
});

describe("runsAs", () => {
  it("is the person's own account on their machine", () => {
    expect(runsAs(davidsMachine, "ensembleworks-agent")).toBe("mrdavidlaing");
  });

  it("is the shared account on the team machine and on an unclaimed one", () => {
    expect(runsAs(teamMachine, "ensembleworks-agent")).toBe("ensembleworks-agent");
    expect(runsAs(unclaimed, "ensembleworks-agent")).toBe("ensembleworks-agent");
  });
});

describe("headerChip", () => {
  const options = { sharedUser: "ensembleworks-agent" };

  it("says only who started it when the machine is the starter's own (option B)", () => {
    expect(headerChip(view(), options)).toEqual({ text: "Started by David", tone: "default" });
  });

  it("adds the machine when it differs from the starter", () => {
    expect(headerChip(view({ host: teamMachine }), options).text)
      .toBe("Started by David · runs as ensembleworks-agent on ew-lsp-001-main (team machine)");
  });

  it("calls an unmapped machine unclaimed, distinct from team", () => {
    expect(headerChip(view({ host: unclaimed }), options).text)
      .toBe("Started by David · runs as ensembleworks-agent on ew-scratch-002 (unclaimed machine)");
  });

  it("names the other person's account when a thread runs on their machine", () => {
    expect(headerChip(view({ host: mattsMachine }), options).text)
      .toBe("Started by David · runs as mattwynne on ew-lsp-001-mattwynne (Matt's machine)");
  });

  it("reads neutrally, never blank, when the starter is unknown", () => {
    const chip = headerChip(view({ starter: null, via: "unknown", host: null }), options);
    expect(chip).toEqual({ text: "Starter not recorded", tone: "muted" });
  });

  it("still shows the machine for an unknown starter, since there is nothing to match", () => {
    expect(headerChip(view({ starter: null, via: "unknown", host: teamMachine }), options).text)
      .toBe("Starter not recorded · runs as ensembleworks-agent on ew-lsp-001-main (team machine)");
  });

  it("mentions a pinned-owner disagreement rather than hiding it", () => {
    const renamed: HostClassification = {
      ...davidsMachine,
      hostName: "ew-lsp-001-mattwynne",
      conflict: { pinnedName: "ew-lsp-001-mrdavidlaing", pinnedPerson: "mrdavidlaing", currentName: "ew-lsp-001-mattwynne" },
    };
    expect(headerChip(view({ starter: matt, host: renamed }), options).text)
      .toContain("renamed since it was pinned to David");
  });
});

describe("ownershipRowStatus", () => {
  it("labels the row with the starter, and stays neutral in tone", () => {
    expect(ownershipRowStatus(view())).toEqual({
      icon: "User",
      label: "Started by David",
      tone: "default",
      badge: "D",
    });
  });

  it("marks agent and automation rows with their own glyph", () => {
    expect(ownershipRowStatus(view({ via: "agent", inheritedFrom: "thr_1" })).icon).toBe("Bot");
    expect(ownershipRowStatus(view({ starter: null, via: "plugin" })).icon).toBe("Clock");
  });

  it("adds the machine to the row only when it differs from the starter", () => {
    expect(ownershipRowStatus(view({ host: teamMachine })).label).toBe("Started by David · team machine");
    expect(ownershipRowStatus(view({ host: unclaimed })).label).toBe("Started by David · unclaimed machine");
    expect(ownershipRowStatus(view({ host: mattsMachine })).label).toBe("Started by David · Matt's machine");
  });

  it("uses a neutral glyph and a question badge for an unrecorded starter", () => {
    expect(ownershipRowStatus(view({ starter: null, via: "unknown", host: null }))).toEqual({
      icon: "CircleHelp",
      label: "Starter not recorded",
      tone: "default",
      badge: "?",
    });
  });
});

describe("composerBanner", () => {
  it("states who you are and lists your machines, without promising a warning", () => {
    const banner = composerBanner({
      me: david,
      machines: [davidsMachine, mattsMachine, teamMachine, unclaimed],
      restrictStarts: false,
    });
    expect(banner.title).toBe("Starting as David");
    expect(banner.detail).toBe(
      "Your machines: ew-lsp-001-mrdavidlaing. Team machine: ew-lsp-001-main. "
      + "BB does not tell a plugin which machine this composer has selected, so this banner cannot check it "
      + "for you. Nothing else checks it yet either: starting on someone else's machine is recorded, not refused.",
    );
  });

  it("never promises an enforcement that is not switched on", () => {
    // Step 5 built `restrictStarts`, and it defaults to OFF. With it off nothing refuses
    // a start, so copy implying one is caught, refused or blocked would be a lie told in
    // the user's own composer. The guard now turns on the SETTING, not on step 5's
    // existence — which is the same promise, made conditional rather than deleted.
    for (const machines of [[], [davidsMachine, teamMachine, unclaimed]]) {
      const detail = composerBanner({ me: david, machines, restrictStarts: false }).detail;
      // Only positive claims are banned: "is recorded, not refused" is the honest form.
      expect(detail).not.toMatch(/\b(is|are|will be|gets?)\s+(caught|refused|blocked|prevented|stopped)\b/i);
    }
  });

  it("says the guardrail is on, once it is", () => {
    const detail = composerBanner({
      me: david,
      machines: [davidsMachine, teamMachine, unclaimed],
      restrictStarts: true,
    }).detail;
    expect(detail).toMatch(/starting on someone else's machine is refused/i);
    // Still honest about what the banner itself cannot do (S3-lite).
    expect(detail).toContain("does not tell a plugin which machine this composer has selected");
  });

  it("says so plainly when there are no machines to list", () => {
    expect(composerBanner({ me: david, restrictStarts: false, machines: [] }).detail)
      .toBe("No machines of yours are known yet. BB does not tell a plugin which machine this composer has selected.");
  });

  it("is neutral, not alarming, for an unrecognised sign-in", () => {
    expect(composerBanner({ me: null, restrictStarts: false, machines: [teamMachine] })).toEqual({
      title: "Starting as an unrecognised sign-in",
      detail: "Threads you start will show no starter. Add your email to Identity's directory setting to be named.",
    });
  });
});

describe("readOnlyBanner", () => {
  it("names whose thread this is when the guardrail is on", () => {
    expect(readOnlyBanner({ me: david, starter: matt, restrictStarts: true })).toEqual({
      title: "Read-only: Matt's thread",
      detail: "Only Matt can send to it. Ask Matt, or start a thread of your own.",
    });
  });

  it("does not claim read-only when the setting is off, because nothing enforces it", () => {
    const banner = readOnlyBanner({ me: david, starter: matt, restrictStarts: false });
    expect(banner?.title).toBe("Matt's thread");
    expect(banner?.detail).not.toMatch(/\b(is|are|will be|gets?)\s+(caught|refused|blocked|prevented|stopped)\b/i);
    expect(banner?.detail).toContain("restrictStarts");
  });

  it("says nothing on your own thread, an unrecorded one, or to an unrecognised sign-in", () => {
    expect(readOnlyBanner({ me: david, starter: david, restrictStarts: true })).toBeNull();
    expect(readOnlyBanner({ me: david, starter: null, restrictStarts: true })).toBeNull();
    expect(readOnlyBanner({ me: null, starter: matt, restrictStarts: true })).toBeNull();
  });
});
