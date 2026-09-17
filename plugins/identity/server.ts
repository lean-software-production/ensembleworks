import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  AttributionLedger,
  attributeDispatch,
  starterSummarySchema,
  type StarterRecord,
} from "./attribution.js";
import { hostRefSchema, type HostRef } from "./host-ref.js";
import {
  HostPins,
  classifyHost,
  parseTeamMachines,
  type HostClassification,
} from "./hosts.js";
import { identityFor, parseDirectory, type Person } from "./people.js";
import {
  ACCESS_EMAIL_HEADER,
  installRequestContext,
  normalizeEmail,
  selfTestRequestContext,
  type SelfTestResult,
} from "./request-context.js";

export const LEASE_TTL_MS = 25_000;
export const TYPING_TTL_MS = 3_000;
const MAX_LEASES = 2_000;

const opaqueId = z.string().min(1).max(128);
const location = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("project"), projectId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("elsewhere") }).strict(),
]);
/**
 * Shared with attribution rather than re-declared: the two used to be identical copies,
 * and a drift between them would have surfaced only as a runtime validation throw.
 */
const personSummary = starterSummarySchema;
const presentPerson = personSummary.extend({ typing: z.boolean() }).strict();
/**
 * `viewers` and `typing` count distinct viewer keys (person ?? viewerId), so one person
 * in two browsers counts once. `people` are the named ones among them; the rest
 * (`viewers - people.length`) are anonymous.
 */
const threadPresence = z.object({
  threadId: z.string(),
  viewers: z.number().int().nonnegative(),
  typing: z.number().int().nonnegative(),
  people: z.array(presentPerson).max(MAX_LEASES),
}).strict();
const whoami = z.object({
  email: z.string().nullable(),
  person: personSummary.nullable(),
}).strict();
const threadId = z.string().min(1).max(200);
const hostPinConflict = z.object({
  pinnedName: z.string(),
  pinnedPerson: z.string(),
  currentName: z.string(),
}).strict();
/** A machine, labelled `person | team | unclaimed`. `unclaimed` is never folded into `team`. */
const hostClassification = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("person"),
    hostId: z.string(),
    hostName: z.string(),
    person: personSummary,
    conflict: hostPinConflict.nullable(),
  }).strict(),
  z.object({ kind: z.literal("team"), hostId: z.string(), hostName: z.string(), conflict: z.null() }).strict(),
  z.object({ kind: z.literal("unclaimed"), hostId: z.string(), hostName: z.string(), conflict: z.null() }).strict(),
]);
/** What one thread's ownership UI needs: the starter, and the classified machine. */
const threadOwnership = z.object({
  threadId: z.string(),
  starter: personSummary.nullable(),
  via: z.enum(["browser", "agent", "plugin", "unknown"]),
  inheritedFrom: z.string().nullable(),
  host: hostClassification.nullable(),
}).strict();
/** Who started a thread: the recorded starter, or null when nothing was ever recorded. */
const threadStarter = z.object({
  threadId: z.string(),
  starter: personSummary.nullable(),
  via: z.enum(["browser", "agent", "plugin", "unknown"]),
  inheritedFrom: z.string().nullable(),
  recordedAt: z.number(),
  /** The machine bb resolved for the dispatch that recorded this; null for older rows. */
  host: hostRefSchema.nullable(),
}).strict().nullable();

export type PresenceLocation = z.infer<typeof location>;
export type LeasePerson = z.infer<typeof personSummary>;
export type PresentPerson = z.infer<typeof presentPerson>;
export type ThreadPresence = z.infer<typeof threadPresence>;
export type WhoAmI = z.infer<typeof whoami>;
export type ThreadStarter = z.infer<typeof threadStarter>;
export type ThreadOwnership = z.infer<typeof threadOwnership>;
export type MachineList = z.infer<typeof machineList>;

/**
 * The public view of a stored starter: the contract's fields only (the recorded email is
 * deliberately private), validated against the very schema the RPC contract publishes so
 * the HTTP arm and the RPC arm can never answer differently.
 */
export function publicStarter(record: StarterRecord | null): ThreadStarter {
  if (record === null) return null;
  return threadStarter.parse({
    threadId: record.threadId,
    starter: record.starter,
    via: record.via,
    inheritedFrom: record.inheritedFrom,
    recordedAt: record.recordedAt,
    host: record.host ?? null,
  });
}

