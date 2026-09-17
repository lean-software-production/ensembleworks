import { describe, expect, it } from "vitest";
import {
  HostPins,
  classifyHost,
  decidePin,
  parseTeamMachines,
  personFromHostName,
  type HostPin,
} from "./hosts.js";
import type { KvLike } from "./kv.js";
import type { Person } from "./people.js";

const david: Person = {
  person: "mrdavidlaing",
  github: "mrdavidlaing",
  displayName: "David",
  emails: ["david@example.com"],
};
const matt: Person = {
  person: "mattwynne",
  github: "mattwynne",
  displayName: "Matt",
  emails: ["matt@example.com"],
};
const people = [david, matt];

function kv(): KvLike & { readonly data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    async set(key: string, value: unknown) {
      data.set(key, value);
    },
    async delete(key: string) {
      data.delete(key);
    },
    async list(prefix = "") {
      return [...data.keys()].filter((key) => key.startsWith(prefix));
    },
  };
}

describe("parseTeamMachines", () => {
  it("reads a newline or comma separated list, trimmed and deduplicated", () => {
    expect(parseTeamMachines(" ew-lsp-001-main\n ew-pi-001 , ew-lsp-001-main ")).toEqual([
      "ew-lsp-001-main",
      "ew-pi-001",
    ]);
  });

  it("reads a JSON array too, and an empty setting is no team machines", () => {
    expect(parseTeamMachines('["ew-lsp-001-main"]')).toEqual(["ew-lsp-001-main"]);
    expect(parseTeamMachines("   ")).toEqual([]);
  });
});

describe("personFromHostName", () => {
  it("takes the person from the last <box>-<person> segment", () => {
    expect(personFromHostName("ew-lsp-001-mrdavidlaing", people)?.person).toBe("mrdavidlaing");
  });

  it("matches case-insensitively and by github handle", () => {
    expect(personFromHostName("EW-LSP-001-MattWynne", people)?.person).toBe("mattwynne");
  });

  it("is null for a name whose last segment is nobody in the directory", () => {
    expect(personFromHostName("ew-lsp-001-main", people)).toBeNull();
    expect(personFromHostName("", people)).toBeNull();
  });
});

describe("classifyHost", () => {
  const team = ["ew-lsp-001-main"];

  it("classifies a person's machine from its name", () => {
    expect(classifyHost({ id: "h1", name: "ew-lsp-001-mrdavidlaing" }, { people, teamMachines: team, pin: null }))
      .toEqual({
        kind: "person",
        hostId: "h1",
        hostName: "ew-lsp-001-mrdavidlaing",
        person: { person: "mrdavidlaing", displayName: "David", github: "mrdavidlaing" },
        conflict: null,
      });
  });

  it("classifies a listed team machine as team, case-insensitively", () => {
    expect(classifyHost({ id: "h2", name: "EW-LSP-001-Main" }, { people, teamMachines: team, pin: null }).kind)
      .toBe("team");
  });

  it("classifies a host that is neither as unclaimed, not as team", () => {
    const classified = classifyHost({ id: "h3", name: "ew-scratch-002" }, { people, teamMachines: team, pin: null });
    expect(classified.kind).toBe("unclaimed");
  });

  it("follows the pin, not a later name that disagrees, and flags the disagreement", () => {
    const pin: HostPin = { hostId: "h1", person: "mrdavidlaing", name: "ew-lsp-001-mrdavidlaing", pinnedAt: 1 };
    const classified = classifyHost({ id: "h1", name: "ew-lsp-001-mattwynne" }, { people, teamMachines: team, pin });
    expect(classified.kind).toBe("person");
    expect(classified.kind === "person" && classified.person.person).toBe("mrdavidlaing");
    expect(classified.conflict).toEqual({
      pinnedName: "ew-lsp-001-mrdavidlaing",
      pinnedPerson: "mrdavidlaing",
      currentName: "ew-lsp-001-mattwynne",
    });
  });

  it("keeps a pinned person who has left the directory, under their person id", () => {
    const pin: HostPin = { hostId: "h9", person: "gone", name: "ew-lsp-001-gone", pinnedAt: 1 };
    const classified = classifyHost({ id: "h9", name: "ew-lsp-001-gone" }, { people, teamMachines: team, pin });
    expect(classified.kind === "person" && classified.person).toEqual({
      person: "gone",
      displayName: "gone",
      github: "gone",
    });
  });

  it("lets the team list win over a pin, because team membership is configuration", () => {
    const pin: HostPin = { hostId: "h4", person: "mattwynne", name: "ew-lsp-001-mattwynne", pinnedAt: 1 };
    expect(classifyHost({ id: "h4", name: "ew-lsp-001-main" }, { people, teamMachines: team, pin }).kind).toBe("team");
  });
});

describe("decidePin", () => {
  it("pins a person's machine on first sight", () => {
    expect(decidePin(null, { id: "h1", name: "ew-lsp-001-mrdavidlaing" }, people, 5)).toEqual({
      action: "pin",
      pin: { hostId: "h1", person: "mrdavidlaing", name: "ew-lsp-001-mrdavidlaing", pinnedAt: 5 },
    });
  });

  it("pins nothing for a host that names nobody", () => {
    expect(decidePin(null, { id: "h2", name: "ew-lsp-001-main" }, people, 5)).toEqual({ action: "none" });
  });

  it("keeps an existing pin even when the name now names someone else", () => {
    const pin: HostPin = { hostId: "h1", person: "mrdavidlaing", name: "ew-lsp-001-mrdavidlaing", pinnedAt: 1 };
    expect(decidePin(pin, { id: "h1", name: "ew-lsp-001-mattwynne" }, people, 9)).toEqual({ action: "keep" });
  });
});

describe("HostPins", () => {
  it("pins on first sight and answers the pin thereafter", async () => {
    const store = kv();
    const pins = new HostPins(store, people);
    expect(await pins.observe({ id: "h1", name: "ew-lsp-001-mrdavidlaing" }, 5)).toEqual({
      hostId: "h1",
      person: "mrdavidlaing",
      name: "ew-lsp-001-mrdavidlaing",
      pinnedAt: 5,
    });
    expect(await pins.get("h1")).toEqual({
      hostId: "h1",
      person: "mrdavidlaing",
      name: "ew-lsp-001-mrdavidlaing",
      pinnedAt: 5,
    });
  });

  it("does not follow a rename to another person", async () => {
    const store = kv();
    const pins = new HostPins(store, people);
    await pins.observe({ id: "h1", name: "ew-lsp-001-mrdavidlaing" }, 5);
    await pins.observe({ id: "h1", name: "ew-lsp-001-mattwynne" }, 6);
    expect((await pins.get("h1"))?.person).toBe("mrdavidlaing");
  });

  it("never throws, and answers null, when storage is broken", async () => {
    const broken: KvLike = {
      get: async () => {
        throw new Error("kv down");
      },
      set: async () => {
        throw new Error("kv down");
      },
      delete: async () => undefined,
      list: async () => [],
    };
    const pins = new HostPins(broken, people);
    expect(await pins.observe({ id: "h1", name: "ew-lsp-001-mrdavidlaing" }, 5)).toBeNull();
    expect(await pins.get("h1")).toBeNull();
  });

  it("gives up rather than hanging when storage never answers", async () => {
    const wedged: KvLike = {
      get: () => new Promise(() => undefined),
      set: () => new Promise(() => undefined),
      delete: async () => undefined,
      list: async () => [],
    };
    const pins = new HostPins(wedged, people, { timeoutMs: 5 });
    expect(await pins.get("h1")).toBeNull();
  });
});
