import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { identityFor, parseDirectory, type Person } from "./people.js";
import { ACCESS_EMAIL_HEADER, installRequestContext, normalizeEmail } from "./request-context.js";

export const LEASE_TTL_MS = 25_000;
export const TYPING_TTL_MS = 3_000;
const MAX_LEASES = 2_000;

const opaqueId = z.string().min(1).max(128);
const location = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("project"), projectId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("elsewhere") }).strict(),
]);
const personSummary = z.object({
  person: z.string(),
  displayName: z.string(),
  github: z.string(),
}).strict();
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

export type PresenceLocation = z.infer<typeof location>;
export type LeasePerson = z.infer<typeof personSummary>;
export type PresentPerson = z.infer<typeof presentPerson>;
export type ThreadPresence = z.infer<typeof threadPresence>;
export type WhoAmI = z.infer<typeof whoami>;

export const rpcContract = defineRpcContract({
  identity_whoami: {
    input: z.object({}).strict().nullish(),
    output: whoami,
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
  const applySettings = (values: { directory: string; fallbackEmail: string }, reportInvalid: boolean) => {
    fallbackEmail = values.fallbackEmail;
    const parsed = parseDirectory(values.directory);
    if (parsed.ok) {
      people = parsed.people;
      return;
    }
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

  bb.rpc.register(rpcContract, {
    identity_whoami: () => whoamiFor(requestContext.current()?.email ?? null),
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
  bb.onDispose(() => store.clear());
}