/**
 * One thread's ownership view: the recorded starter plus its machine, classified.
 * A thread with no record is not an error — it reads as an unknown starter, which the
 * UI renders neutrally.
 */
export function ownershipFor(
  wanted: string,
  starter: ThreadStarter,
  classify: (host: HostRef) => HostClassification,
): ThreadOwnership {
  if (starter === null) {
    return { threadId: wanted, starter: null, via: "unknown", inheritedFrom: null, host: null };
  }
  return threadOwnership.parse({
    threadId: starter.threadId,
    starter: starter.starter,
    via: starter.via,
    inheritedFrom: starter.inheritedFrom,
    host: starter.host === null ? null : classify(starter.host),
  });
}

/**
 * The machines bb knows, read from bb's own `GET /api/v1/hosts`.
 *
 * There is NO SDK surface for this: `PluginHosts` (SDK 0.4.84) offers only this
 * plugin's own host client, shared-port tunnels and port declarations, and the app-side
 * hooks expose threads, not hosts. So the machine list comes from the server's own HTTP
 * API over the loopback base url — verified against a real bb, not assumed.
 */
export function parseHostList(payload: unknown): HostRef[] {
  const rows = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null && Array.isArray((payload as { hosts?: unknown }).hosts)
      ? (payload as { hosts: unknown[] }).hosts
      : [];
  const hosts: HostRef[] = [];
  for (const row of rows) {
    const parsed = hostRefSchema.safeParse(
      typeof row === "object" && row !== null
        ? { id: (row as { id?: unknown }).id, name: (row as { name?: unknown }).name }
        : row,
    );
    if (parsed.success) hosts.push(parsed.data);
  }
  return hosts;
}

const machineList = z.object({
  me: personSummary.nullable(),
  machines: z.array(hostClassification),
  /** The account team and unclaimed machines run as, for the header chip's wording. */
  sharedMachineUser: z.string(),
  /** Why the list is empty, when it is. Null when the list was read successfully. */
  unavailable: z.string().nullable(),
}).strict();

