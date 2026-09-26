import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  AttributionLedger,
  MAX_STARTER_RECORDS,
  attributeDispatch,
  starterSummarySchema,
  type StarterRecord,
} from "./attribution.js";
import { hostRefSchema, type HostRef } from "./host-ref.js";
import {
  HostPins,
  classifyHost,
  parseTeamMachines,
  personFromHostName,
  type HostClassification,
} from "./hosts.js";
import { makeGuardrail } from "./guardrail.js";
import {
  AUDIT_SCHEMA_VERSION,
  ENFORCEMENT_MODES,
  RequestAuditor,
  dispatchAuditLine,
  emitAudit,
  formatAuditLine,
  normalizeAuditPath,
  parseEnforcement,
  postDispatchAuditLine,
  colorChangeAuditLine,
  pinChangeAuditLine,
  settingsChangeAuditLine,
  type AuditLine,
  type EnforcementMode,
  type SettingsChange,
} from "./audit.js";
import { parseDirectory, resolveRequester, type Person, type ResolvedIdentity } from "./people.js";
import { identityMutationAllowed, mintSelection, readNamedCookie, SELECTION_COOKIE, SelectionCommitStore, selectionCookie, selectionCookieName, verifySelection } from "./selection.js";
import { MAX_QUEUED_REQUESTERS, QueuedRequesterLedger, digestQueuedContent } from "./queued-requester.js";
import { PersonColorStore, SeenPeople } from "./person-store.js";
import { buildRoster, SEEN_UNKNOWN_CAVEAT } from "./roster.js";
import {
  ACCESS_EMAIL_HEADER,
  installRequestContext,
  normalizeEmail,
  SELF_TEST_EMAIL,
  selfTestRequestContext,
  type SelfTestResult,
} from "./request-context.js";
import {
  AUDIT_JQ_COMMAND,
  PICKER_STATUSES,
  checkSettingsPatch,
  enforceRisks,
  lintConfig,
  readiness,
  redactDiagnostics,
  settingsPatchSchema,
  validateSelectionOrigin,
  type AdminFacts,
  type LedgerFill,
  type PickerStatus,
  type SigningKeyStatus,
  type WritableSettings,
} from "./settings-admin.js";

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
const leasePerson = personSummary.extend({ provenance: z.enum(["upstream-header", "self-selected", "configured-fallback", "unknown", "mixed"]).optional() }).strict();
const presentPerson = leasePerson.extend({ typing: z.boolean() }).strict();
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
  provenance: z.enum(["upstream-header", "self-selected", "configured-fallback", "unknown"]),
  selection: z.object({ status: z.enum(["valid", "stale", "expired", "invalid", "overridden"]) }).nullable(),
  picker: z.object({ enabled: z.boolean(), status: z.string(), people: z.array(z.object({
    person: z.string(), displayName: z.string(),
  }).strict()) }),
}).strict();
const selectionPreparation = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), url: z.string() }).strict(),
  z.object({ ok: z.literal(false), reason: z.string() }).strict(),
]);
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
  provenance: z.enum(["self-selected", "configured-fallback", "unknown"]).optional(),
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
  provenance: z.enum(["self-selected", "configured-fallback", "unknown"]).optional(),
}).strict().nullable();

export type PresenceLocation = z.infer<typeof location>;
export type LeasePerson = z.infer<typeof leasePerson>;
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
    ...(record.provenance ? { provenance: record.provenance } : {}),
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
  /** The recorded machine, already classified; null when there is none to classify. */
  host: HostClassification | null,
): ThreadOwnership {
  if (starter === null) {
    return { threadId: wanted, starter: null, via: "unknown", inheritedFrom: null, host: null };
  }
  return threadOwnership.parse({
    threadId: starter.threadId,
    starter: starter.starter,
    via: starter.via,
    inheritedFrom: starter.inheritedFrom,
    host: starter.host === null ? null : host,
    ...(starter.provenance ? { provenance: starter.provenance } : {}),
  });
}

/**
 * The machine-list answer, validated against the very schema the RPC contract
 * publishes — the same guard `publicStarter` gives the starter read path. It exists
 * because a leaked internal field (the cache's `at`) failed strict output validation at
 * runtime, in the browser, where nothing surfaced it but a silently empty banner.
 */
export function publicMachineList(listed: MachineList): MachineList {
  return machineList.parse(listed);
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
  /**
   * True when `me` came from the `fallbackEmail` setting rather than from the request.
   * The guardrail ignores such an identity (see `makeGuardrail`), so the UI must too, or
   * a chip would contradict the audit log it exists to illustrate.
   */
  meViaFallback: z.boolean(),
  meProvenance: z.enum(["upstream-header", "self-selected", "configured-fallback", "unknown"]).optional(),
  /**
   * Every person in the directory, by id. The UI deals per-person colours by position in
   * this list (`personColor`), which is what makes two people reliably look different.
   */
  roster: z.array(z.string()),
  /**
   * The CHOSEN colours, `person -> #rrggbb`, so every surface that already deals a hue
   * from `roster` paints the override instead where there is one. Rides along with the
   * roster rather than costing the sidebar a second call.
   */
  colors: z.record(z.string(), z.string()),
  machines: z.array(hostClassification),
  /** The account team and unclaimed machines run as, for the header chip's wording. */
  sharedMachineUser: z.string(),
  /**
   * Which enforcement mode is in force. The UI must not promise an enforcement the
   * server is not performing, so every banner and chip that mentions one reads this.
   */
  enforcement: z.enum(ENFORCEMENT_MODES),
  /** Why the list is empty, when it is. Null when the list was read successfully. */
  unavailable: z.string().nullable(),
}).strict();

/**
 * One person as the settings page shows them: who they are, the colour in force (with
 * the dealt one behind it, so "reset" has something to name), the ink that stays legible
 * on it, their machines, and whether Identity has seen them.
 */
const rosterPerson = z.object({
  person: z.string(),
  displayName: z.string(),
  github: z.string(),
  emails: z.array(z.string()),
  color: z.string(),
  dealt: z.string(),
  overridden: z.boolean(),
  ink: z.string(),
  machines: z.array(z.string()),
  seen: z.boolean(),
  seenAt: z.number().nullable(),
  /** Display names whose colour reads the same. A warning; nothing refuses a clash. */
  clashesWith: z.array(z.string()),
}).strict();

const roster = z.object({
  /** Who is asking, so the page can say whose colour a change is about to touch. */
  me: personSummary.nullable(),
  meViaFallback: z.boolean(),
  people: z.array(rosterPerson).max(MAX_LEASES),
  /** Exactly what a seen-state answer means. The UI must not imply more. */
  seenCaveat: z.string(),
  /** Why the machine list is missing, when it is. Null when it was read successfully. */
  unavailable: z.string().nullable(),
}).strict();