export const rpcContract = defineRpcContract({
  identity_whoami: {
    input: z.object({}).strict().nullish(),
    output: whoami,
  },
  identity_thread_starter: {
    input: z.object({ threadId }).strict(),
    output: threadStarter,
  },
  /** Ownership for many threads at once, so a sidebar costs one call, not one per row. */
  identity_thread_ownership: {
    input: z.object({ threadIds: z.array(threadId).max(500) }).strict(),
    output: z.object({ threads: z.array(threadOwnership) }).strict(),
  },
  /** Who you are, and the machines bb knows, classified — for the composer banner. */
  identity_machines: {
    input: z.object({}).strict().nullish(),
    output: machineList,
  },
  presence_heartbeat: {
    input: z.object({ tabId: opaqueId, viewerId: opaqueId, location }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  presence_leave: {
    input: z.object({ tabId: opaqueId }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  presence_typing: {
    input: z.object({
      tabId: opaqueId,
      viewerId: opaqueId.optional(),
      threadId: z.string().min(1).max(200),
      active: z.boolean(),
    }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  presence_snapshot: {
    input: z.object({ excludeViewerId: opaqueId }).strict(),
    output: z.object({ threads: z.array(threadPresence).max(MAX_LEASES) }).strict(),
  },
  presence_thread: {
    input: z.object({ threadId: z.string().min(1).max(200), excludeViewerId: opaqueId }).strict(),
    output: threadPresence,
  },
  /** Compatibility for tabs running the pre-whereabouts frontend during reload. */
  presence_typing_list: {
    input: z.object({ threadId: z.string().min(1).max(200) }).strict(),
    output: z.object({ count: z.number().int().nonnegative() }).strict(),
  },
});

type Lease = {
  viewerId: string;
  /** Resolved from the request at call time; null when anonymous. */
  person: LeasePerson | null;
  location: PresenceLocation;
  seenAt: number;
  typingThreadId: string | null;
  typingSeenAt: number;
};

/** Process-local ephemeral awareness. Nothing here is durable or historical. */
export class PresenceStore {
  readonly #leases = new Map<string, Lease>();

  heartbeat(
    tabId: string,
    viewerId: string,
    nextLocation: PresenceLocation,
    now = Date.now(),
    person: LeasePerson | null = null,
  ): Set<string> {
    this.sweep(now);
    const previous = this.#leases.get(tabId);
    if (!previous && this.#leases.size >= MAX_LEASES) this.evictOldest();
    const locationChanged = !previous || !sameLocation(previous.location, nextLocation);
    this.#leases.set(tabId, {
      viewerId,
      person,
      location: nextLocation,
      seenAt: now,
      typingThreadId: locationChanged ? null : previous?.typingThreadId ?? null,
      typingSeenAt: locationChanged ? 0 : previous?.typingSeenAt ?? 0,
    });
    return locationChanged || previous?.viewerId !== viewerId || !samePerson(previous.person, person)
      ? affectedThreads(previous?.location, nextLocation)
      : new Set();
  }

  leave(tabId: string): Set<string> {
    const previous = this.#leases.get(tabId);
    this.#leases.delete(tabId);
    return affectedThreads(previous?.location);
  }

  setTyping(
    tabId: string,
    viewerId: string,
    threadId: string,
    active: boolean,
    now = Date.now(),
    person: LeasePerson | null = null,
  ): void {
    this.sweep(now);
    const previous = this.#leases.get(tabId);
    if (!active) {
      if (previous) this.#leases.set(tabId, { ...previous, person, typingThreadId: null, typingSeenAt: 0 });
      return;
    }
    if (!previous && this.#leases.size >= MAX_LEASES) this.evictOldest();
    this.#leases.set(tabId, {
      viewerId,
      person,
      location: { kind: "thread", threadId },
      seenAt: now,
      typingThreadId: threadId,
      typingSeenAt: now,
    });
  }

  snapshot(excludeViewerId: string, now = Date.now()): ThreadPresence[] {
    this.sweep(now);
    type Entry = { viewers: Set<string>; typing: Set<string>; people: Map<string, PresentPerson> };
    const byThread = new Map<string, Entry>();
    for (const lease of this.#leases.values()) {
      if (lease.viewerId === excludeViewerId || lease.location.kind !== "thread") continue;
      const entry = byThread.get(lease.location.threadId)
        ?? { viewers: new Set<string>(), typing: new Set<string>(), people: new Map<string, PresentPerson>() };
      // One person in two browsers is one viewer; anonymous viewers are keyed by browser.
      const key = lease.person ? `person:${lease.person.person}` : `viewer:${lease.viewerId}`;
      const typing = lease.typingThreadId === lease.location.threadId && now - lease.typingSeenAt <= TYPING_TTL_MS;
      entry.viewers.add(key);
      if (typing) entry.typing.add(key);
      if (lease.person) {
        const known = entry.people.get(lease.person.person);
        entry.people.set(lease.person.person, {
          person: lease.person.person,
          displayName: lease.person.displayName,
          github: lease.person.github,
          typing: typing || (known?.typing ?? false),
        });
      }
      byThread.set(lease.location.threadId, entry);
    }
    return [...byThread.entries()]
      .map(([threadId, entry]) => ({
        threadId,
        viewers: entry.viewers.size,
        typing: entry.typing.size,
        people: [...entry.people.values()].sort((a, b) =>
          a.displayName.localeCompare(b.displayName) || a.person.localeCompare(b.person)),
      }))
      .sort((a, b) => a.threadId.localeCompare(b.threadId));
  }

  thread(threadId: string, excludeViewerId: string, now = Date.now()): ThreadPresence {
    return this.snapshot(excludeViewerId, now).find((entry) => entry.threadId === threadId)
      ?? { threadId, viewers: 0, typing: 0, people: [] };
  }

  clear(): void {
    this.#leases.clear();
  }

  private sweep(now: number): void {
    for (const [tabId, lease] of this.#leases) {
      if (now - lease.seenAt > LEASE_TTL_MS) this.#leases.delete(tabId);
    }
  }

  private evictOldest(): void {
    let oldest: [string, Lease] | undefined;
    for (const entry of this.#leases) {
      if (!oldest || entry[1].seenAt < oldest[1].seenAt) oldest = entry;
    }
    if (oldest) this.#leases.delete(oldest[0]);
  }
}

function affectedThreads(...locations: Array<PresenceLocation | undefined>): Set<string> {
  return new Set(locations.flatMap((value) => value?.kind === "thread" ? [value.threadId] : []));
}

function samePerson(left: LeasePerson | null, right: LeasePerson | null): boolean {
  if (left === null || right === null) return left === right;
  return left.person === right.person && left.displayName === right.displayName && left.github === right.github;
}

function summarize(person: Person | null): LeasePerson | null {
  return person ? { person: person.person, displayName: person.displayName, github: person.github } : null;
}

function sameLocation(left: PresenceLocation, right: PresenceLocation): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "thread" && right.kind === "thread") return left.threadId === right.threadId;
  if (left.kind === "project" && right.kind === "project") return left.projectId === right.projectId;
  return left.kind === "elsewhere" && right.kind === "elsewhere";
}

export default async function plugin(bb: BbPluginApi) {
  const requestContext = installRequestContext();
  /** Durable hostId -> person pins. Labels only; it restricts nothing. */
  const pins = new HostPins(bb.storage.kv, []);
  const settings = bb.settings.define({
    directory: {
      type: "string",
      label: "People directory",
      description:
        'JSON array of { "person", "github", "displayName", "emails": [...] }. Emails are matched '
        + "case-insensitively against the Cloudflare Access email header. Changes apply without a reload.",
      experimental_multiline: true,
      default: "[]",
    },
    teamMachines: {
      type: "string",
      label: "Team machines",
      description:
        "Host names of the shared team machines, one per line or comma separated (a JSON array is "
        + "accepted too). A host that matches neither a person nor this list is shown as "
        + '"unclaimed" — never silently as the team machine. Display only: Identity restricts nothing.',
      experimental_multiline: true,
      default: "",
    },
    sharedMachineUser: {
      type: "string",
      label: "Shared machine user",
      description:
        "The Linux account threads run as on the team machine and on unclaimed machines, shown in "
        + "the thread header chip. Display only — Identity never sets or checks it.",
      default: "ensembleworks-agent",
    },
    fallbackEmail: {
      type: "string",
      label: "Fallback email",
      description:
        "Used as the requester's email when a request carries no Cloudflare Access header, for a BB "
        + "server not behind Access (e.g. a laptop). Every header-less caller, agents and CLI included, "
        + "is then attributed to this email. Leave empty on a shared server.",
      default: "",
    },
  });

  let people: Person[] = [];
  let fallbackEmail = "";
  let teamMachines: string[] = [];
  let sharedMachineUser = "ensembleworks-agent";
  const applySettings = (
    values: { directory: string; fallbackEmail: string; teamMachines: string; sharedMachineUser: string },
    reportInvalid: boolean,
  ) => {
    fallbackEmail = values.fallbackEmail;
    teamMachines = parseTeamMachines(values.teamMachines);
    sharedMachineUser = values.sharedMachineUser.trim() || "ensembleworks-agent";
    const parsed = parseDirectory(values.directory);
    if (parsed.ok) {
      people = parsed.people;
      pins.setPeople(people);
      return;
    }
    pins.setPeople([]);
    // An invalid directory never fails the plugin: presence simply stays anonymous.
    people = [];
    bb.log.warn(`identity: ${parsed.error}; treating the directory as empty`);
    if (reportInvalid) {
      bb.status.needsConfiguration(
        `Identity's "directory" setting is invalid (${parsed.error}). Presence stays anonymous until it is `
        + "fixed: bb plugin config identity set directory '<json>' then bb plugin reload identity.",
      );
    }
  };
  try {
    applySettings(await settings.get(), true);
  } catch (error) {
    bb.log.warn(`identity: could not read settings: ${(error as Error).message}`);
  }
  settings.onChange((next) => applySettings(next, false));

  /** Identity of whoever made the current request; unknown outside a request (startup race). */
  const currentIdentity = (email = requestContext.current()?.email ?? null) => identityFor(people, email, fallbackEmail);
  /** The current requester as attribution wants them: their email plus resolved person. */
  const whoamiPerson = () => {
    const identity = currentIdentity();
    return { email: identity.email, person: summarize(identity.person) };
  };
  const whoamiFor = (email: string | null): WhoAmI => {
    const identity = currentIdentity(email);
    return { email: identity.email, person: summarize(identity.person) };
  };

  const store = new PresenceStore();
  const publish = (threadIds: Iterable<string>) => {
    bb.realtime.publish("presence-changed", { threadIds: [...threadIds] });
  };

  bb.http.route("GET", "/whoami", (c) => {
    return c.json(whoamiFor(normalizeEmail(c.req.header(ACCESS_EMAIL_HEADER))));
  }, { auth: "local" });

  // ── Attribution (step 3): observe and record who started each thread. ─────────────
  const ledger = new AttributionLedger(bb.storage.kv);

  /**
   * The self-test's own route. It reports the email the ASYNC CONTEXT holds — not the
   * header off this request — so a reply naming the tagged email proves the patch is
   * carrying facts through bb's real server into plugin code in this process.
   */
  bb.http.route("GET", "/request-context-probe", (c) => {
    return c.json({ email: requestContext.current()?.email ?? null });
  }, { auth: "local" });

  /** The boot self-test's verdict, so an operator can read it without digging in logs. */
  bb.http.route("GET", "/request-context-self-test", (c) => {
    return c.json(selfTest ?? { ok: false, detail: "the self-test has not finished yet" });
  }, { auth: "local" });

  // Observe-only, and bounded: `attributeDispatch` always proceeds, never throws, and the
  // ledger's own kv timeout caps how long it can hold a dispatch up. See its unit tests.
  bb.experimental_hooks.on("message.dispatch", (context) =>
    attributeDispatch(context, {
      ledger,
      identity: whoamiPerson,
      now: () => Date.now(),
      // Display-only side effect: every machine bb itself names gets pinned on first
      // sight. `HostPins` never throws and bounds its own storage calls.
      observeHost: (host) => pins.observe(host),
      log: { info: (message) => bb.log.info(message), warn: (message) => bb.log.warn(message) },
    }));

  /** Label one machine: the team list, then the pin, then the name, then "unclaimed". */
  const classifyWithPin = async (host: HostRef): Promise<HostClassification> =>
    classifyHost(host, { people, teamMachines, pin: await pins.get(host.id) });

  const ownership = async (wanted: string): Promise<ThreadOwnership> => {
    const record = publicStarter(await ledger.get(wanted));
    const host = record?.host ?? null;
    const classified = host === null ? null : await classifyWithPin(host);
    return ownershipFor(wanted, record, () => classified ?? { kind: "unclaimed", hostId: host?.id ?? "", hostName: host?.name ?? "", conflict: null });
  };

  /**
   * bb's own host list, over the loopback API, cached briefly. The SDK gives a server
   * plugin no way to enumerate hosts (see `parseHostList`), and this is only ever used
   * to LIST machines in the composer banner.
   */
  let machineCache: { at: number; machines: HostClassification[]; unavailable: string | null } | null = null;
  const MACHINE_CACHE_MS = 30_000;
  const machines = async (): Promise<{ machines: HostClassification[]; unavailable: string | null }> => {
    if (machineCache !== null && Date.now() - machineCache.at < MACHINE_CACHE_MS) return machineCache;
    let hosts: HostRef[] = [];
    let unavailable: string | null = null;
    try {
      const response = await fetch(`${bb.server.loopbackBaseUrl}/api/v1/hosts`);
      if (!response.ok) throw new Error(`bb answered ${response.status}`);
      hosts = parseHostList(await response.json());
    } catch (error) {
      unavailable = `the machine list could not be read (${(error as Error).message})`;
      bb.log.warn(`identity: ${unavailable}`);
    }
    const classified: HostClassification[] = [];
    for (const host of hosts) {
      await pins.observe(host);
      classified.push(await classifyWithPin(host));
    }
    machineCache = { at: Date.now(), machines: classified, unavailable };
    return machineCache;
  };

  /** The host pins' disagreements, for an operator. Nothing acts on them. */
  bb.http.route("GET", "/host-pins", async (c) => {
    const listed = await machines();
    return c.json({ machines: listed.machines, unavailable: listed.unavailable, conflicts: pins.conflicts() });
  }, { auth: "local" });

  bb.http.route("GET", "/thread-ownership", async (c) => {
    const wanted = threadId.safeParse(c.req.query("threadId"));
    if (!wanted.success) return c.json({ error: "threadId is required (1-200 characters)" }, 400);
    return c.json(await ownership(wanted.data));
  }, { auth: "local" });

  bb.http.route("GET", "/thread-starter", async (c) => {
    const wanted = threadId.safeParse(c.req.query("threadId"));
    if (!wanted.success) {
      return c.json({ error: "threadId is required (1-200 characters)" }, 400);
    }
    return c.json(publicStarter(await ledger.get(wanted.data)));
  }, { auth: "local" });

  /**
   * Boot self-test: prove the ALS patch is live in THIS process, by driving one request
   * through bb's own server. It runs after the server is listening (`loopbackBaseUrl` is
   * bind-gated and throws before that), retries a few times while it comes up, and
   * NEVER restores `emit` — S7's lesson 1 is that restoring the patch silently kills it.
   * A failure degrades Identity to "no identity": everything attributes as unknown, and
   * no dispatch is affected, because the hook always proceeds.
   */
  let selfTest: SelfTestResult | null = null;
  const probe = async (headers: Record<string, string>): Promise<unknown> => {
    const response = await fetch(`${bb.server.loopbackBaseUrl}/api/v1/plugins/${bb.pluginId}/http/request-context-probe`, {
      headers,
    });
    if (!response.ok) throw new Error(`probe route answered ${response.status}`);
    return await response.json();
  };
  const runSelfTest = async (attemptsLeft: number): Promise<void> => {
    try {
      selfTest = await selfTestRequestContext(requestContext, { probe });
    } catch (error) {
      selfTest = { ok: false, detail: `the self-test could not run: ${(error as Error).message}` };
    }
    if (!selfTest.ok && attemptsLeft > 0) {
      selfTestTimer = setTimeout(() => void runSelfTest(attemptsLeft - 1), 1_000);
      return;
    }
    if (selfTest.ok) {
      bb.log.info(`identity: request-context self-test PASSED — ${selfTest.detail}`);
      return;
    }
    bb.log.warn(
      `identity: request-context self-test FAILED — ${selfTest.detail}. Attribution and named `
      + "presence degrade to unknown; nothing is blocked.",
    );
  };
  let selfTestTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => void runSelfTest(5), 500);

  bb.rpc.register(rpcContract, {
    identity_whoami: () => whoamiFor(requestContext.current()?.email ?? null),
    identity_thread_starter: async ({ threadId: wanted }) => publicStarter(await ledger.get(wanted)),
    identity_thread_ownership: async ({ threadIds }) => ({
      threads: await Promise.all(threadIds.map((wanted) => ownership(wanted))),
    }),
    identity_machines: async () => {
      const listed = await machines();
      return { me: whoamiFor(requestContext.current()?.email ?? null).person, sharedMachineUser, ...listed };
    },
    presence_heartbeat: ({ tabId, viewerId, location }) => {
      const person = summarize(currentIdentity().person);
      const affected = store.heartbeat(tabId, viewerId, location, Date.now(), person);
      if (affected.size > 0) publish(affected);
      return { ok: true } as const;
    },
    presence_leave: ({ tabId }) => {
      const affected = store.leave(tabId);
      if (affected.size > 0) publish(affected);
      return { ok: true } as const;
    },
    presence_typing: ({ tabId, viewerId, threadId, active }) => {
      const person = summarize(currentIdentity().person);
      store.setTyping(tabId, viewerId ?? `legacy:${tabId}`, threadId, active, Date.now(), person);
      publish([threadId]);
      return { ok: true } as const;
    },
    presence_snapshot: ({ excludeViewerId }) => ({ threads: store.snapshot(excludeViewerId) }),
    presence_thread: ({ threadId, excludeViewerId }) => store.thread(threadId, excludeViewerId),
    presence_typing_list: ({ threadId }) => ({ count: store.thread(threadId, "__legacy-no-viewer__").typing }),
  });
  bb.onDispose(() => {
    store.clear();
    if (selfTestTimer !== undefined) clearTimeout(selfTestTimer);
    // Deliberately NOT unpatching the request context: bb disposes the old generation
    // after the new one has loaded, so restoring `emit` here would remove the live
    // patch (S7, lesson 1).
  });
}