/** What a colour write did. A refusal is an ANSWER, not a thrown RPC error. */
const colorWrite = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    person: z.string(),
    from: z.string().nullable(),
    to: z.string().nullable(),
  }).strict(),
  z.object({ ok: z.literal(false), person: z.string(), reason: z.string() }).strict(),
]);

const selfTestSchema = z.object({
  ok: z.boolean(),
  detail: z.string(),
  cookie: z.object({ ok: z.boolean(), detail: z.string() }).strict(),
}).strict();
const lintIssue = z.object({
  id: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  fix: z.string(),
}).strict();
const readinessItem = z.object({
  id: z.enum(["profile", "people", "machines", "browser", "guardrail", "check"]),
  label: z.string(),
  status: z.enum(["ok", "attention", "off", "problem"]),
  text: z.string(),
  tab: z.enum(["profile", "people", "machines", "browser", "rules", "health"]),
}).strict();
const ledgerCount = z.object({ count: z.number().int().nonnegative().nullable(), max: z.number().int() }).strict();

/**
 * Everything the settings section reads in one call. It carries the signing key's
 * STATUS only — never the key — and the directory as a count and an error, since the
 * directory itself is owned by Ansible and edited in the infra repo, not here.
 */
const settingsOverview = z.object({
  settings: z.object({
    teamMachines: z.string(),
    sharedMachineUser: z.string(),
    enforcement: z.enum(ENFORCEMENT_MODES),
    fallbackEmail: z.string(),
    selfSelectedIdentity: z.boolean(),
    selectionPublicOrigin: z.string(),
    signingKey: z.enum(["valid", "invalid", "missing"]),
  }).strict(),
  directory: z.object({ ok: z.boolean(), error: z.string().nullable(), people: z.number().int().nonnegative() }).strict(),
  /** Nobody registered and every writable setting at its default: the page shows its first-run path. */
  firstRun: z.boolean(),
  /** This request, or any since load, carried the Access header (the self-test's never counts). */
  accessSeen: z.boolean(),
  pickerStatus: z.enum(PICKER_STATUSES),
  selfTest: selfTestSchema.nullable(),
  ledgers: z.object({ starters: ledgerCount, queued: ledgerCount }).strict(),
  conflicts: z.number().int().nonnegative(),
  enforceRisks: z.array(z.string()),
  readiness: z.array(readinessItem).length(6),
  lint: z.array(lintIssue),
  auditCommand: z.string(),
}).strict();

/** What a settings write did. A refusal is an ANSWER, not a thrown RPC error. */
const settingsWrite = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), changed: z.array(z.string()) }).strict(),
  z.object({ ok: z.literal(false), reason: z.string() }).strict(),
]);
const rotateAnswer = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: z.string() }).strict(),
]);
const pinResolution = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), machine: hostClassification.nullable() }).strict(),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["unknown-host", "no-pin", "not-in-directory", "no-person", "write-failed"]),
  }).strict(),
]);

export type SettingsOverview = z.infer<typeof settingsOverview>;
export type SettingsWriteAnswer = z.infer<typeof settingsWrite>;
export type PinResolution = z.infer<typeof pinResolution>;
export type RosterAnswer = z.infer<typeof roster>;
export type ColorWriteAnswer = z.infer<typeof colorWrite>;

/**
 * The roster answer, validated against the very schema the RPC publishes — the same
 * guard `publicStarter` and `publicMachineList` carry, and for the same reason: a leaked
 * internal field fails strict output validation at RUNTIME, in the browser, where the
 * only symptom is a silently empty panel (step 4, 2026-09-18).
 */
export function publicRoster(input: {
  me: LeasePerson | null;
  meViaFallback: boolean;
  people: readonly Person[];
  overrides: Readonly<Record<string, string>>;
  machines: readonly HostClassification[];
  seen: Readonly<Record<string, number>>;
  unavailable: string | null;
}): RosterAnswer {
  return roster.parse({
    me: input.me,
    meViaFallback: input.meViaFallback,
    people: buildRoster({
      people: input.people,
      overrides: input.overrides,
      machines: input.machines,
      seen: input.seen,
    }),
    seenCaveat: SEEN_UNKNOWN_CAVEAT,
    unavailable: input.unavailable,
  });
}

export const rpcContract = defineRpcContract({
  identity_whoami: {
    input: z.object({}).strict().nullish(),
    output: whoami,
  },
  identity_prepare_selection: {
    input: z.discriminatedUnion("action", [
      z.object({ action: z.literal("select"), personId: z.string().min(1).max(80) }).strict(),
      z.object({ action: z.literal("forget") }).strict(),
    ]),
    output: selectionPreparation,
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
  /** Who is registered on this server — the settings page's people list. */
  identity_roster: {
    input: z.object({}).strict().nullish(),
    output: roster,
  },
  /**
   * Choose a person's colour.
   *
   * ANYONE may set ANYONE's, deliberately: this plugin is a guardrail against mistakes
   * and never verifies the Access header, so an authorization check here would be
   * theatre — and a teammate who never opens settings still needs a colour someone can
   * fix. Every call writes an audit line naming who changed whose, from and to.
   */
  identity_set_person_color: {
    input: z.object({ person: z.string().min(1).max(128), color: z.string().min(1).max(32) }).strict(),
    output: colorWrite,
  },
  /** Return a person to their dealt colour. */
  identity_clear_person_color: {
    input: z.object({ person: z.string().min(1).max(128) }).strict(),
    output: colorWrite,
  },
  /** The settings section's whole picture: settings, readiness, lint, ledgers, self-test. */
  identity_settings_overview: {
    input: z.object({}).strict().nullish(),
    output: settingsOverview,
  },
  /**
   * Write the settings the section owns. `directory` and `selectionSigningKey` are NOT
   * in the schema: the directory is Ansible's, and the key only ever changes by rotation.
   * Every write that changes something logs one `settings.change` line.
   */
  identity_update_settings: {
    input: settingsPatchSchema,
    output: settingsWrite,
  },
  /** Mint a fresh signing key. Every existing browser selection expires at once. */
  identity_rotate_signing_key: {
    input: z.object({ confirm: z.literal("rotate") }).strict(),
    output: rotateAnswer,
  },
  /** An operator's answer to a pin conflict: keep the pin, move it, or forget it. */
  identity_resolve_pin: {
    input: z.object({
      hostId: z.string().min(1).max(200),
      action: z.enum(["keep", "repin", "unpin"]),
      person: z.string().min(1).max(200).optional(),
    }).strict(),
    output: pinResolution,
  },
  identity_rerun_self_test: {
    input: z.object({}).strict().nullish(),
    output: z.object({ selfTest: selfTestSchema, pickerStatus: z.enum(PICKER_STATUSES) }).strict(),
  },
  /** A redacted support bundle: counts and statuses, never an email or a key. */
  identity_diagnostics: {
    input: z.object({}).strict().nullish(),
    output: z.object({ text: z.string() }).strict(),
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
          ...(lease.person.provenance || known?.provenance ? { provenance: known?.provenance
            && lease.person.provenance && known.provenance !== lease.person.provenance
              ? "mixed" as const : lease.person.provenance ?? known?.provenance } : {}),
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
  return left.person === right.person && left.displayName === right.displayName && left.github === right.github
    && left.provenance === right.provenance;
}

function summarize(person: Person | null): LeasePerson | null {
  return person ? { person: person.person, displayName: person.displayName, github: person.github } : null;
}
function summarizePresence(identity: ResolvedIdentity): LeasePerson | null {
  const person = summarize(identity.person);
  return person ? { ...person, provenance: identity.provenance } : null;
}

function sameLocation(left: PresenceLocation, right: PresenceLocation): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "thread" && right.kind === "thread") return left.threadId === right.threadId;
  if (left.kind === "project" && right.kind === "project") return left.projectId === right.projectId;
  return left.kind === "elsewhere" && right.kind === "elsewhere";
}

export default async function plugin(bb: BbPluginApi) {
  const requestContext = installRequestContext();
  /** Durable hostId -> person pins. */
  const pins = new HostPins(bb.storage.kv, []);
  /**
   * The colours people CHOSE, and who Identity has seen.
   *
   * Both in `bb.storage.kv` and deliberately NOT in the `directory` setting: that setting
   * is rendered by Ansible from `ew_bb_people` in the infra repo, so a preference written
   * there is clobbered on the next run. See person-store.ts's header for the full
   * argument before moving either of them.
   */
  const colors = new PersonColorStore(bb.storage.kv);
  const seen = new SeenPeople(bb.storage.kv);
  /**
   * bb's own host list, cached. Declared up here because the guardrail reads it — without
   * ever refreshing it — to name the machines a refusal should suggest.
   */
  let machineCache: { at: number; machines: HostClassification[]; unavailable: string | null } | null = null;
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
    enforcement: {
      type: "select",
      label: "Enforcement",
      options: [...ENFORCEMENT_MODES],
      description:
        "off: record who started what, label it in the UI, and never refuse anything. "
        + "audit: take the SAME decision enforcement would, write it to the log (`bb plugin logs identity`) "
        + "as a would-refuse, and let the message through anyway. "
        + "enforce: act on that decision — refuse a known person's start on another person's machine, their "
        + "message into someone else's thread, and an automation spawning a thread on a named machine that is "
        + "not a team machine. A dispatch Identity cannot tie to a person is never refused by the person rules — "
        + "that is the normal shape of every agent path — and an identity supplied by Fallback email or a browser "
        + "name counts as untied. The automation rule needs no person, but sees only spawns bb stamps: an "
        + "automation posting into an existing thread arrives unstamped and is allowed, as is a spawn naming no machine. "
        + "audit and enforce both log their verdicts; off logs no verdicts, but settings, pin and colour "
        + "changes are logged in every mode when made through the People & machines section — a change made "
        + "in this form or with bb plugin config is applied but not logged. Emails appear in those log lines by design.",
      default: "off",
    },
    fallbackEmail: {
      type: "string",
      label: "Fallback email",
      description:
        "Used as the requester's email when a request carries no Cloudflare Access header and no valid browser name, "
        + "for a BB server not behind Access (e.g. a laptop). Such callers, agents and CLI included, are then "
        + "attributed to this email; a stale, expired or invalid browser name stays anonymous and never falls "
        + "through to it. The guardrail ignores a fallback identity and never refuses on it. "
        + "Leave empty on a shared server.",
      default: "",
    },
    selfSelectedIdentity: {
      type: "boolean", label: "Browser identity picker", default: false,
      description: "Allow attribution-only browser selection from the Identity directory. Never counts as policy identity.",
    },
    selectionPublicOrigin: {
      type: "string", label: "Identity picker public origin", default: "",
      description: "Exact browser origin (scheme, host and optional port). Required to issue a selection; no forwarded header is trusted.",
    },
    selectionSigningKey: {
      type: "string", label: "Identity picker signing key", secret: true,
      description: "32-byte base64url HMAC key. Rotate by setting a fresh key; all existing selections expire immediately.",
    },
  });

  let people: Person[] = [];
  let fallbackEmail = "";
  let teamMachines: string[] = [];
  let sharedMachineUser = "ensembleworks-agent";
  let enforcement: EnforcementMode = "off";
  let selfSelectedIdentity = false;
  let selectionPublicOrigin = "";
  let selectionKey: Buffer | null = null;
  /** For the settings section: why the directory did not parse, and the key's state. */
  let directoryError: string | null = null;
  let signingKeyStatus: SigningKeyStatus = "missing";
  /** Whether any request since load carried the Access header — a hint the server is shared. */
  let accessSeen = false;
  const applySettings = (
    values: {
      directory: string;
      fallbackEmail: string;
      teamMachines: string;
      sharedMachineUser: string;
      enforcement: string;
      selfSelectedIdentity: boolean;
      selectionPublicOrigin: string;
      selectionSigningKey?: string;
    },
    reportInvalid: boolean,
  ) => {
    fallbackEmail = values.fallbackEmail;
    enforcement = parseEnforcement(values.enforcement);
    selfSelectedIdentity = values.selfSelectedIdentity;
    selectionPublicOrigin = validateSelectionOrigin(values.selectionPublicOrigin) ?? "";
    requestContext.setCookieName(selectionPublicOrigin ? selectionCookieName(selectionPublicOrigin) : SELECTION_COOKIE);
    const decoded = values.selectionSigningKey ? Buffer.from(values.selectionSigningKey, "base64url") : null;
    selectionKey = decoded?.length === 32 ? decoded : null;
    signingKeyStatus = !values.selectionSigningKey ? "missing" : selectionKey ? "valid" : "invalid";
    teamMachines = parseTeamMachines(values.teamMachines);
    sharedMachineUser = values.sharedMachineUser.trim() || "ensembleworks-agent";
    // A settings change can reclassify every machine (the team list, the directory), so
    // the next read lists them afresh rather than serving a stale label for 30 seconds.
    machineCache = null;
    const parsed = parseDirectory(values.directory);
    directoryError = parsed.ok ? null : parsed.error;
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
    let initial = await settings.get();
    if (!initial.selectionSigningKey) {
      await settings.experimental_set({ selectionSigningKey: randomBytes(32).toString("base64url") });
      initial = await settings.get();
    }
    applySettings(initial, true);
  } catch (error) {
    bb.log.warn(`identity: could not read settings: ${(error as Error).message}`);
  }
  settings.onChange((next) => applySettings(next, false));

  // ── Audit mode (2026-09-18): what identity actually reaches us ──────────────────
  //
  // Three streams, all through `bb.log` and nothing else (owner's decision: no ring
  // buffer, no /audit route, no UI log page). One JSON object per line, prefixed so
  // `AUDIT_JQ_COMMAND` can pick it out of `bb plugin logs identity`'s JSON envelopes.
  //
  // Nothing here may refuse or delay a dispatch: `emitAudit` swallows its own failures,
  // the dispatch stream runs inside the hook's existing 5s fail-open deadline, and the
  // request stream runs on the request thread but does no I/O at all.
  const auditLine = (line: AuditLine) => {
    bb.log.info(formatAuditLine(line));
  };
  const auditing = () => enforcement !== "off";
  let selfTest: SelfTestResult | null = null;
  const pickerStatus = (): PickerStatus => !selfSelectedIdentity ? "off"
    : selectionPublicOrigin === "" ? "origin-not-configured"
      : selectionKey === null ? "signing-key-unavailable"
        : selfTest?.cookie.ok !== true ? "cookie-bridge-unavailable" : "ready";
  const currentIdentity = (
    email = requestContext.current()?.email ?? null,
    selection = requestContext.current()?.selection ?? null,
  ): ResolvedIdentity => resolveRequester({
    people, email, selection: pickerStatus() === "ready" ? selection : null, fallbackEmail,
    verify: (token) => selectionKey === null ? { status: "invalid" }
      : verifySelection(token, selectionPublicOrigin, selectionKey),
  });

  /**
   * Stream (a): the request stream. The ALS patch sees EVERY http request bb handles —
   * including the routes the dispatch hook never sees (terminals, Stop, Archive,
   * answering approvals, host routes, plugin RPCs), which is what answers the owner's
   * question about which actions carry identity.
   *
   * Volume is the real problem here, so `RequestAuditor` gives mutations their own line
   * and counts everything else into a rollup. See `audit.ts` for the policy and the
   * design note for the measurement behind it.
   */
  const requestAuditor = new RequestAuditor({ emit: auditLine, now: () => Date.now() });
  const stopObserving = requestContext.observe((facts) => {
    if (facts.email && facts.email !== SELF_TEST_EMAIL) accessSeen = true;
    if (!auditing()) return;
    requestAuditor.observe({
      id: facts.id,
      method: facts.method,
      url: facts.url,
      email: facts.email,
      person: summarize(currentIdentity(facts.email, facts.selection).person),
      provenance: currentIdentity(facts.email, facts.selection).provenance,
    });
  });

  /** The request this code is running for, as an audit line's correlation fields. */
  const currentRequestFields = () => {
    const facts = requestContext.current();
    return {
      requestId: facts?.id ?? null,
      requestMethod: facts?.method?.toUpperCase() ?? null,
      requestPath: facts === undefined ? null : normalizeAuditPath(facts.url),
    };
  };

  /** Identity of whoever made the current request; unknown outside a request (startup race). */
  /** The current requester as attribution wants them: their email plus resolved person. */
  const whoamiPerson = () => {
    const identity = currentIdentity();
    return { email: identity.email, person: summarize(identity.person), viaFallback: identity.viaFallback,
      provenance: identity.provenance, captureSource: requestContext.current() ? "request" as const : "unknown" as const };
  };
  const whoamiFor = (email = requestContext.current()?.email ?? null,
    selection = requestContext.current()?.selection ?? null): WhoAmI => {
    const identity = currentIdentity(email, selection);
    return { email: identity.email, person: summarize(identity.person), provenance: identity.provenance,
      selection: identity.selection,
      picker: { enabled: pickerStatus() === "ready", status: pickerStatus(),
        people: people.map(({ person, displayName }) => ({ person, displayName })) } };
  };

  const store = new PresenceStore();
  const selectionCommits = new SelectionCommitStore();
  const publish = (threadIds: Iterable<string>) => {
    bb.realtime.publish("presence-changed", { threadIds: [...threadIds] });
  };

  bb.http.route("GET", "/whoami", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(whoamiFor(normalizeEmail(c.req.header(ACCESS_EMAIL_HEADER)),
      readNamedCookie(c.req.header("cookie"), requestContext.cookieName())));
  }, { auth: "local" });

  const jsonMutation = (c: { req: { header: (name: string) => string | undefined } }) => {
    return identityMutationAllowed(c.req.header("content-type"), c.req.header("origin"), selectionPublicOrigin);
  };
  const logJsonMutationRejection = (c: { req: { header: (name: string) => string | undefined } }, action: "select" | "forget") => {
    const bounded = (value: string | undefined) => value?.slice(0, 256) ?? null;
    bb.log.warn(`identity: browser ${action} rejected ${JSON.stringify({
      origin: bounded(c.req.header("origin")),
      browserOrigin: bounded(c.req.header("x-identity-browser-origin")),
      contentType: bounded(c.req.header("content-type")),
      secFetchSite: bounded(c.req.header("sec-fetch-site")),
    })}`);
  };
  bb.http.route("POST", "/select-identity", async (c) => {
    if (pickerStatus() !== "ready") return c.json({ ok: false, reason: pickerStatus() }, 409);
    if (!jsonMutation(c)) {
      logJsonMutationRejection(c, "select");
      return c.json({ ok: false, reason: "origin-or-content-type" }, 403);
    }
    if (normalizeEmail(c.req.header(ACCESS_EMAIL_HEADER))) return c.json({ ok: false, reason: "upstream-identity" }, 409);
    const parsed = z.object({ personId: z.string().min(1).max(80) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, reason: "invalid-input" }, 400);
    if (!people.some((person) => person.person === parsed.data.personId)) return c.json({ ok: false, reason: "not-in-directory" }, 400);
    const token = mintSelection(parsed.data.personId, selectionPublicOrigin, selectionKey!);
    c.header("Set-Cookie", selectionCookie(token, selectionPublicOrigin.startsWith("https:"), selectionPublicOrigin));
    c.header("Cache-Control", "no-store");
    emitAudit(auditLine, { v: AUDIT_SCHEMA_VERSION, kind: "identity.selection", at: Date.now(),
      action: "select", person: parsed.data.personId, provenance: "self-selected", ...currentRequestFields() });
    return c.json({ ok: true, whoami: whoamiFor(null, token) });
  }, { auth: "local" });
  bb.http.route("POST", "/forget-identity", (c) => {
    if (!jsonMutation(c)) {
      logJsonMutationRejection(c, "forget");
      return c.json({ ok: false, reason: "origin-or-content-type" }, 403);
    }
    c.header("Set-Cookie", selectionCookie(null, selectionPublicOrigin.startsWith("https:"), selectionPublicOrigin));
    c.header("Cache-Control", "no-store");
    emitAudit(auditLine, { v: AUDIT_SCHEMA_VERSION, kind: "identity.selection", at: Date.now(),
      action: "forget", provenance: currentIdentity().provenance, ...currentRequestFields() });
    return c.json({ ok: true, whoami: whoamiFor(null, null) });
  }, { auth: "local" });
  bb.http.route("GET", "/commit-identity", (c) => {
    const commit = selectionCommits.consume(c.req.query("token") ?? "");
    if (commit === null) return c.json({ ok: false, reason: "invalid-or-expired-capability" }, 400);
    if (pickerStatus() !== "ready") return c.json({ ok: false, reason: pickerStatus() }, 409);
    if (commit.action === "select" && normalizeEmail(c.req.header(ACCESS_EMAIL_HEADER))) {
      return c.json({ ok: false, reason: "upstream-identity" }, 409);
    }
    if (commit.action === "select" && !people.some((person) => person.person === commit.personId)) {
      return c.json({ ok: false, reason: "not-in-directory" }, 400);
    }
    const token = commit.action === "select"
      ? mintSelection(commit.personId, selectionPublicOrigin, selectionKey!)
      : null;
    c.header("Set-Cookie", selectionCookie(token, selectionPublicOrigin.startsWith("https:"), selectionPublicOrigin));
    c.header("Cache-Control", "no-store");
    emitAudit(auditLine, { v: AUDIT_SCHEMA_VERSION, kind: "identity.selection", at: Date.now(),
      action: commit.action, ...(commit.action === "select" ? { person: commit.personId } : {}),
      provenance: commit.action === "select" ? "self-selected" : currentIdentity().provenance,
      ...currentRequestFields() });
    return c.json({ ok: true, whoami: whoamiFor(null, token) });
  }, { auth: "local" });

  // ── Attribution (step 3): observe and record who started each thread. ─────────────
  const ledger = new AttributionLedger(bb.storage.kv);
  const queuedRequesters = new QueuedRequesterLedger(bb.storage.kv);
  const submissionRequest = () => {
    const facts = requestContext.current();
    if (!facts || facts.method?.toUpperCase() !== "POST") return null;
    if (Date.now() - facts.startedAt > 30_000 || (facts.finishedAt !== undefined && Date.now() - facts.finishedAt > 2_000)) return null;
    const path = facts.url?.split("?")[0] ?? "";
    return /^\/api\/v1\/threads(?:\/fork|\/[A-Za-z0-9_-]+\/send)?$/.test(path) ? facts : null;
  };
  const sendNowRequest = () => {
    const facts = requestContext.current();
    if (!facts || facts.method?.toUpperCase() !== "POST" || Date.now() - facts.startedAt > 30_000) return null;
    const path = facts.url?.split("?")[0] ?? "";
    return /^\/api\/v1\/threads\/[A-Za-z0-9_-]+\/queued-messages\/[A-Za-z0-9_-]+\/send$/.test(path)
      ? facts : null;
  };

  /**
   * The self-test's own route. It reports the email the ASYNC CONTEXT holds — not the
   * header off this request — so a reply naming the tagged email proves the patch is
   * carrying facts through bb's real server into plugin code in this process.
   */
  bb.http.route("GET", "/request-context-probe", (c) => {
    return c.json({ email: requestContext.current()?.email ?? null, selection: requestContext.current()?.selection ?? null });
  }, { auth: "local" });

  /** The boot self-test's verdict, so an operator can read it without digging in logs. */
  bb.http.route("GET", "/request-context-self-test", (c) => {
    return c.json(selfTest ?? { ok: false, detail: "the self-test has not finished yet" });
  }, { auth: "local" });

  /** Label one machine: the team list, then the pin, then the name, then "unclaimed". */
  const classifyWithPin = async (host: HostRef): Promise<HostClassification> =>
    classifyHost(host, { people, teamMachines, pin: await pins.get(host.id) });

  /**
   * The guardrail (step 5). It refuses only a POSITIVELY IDENTIFIED requester — a known
   * person, or a dispatch bb stamped as the automations plugin — and only while
   * `enforcement` is `enforce` (`audit` logs the same verdict). See guardrail.ts for why a
   * dispatch with no identity and no automations stamp is always allowed (S9: that is the
   * shape of every agent path).
   *
   * The machine names in a refusal come from memory only: the team-machines setting, and
   * the machine list IF it happens to be warm. A refusal must never wait on the network
   * to word itself, and the hook is on bb's critical path.
   */
  const guard = makeGuardrail({
    mode: () => enforcement,
    classify: classifyWithPin,
    machines: (requester) => ({
      yourMachines: requester === null ? [] : (machineCache?.machines ?? [])
        .filter((host) => host.kind === "person" && host.person.person === requester.person)
        .map((host) => host.hostName),
      teamMachines,
    }),
  });

  // The ONE place Identity can refuse a dispatch, and it is bounded: `attributeDispatch`
  // answers inside its own deadline, never throws, and falls open on any failure.
  bb.experimental_hooks.on("message.dispatch", (context) =>
    attributeDispatch(context, {
      ledger,
      guard,
      identity: async () => {
        if (context.queuedMessages.length > 0) {
          const rows = await Promise.all(context.queuedMessages.map((row) => queuedRequesters.lookup(row.id)));
          const first = rows[0];
          if (first && rows.every((row, index) => row && row.person?.person === first.person?.person
            && row.provenance === first.provenance && row.contentDigest !== null
            && row.contentDigest === digestQueuedContent(context.queuedMessages[index]?.content))) {
            return { email: first.email, person: first.person, provenance: first.provenance,
              viaFallback: first.provenance === "configured-fallback", captureSource: "queue-ledger" as const };
          }
          return { email: null, person: null, provenance: "unknown" as const, viaFallback: false,
            captureSource: rows.some((row) => row === null) ? "capture-missing" as const : "queue-content-unknown" as const };
        }
        return submissionRequest() ? whoamiPerson() : {
          email: null, person: null, provenance: "unknown" as const, viaFallback: false, captureSource: "unknown" as const,
        };
      },
      now: () => Date.now(),
      // Display-only side effect: every machine bb itself names gets pinned on first
      // sight. `HostPins` never throws and bounds its own storage calls.
      observeHost: (host) => pins.observe(host),
      /**
       * Seen-state, maintained rather than scanned: the dispatch that records a thread's
       * starter marks that person seen. O(1), coalesced to one write per person per hour,
       * and — like everything else on this path — time-bounded and never throwing, so the
       * settings page never has to walk the ledger.
       */
      observeStarter: (person) => seen.observe(person, Date.now()),
      log: { info: (message) => bb.log.info(message), warn: (message) => bb.log.warn(message) },
      /**
       * Stream (b): every dispatch, with the full attribution facts PLUS the guardrail's
       * verdict — the rule that would have fired and the refusal it would have produced —
       * next to the action actually returned. In `audit` those two differ, and that
       * difference is the point.
       */
      audit: (record) => {
        // Checked HERE, not at registration: the setting changes at runtime through
        // `bb plugin config identity set enforcement …`, and a gate evaluated when the
        // hook was registered kept the dispatch stream silent until the next reload.
        // (Found by running it on a throwaway, 2026-09-18.)
        if (!auditing()) return;
        emitAudit(auditLine, dispatchAuditLine({
          at: Date.now(),
          ...currentRequestFields(),
          mode: enforcement,
          facts: record.facts,
          hostKind: record.outcome.hostKind,
          recordedStarter: record.existing?.starter ?? null,
          starter: record.decided?.starter ?? null,
          via: record.decided?.via ?? null,
          verdict: record.outcome.verdict,
          action: record.outcome.action.action,
        }));
      },
    }));

  /**
   * Stream (c): the post-dispatch events. Per S7 these run in the REQUESTER's async
   * context, so they see the paths the hook never does — Send-now, and a queued row
   * draining later. This is the "what we couldn't block" half: it reports identity, it
   * cannot act on it.
   */
  for (const event of ["message.queued", "message.dispatched"] as const) {
    bb.events.on(event, ({ entry }) => {
      const facts = event === "message.queued" ? submissionRequest() : null;
      const identity = facts ? currentIdentity(facts.email, facts.selection) : null;
      const triggerFacts = event === "message.dispatched" ? sendNowRequest() : null;
      const trigger = triggerFacts ? currentIdentity(triggerFacts.email, triggerFacts.selection) : null;
      if (event === "message.queued" && entry.id && entry.threadId) {
        void queuedRequesters.record({ v: 1, id: entry.id, threadId: entry.threadId,
          email: identity?.email ?? null, person: summarize(identity?.person ?? null),
          provenance: identity?.provenance ?? "unknown", requestId: facts?.id ?? null, capturedAt: Date.now(),
          contentDigest: digestQueuedContent(entry.content) });
      }
      void (async () => {
        const stored = event === "message.dispatched" && entry.id ? await queuedRequesters.lookup(entry.id) : null;
        const contentUnchanged = stored ? stored.contentDigest !== null && stored.contentDigest !== undefined
          && stored.contentDigest === digestQueuedContent(entry.content) : null;
        if (auditing()) emitAudit(auditLine, postDispatchAuditLine({
        kind: event,
        at: Date.now(),
        requestId: facts?.id ?? triggerFacts?.id ?? null,
        requestMethod: facts?.method?.toUpperCase() ?? triggerFacts?.method?.toUpperCase() ?? null,
        requestPath: facts ? normalizeAuditPath(facts.url) : triggerFacts ? normalizeAuditPath(triggerFacts.url) : null,
        mode: enforcement,
        entryId: entry.id ?? null,
        threadId: entry.threadId ?? null,
        senderThreadId: entry.senderThreadId ?? null,
        email: event === "message.queued" ? identity?.email ?? null : contentUnchanged ? stored?.email ?? null : null,
        person: event === "message.queued" ? summarize(identity?.person ?? null) : contentUnchanged ? stored?.person ?? null : null,
        provenance: event === "message.queued" ? identity?.provenance ?? "unknown" : contentUnchanged ? stored?.provenance ?? "unknown" : "unknown",
        captureSource: event === "message.queued" ? facts ? "request" : "capture-missing"
          : stored ? contentUnchanged ? "queue-ledger" : "queue-content-unknown" : "capture-missing",
        ...(event === "message.dispatched" ? { triggerPerson: summarize(trigger?.person ?? null),
          triggerProvenance: trigger?.provenance ?? "unknown", contentUnchanged } : {}),
      }));
        if (event === "message.dispatched" && entry.id) await queuedRequesters.forget(entry.id);
      })().catch(() => undefined);
    });
  }
  bb.events.on("message.cancelled", ({ entry }) => { void queuedRequesters.forget(entry.id); });
  bb.events.on("thread.deleted", ({ thread }) => { void queuedRequesters.forgetThread(thread.id); });

  /**
   * Log a colour change: who changed whose, from and to.
   *
   * This is what makes "anyone may change anyone's colour" safe — the change is VISIBLE
   * rather than prevented, which is the owner's decision and the only one consistent with
   * a plugin that never verifies the Access header. Deliberately NOT gated on
   * `enforcement`: a mode that silenced this would silence exactly the record the owner
   * asked for, and unlike the dispatch stream it is one line per deliberate human click.
   *
   * A refused write logs nothing: nothing changed, so there is nothing to account for.
   */
  /** Who is making an admin change right now, as the colour/settings/pin lines name them. */
  const adminActor = () => {
    const identity = currentIdentity();
    return {
      at: Date.now(),
      ...currentRequestFields(),
      mode: enforcement,
      by: summarize(identity.person),
      byEmail: identity.email,
      byProvenance: identity.provenance,
    };
  };
  const auditColorChange = (written: { ok: boolean; person: string; from?: string | null; to?: string | null }) => {
    if (!written.ok) return;
    emitAudit(auditLine, colorChangeAuditLine({
      ...adminActor(),
      subject: written.person,
      from: written.from ?? null,
      to: written.to ?? null,
    }));
  };

  const ownership = async (wanted: string): Promise<ThreadOwnership> => {
    const record = publicStarter(await ledger.get(wanted));
    const host = record?.host ?? null;
    return ownershipFor(wanted, record, host === null ? null : await classifyWithPin(host));
  };

  /**
   * bb's own host list, over the loopback API, cached briefly. The SDK gives a server
   * plugin no way to enumerate hosts (see `parseHostList`), and this is only ever used
   * to LIST machines in the composer banner.
   */
  const MACHINE_CACHE_MS = 30_000;
  const machines = async (): Promise<{ machines: HostClassification[]; unavailable: string | null }> => {
    if (machineCache !== null && Date.now() - machineCache.at < MACHINE_CACHE_MS) {
      return { machines: machineCache.machines, unavailable: machineCache.unavailable };
    }
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
    return { machines: classified, unavailable };
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
  const probe = async (headers: Record<string, string>): Promise<unknown> => {
    const response = await fetch(`${bb.server.loopbackBaseUrl}/api/v1/plugins/${bb.pluginId}/http/request-context-probe`, {
      headers,
    });
    if (!response.ok) throw new Error(`probe route answered ${response.status}`);
    return await response.json();
  };
  /**
   * Bumped by an operator's re-run and by dispose: a run from an older generation (the
   * boot run whose probe is still in flight) drops its result and schedules no retry, so
   * the re-run stays the one run and its result is the one that stands.
   */
  let selfTestGeneration = 0;
  const runSelfTest = async (attemptsLeft: number, generation = selfTestGeneration): Promise<void> => {
    let result: SelfTestResult;
    try {
      result = await selfTestRequestContext(requestContext, { probe });
    } catch (error) {
      result = { ok: false, detail: `the self-test could not run: ${(error as Error).message}`,
        cookie: { ok: false, detail: "probe unavailable" } };
    }
    if (generation !== selfTestGeneration) return;
    selfTest = result;
    if (!selfTest.ok && attemptsLeft > 0) {
      selfTestTimer = setTimeout(() => void runSelfTest(attemptsLeft - 1, generation), 1_000);
      return;
    }
    if (selfTest.ok) {
      bb.log.info(`identity: request-context self-test PASSED — ${selfTest.detail}`);
      if (!selfTest.cookie.ok) bb.log.warn(`identity: cookie bridge FAILED — ${selfTest.cookie.detail}; self-selected attribution disabled`);
      return;
    }
    bb.log.warn(
      `identity: request-context self-test FAILED — ${selfTest.detail}. Attribution and named `
      + "presence degrade to unknown; nothing is blocked.",
    );
  };
  let selfTestTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => void runSelfTest(5), 500);
  /** An operator's re-run, shared by every caller that asks while it is in flight. */
  let selfTestRun: Promise<SelfTestResult> | null = null;
  const rerunSelfTest = (): Promise<SelfTestResult> => {
    if (selfTestRun !== null) return selfTestRun;
    if (selfTestTimer !== undefined) clearTimeout(selfTestTimer);
    selfTestTimer = undefined;
    selfTestGeneration += 1;
    selfTestRun = runSelfTest(0).then(() => selfTest!).finally(() => { selfTestRun = null; });
    return selfTestRun;
  };

  // ── The settings section (2026-09-26): read the whole picture, write what it owns. ──
  const WRITABLE_DEFAULTS: WritableSettings = {
    teamMachines: "",
    sharedMachineUser: "ensembleworks-agent",
    enforcement: "off",
    fallbackEmail: "",
    selfSelectedIdentity: false,
    selectionPublicOrigin: "",
  };
  const WRITABLE_KEYS = Object.keys(WRITABLE_DEFAULTS) as Array<keyof WritableSettings>;
  const adminFacts = async (): Promise<AdminFacts & { stored: WritableSettings }> => {
    const current = await settings.get();
    const listed = await machines();
    const email = requestContext.current()?.email ?? null;
    return {
      stored: {
        teamMachines: current.teamMachines,
        sharedMachineUser: current.sharedMachineUser,
        enforcement: parseEnforcement(current.enforcement),
        fallbackEmail: current.fallbackEmail,
        selfSelectedIdentity: current.selfSelectedIdentity,
        selectionPublicOrigin: current.selectionPublicOrigin,
      },
      directoryError,
      people,
      teamMachines,
      machines: listed.machines,
      machinesUnavailable: listed.unavailable,
      enforcement,
      fallbackEmail,
      selfSelectedIdentity,
      selectionPublicOrigin: current.selectionPublicOrigin,
      signingKey: signingKeyStatus,
      pickerStatus: pickerStatus(),
      selfTest,
      accessSeen: accessSeen || (email !== null && email !== SELF_TEST_EMAIL),
    };
  };
  const ledgerFill = async (): Promise<LedgerFill> => ({
    starters: { count: await ledger.count(), max: MAX_STARTER_RECORDS },
    queued: { count: await queuedRequesters.count(), max: MAX_QUEUED_REQUESTERS },
  });
  /**
   * Re-read and re-apply at once, rather than trusting `onChange` to have run by now. It
   * runs after a write has already landed, so a failed read is reported, never thrown:
   * the write stands, and `onChange` still applies it.
   */
  const reapply = async () => {
    try {
      applySettings(await settings.get(), false);
    } catch (error) {
      bb.log.warn(`identity: a settings write landed but re-reading the settings failed: ${(error as Error).message}`);
    }
  };

  bb.rpc.register(rpcContract, {
    identity_whoami: () => whoamiFor(requestContext.current()?.email ?? null),
    identity_prepare_selection: (input) => {
      if (pickerStatus() !== "ready") return { ok: false as const, reason: pickerStatus() };
      if (input.action === "select" && normalizeEmail(requestContext.current()?.email)) {
        return { ok: false as const, reason: "upstream-identity" };
      }
      if (input.action === "select" && !people.some((person) => person.person === input.personId)) {
        return { ok: false as const, reason: "not-in-directory" };
      }
      const token = selectionCommits.issue(input);
      return { ok: true as const,
        url: `/api/v1/plugins/identity/http/commit-identity?token=${encodeURIComponent(token)}` };
    },
    identity_thread_starter: async ({ threadId: wanted }) => publicStarter(await ledger.get(wanted)),
    identity_thread_ownership: async ({ threadIds }) => ({
      threads: await Promise.all(threadIds.map((wanted) => ownership(wanted))),
    }),
    identity_machines: async () => {
      // Only the contract's fields: the cache row also carries its own `at`, and the
      // RPC output schema is strict, so spreading it whole fails validation.
      const listed = await machines();
      return publicMachineList({
        me: whoamiFor(requestContext.current()?.email ?? null).person,
        meViaFallback: currentIdentity().provenance !== "upstream-header",
        meProvenance: currentIdentity().provenance,
        roster: people.map((entry) => entry.person),
        // The chosen colours ride along, so the sidebar's badge and row tint paint the
        // override wherever there is one without a second call.
        colors: await colors.all(),
        sharedMachineUser,
        enforcement,
        machines: listed.machines,
        unavailable: listed.unavailable,
      });
    },
    identity_roster: async () => {
      const listed = await machines();
      // Fire-and-forget the ONE-SHOT catch-up sweep: it is bounded (one index read plus
      // up to 2000 gets), runs at most once ever behind a durable marker, and is NOT
      // awaited, so opening settings never waits on it. Steady state is maintained on
      // the dispatch path and costs this call one cached kv get.
      void seen.backfill(() => ledger.starterSweep(), Date.now());
      const identity = currentIdentity();
      return publicRoster({
        me: summarize(identity.person),
        meViaFallback: identity.provenance !== "upstream-header",
        people,
        overrides: await colors.all(),
        machines: listed.machines,
        seen: await seen.all(),
        unavailable: listed.unavailable,
      });
    },
    identity_set_person_color: async ({ person, color }) => {
      const written = await colors.set(person, color, people.map((entry) => entry.person));
      auditColorChange(written);
      return written;
    },
    identity_clear_person_color: async ({ person }) => {
      const written = await colors.clear(person);
      auditColorChange(written);
      return written;
    },
    identity_settings_overview: async () => {
      const { stored, ...facts } = await adminFacts();
      const lint = lintConfig(facts);
      return {
        settings: { ...stored, signingKey: signingKeyStatus },
        directory: { ok: directoryError === null, error: directoryError, people: people.length },
        firstRun: people.length === 0 && WRITABLE_KEYS.every((key) => stored[key] === WRITABLE_DEFAULTS[key]),
        accessSeen: facts.accessSeen,
        pickerStatus: facts.pickerStatus,
        selfTest,
        ledgers: await ledgerFill(),
        conflicts: facts.machines.filter((machine) => machine.conflict !== null).length,
        enforceRisks: enforceRisks(facts),
        readiness: readiness(facts, lint),
        lint,
        auditCommand: AUDIT_JQ_COMMAND,
      };
    },
    identity_update_settings: async (input) => {
      const verdict = checkSettingsPatch(input, { enforcement });
      if (!verdict.ok) return verdict;
      const current = await settings.get();
      const changes: SettingsChange[] = [];
      for (const key of WRITABLE_KEYS) {
        const to = verdict.values[key];
        if (to !== undefined && to !== current[key]) changes.push({ key, from: current[key], to });
      }
      if (changes.length === 0) return { ok: true as const, changed: [] };
      // Who asked, captured before the write: a new fallback email or picker setting
      // would otherwise re-resolve the caller as someone they were not.
      const actor = adminActor();
      try {
        await settings.experimental_set(Object.fromEntries(changes.map(({ key, to }) => [key, to])));
      } catch (error) {
        bb.log.warn(`identity: a settings write failed: ${(error as Error).message}`);
        return { ok: false as const, reason: "write-failed" };
      }
      emitAudit(auditLine, settingsChangeAuditLine({ ...actor, mode: verdict.values.enforcement ?? actor.mode, changes }));
      await reapply();
      return { ok: true as const, changed: changes.map(({ key }) => key) };
    },
    identity_rotate_signing_key: async () => {
      // Captured first: the rotation expires the very selection that names the caller.
      const actor = adminActor();
      try {
        await settings.experimental_set({ selectionSigningKey: randomBytes(32).toString("base64url") });
      } catch (error) {
        bb.log.warn(`identity: rotating the signing key failed: ${(error as Error).message}`);
        return { ok: false as const, reason: "write-failed" };
      }
      emitAudit(auditLine, settingsChangeAuditLine({ ...actor,
        changes: [{ key: "selectionSigningKey", from: "[secret]", to: "[rotated]" }] }));
      await reapply();
      return { ok: true as const };
    },
    identity_resolve_pin: async ({ hostId, action, person: wanted }) => {
      const find = async () => {
        machineCache = null;
        return (await machines()).machines.find((machine) => machine.hostId === hostId) ?? null;
      };
      const found = await find();
      if (found === null) return { ok: false as const, reason: "unknown-host" as const };
      const host = { id: found.hostId, name: found.hostName };
      const before = await pins.get(hostId);
      let to: string | null;
      if (action === "repin") {
        const person = wanted ?? personFromHostName(host.name, people)?.person;
        if (person === undefined) return { ok: false as const, reason: "no-person" as const };
        if (!people.some((entry) => entry.person === person)) return { ok: false as const, reason: "not-in-directory" as const };
        if (await pins.repin(host, person) === null) return { ok: false as const, reason: "write-failed" as const };
        to = person;
      } else {
        if (before === null) return { ok: false as const, reason: "no-pin" as const };
        const written = action === "keep" ? await pins.keep(host) !== null : await pins.unpin(hostId);
        if (!written) return { ok: false as const, reason: "write-failed" as const };
        to = action === "keep" ? before.person : null;
      }
      const machine = await find();
      emitAudit(auditLine, pinChangeAuditLine({ ...adminActor(), hostId, hostName: host.name, action,
        from: before?.person ?? null, to }));
      return { ok: true as const, machine };
    },
    identity_rerun_self_test: async () => ({ selfTest: await rerunSelfTest(), pickerStatus: pickerStatus() }),
    identity_diagnostics: async () => {
      const { stored: _stored, ...facts } = await adminFacts();
      return { text: redactDiagnostics({ ...facts, generatedAt: Date.now(), ledgers: await ledgerFill(),
        sharedMachineUser, lint: lintConfig(facts) }) };
    },
    presence_heartbeat: ({ tabId, viewerId, location }) => {
      const person = summarizePresence(currentIdentity());
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
      const person = summarizePresence(currentIdentity());
      store.setTyping(tabId, viewerId ?? `legacy:${tabId}`, threadId, active, Date.now(), person);
      publish([threadId]);
      return { ok: true } as const;
    },
    presence_snapshot: ({ excludeViewerId }) => ({ threads: store.snapshot(excludeViewerId) }),
    presence_thread: ({ threadId, excludeViewerId }) => store.thread(threadId, excludeViewerId),
    presence_typing_list: ({ threadId }) => ({ count: store.thread(threadId, "__legacy-no-viewer__").typing }),
  });
  bb.log.info("identity: loaded");
  bb.onDispose(() => {
    store.clear();
    stopObserving();
    // The rollup window is flushed lazily by the next request, so a reload would
    // otherwise lose the counters gathered since the last one.
    requestAuditor.flush();
    if (selfTestTimer !== undefined) clearTimeout(selfTestTimer);
    selfTestGeneration += 1;
    // Deliberately NOT unpatching the request context: bb disposes the old generation
    // after the new one has loaded, so restoring `emit` here would remove the live
    // patch (S7, lesson 1).
    bb.log.info("identity: disposed");
  });
}
