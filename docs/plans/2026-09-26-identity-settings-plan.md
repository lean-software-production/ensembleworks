# Identity settings: People & machines directory — implementation plan

*26 Sep 2026. Implements the recommendation in
[2026-09-26-identity-settings-design.md](2026-09-26-identity-settings-design.md)
(interactive reference: [2026-09-26-identity-settings-mockup.html](2026-09-26-identity-settings-mockup.html),
Direction 2 screens plus the pieces the recommendation takes from Directions 1 and 3).*

**Goal.** Replace today's flat "People" settings section with a People & machines
directory: an identity bar, a readiness strip, five ARIA tabs (People · Machines ·
This browser · Rules · Health), a first-run server-profile question, a guardrail
simulator and coverage map, and the Identity server code that makes the section able
to *change* things safely (settings writes, pin resolution, self-test re-run, ledger
counts, redacted diagnostics). Phase 3 (BB core APIs) is out of scope.

**Architecture.**
- *Server* (`server.ts` + new pure `settings-admin.ts`): five new RPCs on the existing
  `rpcContract`. They are `identity_settings_overview`, `identity_update_settings`,
  `identity_rotate_signing_key`, `identity_resolve_pin` and `identity_rerun_self_test`,
  plus a sixth, `identity_diagnostics`. Every write goes through
  `settings.experimental_set` (or `HostPins` for pins) and emits a `bb.log` audit line.
- *Pure logic* shared by server and browser lives in `settings-admin.ts` (lint,
  readiness, enforce risks, redaction, settings-patch validation, team-machine list
  edits, profile recommendations). Browser-only pure logic lives in `lib/`
  (precedence ladder, simulator over the real `decideGuardrail`, coverage map,
  recognised-by rows).
- *UI* lives in new files under `components/settings/`. `app.tsx` keeps the
  registration (id stays `people`) and swaps `PeopleSettings` for the new root
  component. `IdentityPicker` and `RosterPersonRow` stay exported from/inside
  `app.tsx` or move to `components/` — implementer's choice, but their accessible
  names and behaviour must not change.

**Tech.** TypeScript (strict), React 19 function components, `@get-bb/plugin-sdk`
0.4.104 (`useRpc`, `definePluginApp`), `@radix-ui/react-dialog` (already a
dependency) for confirm dialogs, zod for RPC schemas, vitest + jsdom +
`@testing-library/react` + `@get-bb/plugin-sdk/testing/app` (`loadPluginApp`,
`renderSlot`) for UI tests, `@get-bb/plugin-sdk/testing` (`createFakePluginHost`)
for server RPC tests, Playwright/Chromium (`browser/smoke.mjs`) for the responsive
browser check.

## Global constraints

Copied from the design note and the owner's standing decisions — every task obeys all
of them.

1. **Work only in** `/home/ensembleworks-agent/ensembleworks/.worktrees/identity-settings`
   on branch `bb/identity-settings-directory-thr_wmxh7wyasa`. Never touch the main
   checkout at `/home/ensembleworks-agent/ensembleworks` or any other worktree.
2. **No push, no PR, no plugin install/reload, no `bb plugin config … set`**, no
   changes to live BB settings. Commit locally only.
3. **Stage explicit paths only** (`git add plugins/identity/<file> docs/plans/<file>`).
   The sandbox creates zero-byte placeholder files (`.bashrc`, `.claude/settings.json`,
   `.mcp.json`, `.idea`, …) that show as untracked — never `git add -A`/`.` and never
   commit or delete those.
4. **The directory is managed in infrastructure** (Ansible renders `ew_bb_people`).
   The UI never edits `directory`; no RPC writes it. People are read-only apart from
   colours (existing behaviour).
5. **The signing key never leaves the server.** No RPC returns `selectionSigningKey`
   or any derivative except the status `valid | invalid | missing`.
6. **Trust model is unchanged:** "a guardrail against mistakes, not a lock". Any caller
   may write (same as colours today, and the generated settings form is equally open);
   every successful write emits exactly one audit line through `bb.log` naming who
   (person, email, provenance), what changed, from → to. Audit/settings/pin lines are
   NOT gated on `enforcement` (same reasoning as `colorChangeAuditLine`).
7. **Precedence is fixed:** Access header → valid browser selection → `fallbackEmail`
   → anonymous; a stale/expired/invalid selection becomes anonymous and never falls
   through to the fallback. Only an Access identity can be refused by the guardrail.
   No copy may imply otherwise.
8. **`audit` and `enforce` compute the same `decideGuardrail` verdict.** The simulator
   must call the real `decideGuardrail` from `guardrail.ts` — never a re-implementation.
9. **No in-UI audit evidence.** The owner's 18 Sep decision stands: no log viewer, no
   counts of would-refuse. Ship the copyable `jq` command instead.
10. **Safeguards** (design note §Safeguards): every destructive or trust-changing
    action opens a confirm dialog with **Cancel focused**, names its consequence, and
    returns focus to the element that opened it. Enforce needs an acknowledgement
    checkbox and names who would be refused; cancelling leaves the mode unchanged.
    Rotate key needs the typed word `rotate`. A non-empty fallback email needs the
    "Only one person uses this server" checkbox. Re-pin / remove-team spell out the
    rule A / rule C consequence.
11. **Accessibility:** status is always icon + text, never colour alone; tabs follow the
    WAI-ARIA tabs pattern (roving tabindex, ←/→/Home/End); every interactive target is
    ≥ 40px tall (44px for touch-primary controls such as the picker's); visible
    `:focus-visible` outlines using `var(--ring, #2563eb)`; `prefers-reduced-motion`
    respected (no animation is required at all).
12. **No remote resources** (scripts, fonts, images). Styles go in `identity.css` under
    an `.identity-settings` prefix using BB's CSS variables (`--border`,
    `--background`, `--foreground`, `--muted-foreground`, `--destructive`, `--ring`).
    Inline `style={{…}}` is acceptable where `app.tsx` already uses it.
13. **Responsive:** the section must not overflow horizontally at 320px, 390px or
    1280px. Tables become labelled cards below a 720px container width (use a CSS
    container query on `.identity-settings`, falling back to a media query).
14. **Keep existing behaviour green:** every existing test keeps passing. The only
    permitted edit to an existing test is in `identity-picker.test.tsx`'s `mount`
    helper (add the new RPC stubs and select the **This browser** tab); its four
    assertions stay byte-for-byte.
15. **TDD:** write each new test first, run it, see it fail for the right reason, then
    implement. Commit at the end of each task with the message given.
16. New top-level `.ts` files in `plugins/identity/` must be added to
    `tsconfig.json`'s `include` list (`components/` and `lib/` are already included).

## Verification

- **Gate** (run from `plugins/identity/`, all must pass):
  `npm run typecheck && npm test && bb plugin build .`
- **Smoke:** `IDENTITY_SCREENSHOTS="$PWD/.local/identity-screens" npm run test:browser`
  (from Task 5 on it includes the settings-section checks; `.local/` is gitignored).
  If Chromium cannot launch in the worker's environment, record the exact error in the
  review file and treat the smoke as *blocked*, not passed.

---

## Task 1: Server admin API — settings writes, pins, self-test, ledgers, diagnostics

**Files**
- Create `plugins/identity/settings-admin.ts`, `plugins/identity/settings-admin.test.ts`
- Modify `plugins/identity/hosts.ts`, `plugins/identity/hosts.test.ts`
- Modify `plugins/identity/attribution.ts`, `plugins/identity/attribution.test.ts`
- Modify `plugins/identity/queued-requester.ts`, `plugins/identity/queued-requester.test.ts`
- Modify `plugins/identity/audit.ts`, `plugins/identity/audit.test.ts`
- Modify `plugins/identity/server.ts`; create `plugins/identity/settings-rpc.test.ts`
- Modify `plugins/identity/tsconfig.json` (add `settings-admin.ts`)

**Consumes:** existing `parseDirectory`, `Person` (people.ts); `HostPins`,
`classifyHost`, `personFromHostName`, `parseTeamMachines`, `HostClassification`
(hosts.ts); `ENFORCEMENT_MODES`, `EnforcementMode`, `formatAuditLine`, `emitAudit`,
`AUDIT_SCHEMA_VERSION` (audit.ts); `SelfTestResult`, `SELF_TEST_EMAIL`,
`selfTestRequestContext` (request-context.ts); `MAX_STARTER_RECORDS`
(attribution.ts); `MAX_QUEUED_REQUESTERS` (queued-requester.ts).

**Produces** (exact names later tasks use):

```ts
// settings-admin.ts — browser-safe: imports only zod, and `import type` from other modules,
// plus value imports from hosts.ts/audit.ts ONLY if those stay free of node: imports
// (hosts.ts and audit.ts are browser-safe today; keep them so).
export const SETTINGS_TABS = ["people", "machines", "browser", "rules", "health"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
export const PICKER_STATUSES = ["off", "origin-not-configured", "signing-key-unavailable",
  "cookie-bridge-unavailable", "ready"] as const;
export type PickerStatus = (typeof PICKER_STATUSES)[number];
export type SigningKeyStatus = "valid" | "invalid" | "missing";

/** The one origin rule, moved out of server.ts's applySettings so UI and server agree.
 *  https any host, or http only on localhost / 127.0.0.1 / [::1]; must equal its own
 *  URL.origin exactly (no path, no trailing slash). Returns the origin or null. */
export function validateSelectionOrigin(value: string): string | null;

export const settingsPatchSchema: z.ZodType<SettingsPatch>; // strict object, all optional:
export type SettingsPatch = {
  teamMachines?: string;            // ≤ 10_000 chars
  sharedMachineUser?: string;       // ≤ 64 chars
  enforcement?: EnforcementMode;
  fallbackEmail?: string;           // ≤ 320 chars
  selfSelectedIdentity?: boolean;
  selectionPublicOrigin?: string;   // ≤ 2048 chars
  acknowledgeEnforce?: boolean;     // required true to move INTO "enforce"
  confirmSoleUser?: boolean;        // required true to set a NON-EMPTY fallbackEmail
};
export type WritableSettings = Required<Omit<SettingsPatch, "acknowledgeEnforce" | "confirmSoleUser">>;
export type PatchVerdict =
  | { ok: true; values: Partial<WritableSettings> }
  | { ok: false; reason: "empty-patch" | "enforce-needs-acknowledgement" | "fallback-needs-sole-user"
      | "fallback-not-an-email" | "origin-invalid" | "shared-user-invalid" };
/** Validates business rules; strips the two confirmation flags from `values`;
 *  trims string values; `selectionPublicOrigin: ""` (clearing) is allowed. */
export function checkSettingsPatch(patch: SettingsPatch, current: { enforcement: EnforcementMode }): PatchVerdict;

/** teamMachines text edits. Output is newline-joined, de-duplicated case-insensitively,
 *  original order kept, via parseTeamMachines. */
export function addTeamMachine(text: string, name: string): string;
export function removeTeamMachine(text: string, name: string): string;

export type LintSeverity = "error" | "warning" | "info";
export type LintIssue = { id: string; severity: LintSeverity; message: string; fix: string };
export type AdminFacts = {
  directoryError: string | null;
  people: readonly Person[];
  teamMachines: readonly string[];
  machines: readonly HostClassification[];   // classified host list
  machinesUnavailable: string | null;
  enforcement: EnforcementMode;
  fallbackEmail: string;
  selfSelectedIdentity: boolean;
  selectionPublicOrigin: string;             // RAW stored value
  signingKey: SigningKeyStatus;
  pickerStatus: PickerStatus;
  selfTest: SelfTestResult | null;
  accessSeen: boolean;
};
export function lintConfig(facts: AdminFacts): LintIssue[];

export type ReadinessId = "profile" | "people" | "machines" | "browser" | "guardrail" | "check";
export type ReadinessStatus = "ok" | "attention" | "off" | "problem";
export type ReadinessItem = { id: ReadinessId; label: string; status: ReadinessStatus; text: string; tab: SettingsTab | "profile" };
export function readiness(facts: AdminFacts, lint: readonly LintIssue[]): ReadinessItem[];

/** Sentences naming who/what Enforce would refuse, predictable from machine state alone. */
export function enforceRisks(facts: Pick<AdminFacts, "people" | "teamMachines" | "machines">): string[];

export function redactEmail(email: string): string;       // "alex@example.com" -> "a***@example.com"; no "@" -> "***"; "" -> ""
export type DiagnosticsInput = AdminFacts & {
  generatedAt: number;
  ledgers: LedgerFill;
  sharedMachineUser: string;
  lint: readonly LintIssue[];
};
export type LedgerFill = { starters: { count: number | null; max: number }; queued: { count: number | null; max: number } };
export function redactDiagnostics(input: DiagnosticsInput): string; // pretty JSON, 2-space indent

export const AUDIT_JQ_COMMAND: string;

export const SERVER_PROFILES = ["access", "direct", "solo"] as const;
export type ServerProfile = (typeof SERVER_PROFILES)[number];
export type ProfileChange = { setting: keyof WritableSettings; label: string; now: string; recommended: string };
export type ProfileRecommendation = { changes: ProfileChange[]; patch: SettingsPatch; notes: string[] };
export function profileRecommendation(
  profile: ServerProfile,
  current: WritableSettings,
  context: { myEmail: string | null; browserOrigin: string | null },
): ProfileRecommendation;
```

```ts
// hosts.ts additions
// hostPinSchema gains one OPTIONAL field (old records still parse):
//   keptName: z.string().optional()   // host name an operator chose to keep the pin under
// classifyHost: conflict is null when pin.keptName !== undefined && pin.keptName === host.name
// HostPins.observe: never records a conflict for a host whose pin.keptName === host.name
export class HostPins {
  keep(host: HostRef): Promise<HostPin | null>;                          // needs an existing pin; writes {...pin, keptName: host.name}
  repin(host: HostRef, person: string, now?: number): Promise<HostPin | null>; // person must be in the directory; writes {hostId, person, name: host.name, pinnedAt: now}; no keptName
  unpin(hostId: string): Promise<boolean>;                               // kv.delete; cache -> null; next observe re-derives from the name
}
// all three: time-bounded via withTimeout, never throw, clear this host's entry in conflicts()

// attribution.ts
class AttributionLedger { count(): Promise<number | null>; } // ONE index read; null on timeout/error. Never calls get() per record.
// queued-requester.ts
class QueuedRequesterLedger { count(): Promise<number | null>; } // ONE index read; null on timeout/error.

// audit.ts
export function settingsChangeAuditLine(input: SettingsChangeAuditInput): AuditLine; // kind "settings.change"
export function pinChangeAuditLine(input: PinChangeAuditInput): AuditLine;           // kind "host.pin"
// Both carry v, kind, at, req, method, path, mode, by, byEmail, byProvenance, like colorChangeAuditLine.
// settings.change adds: changes: Array<{ key: string; from: string | boolean; to: string | boolean }>
//   (selectionSigningKey is ALWAYS written as { key: "selectionSigningKey", from: "[secret]", to: "[rotated]" }).
// host.pin adds: hostId, hostName, action ("keep" | "repin" | "unpin"), from (person | null), to (person | null).
```

```ts
// server.ts — rpcContract additions (zod, all .strict())
identity_settings_overview: { input: none, output: settingsOverview }
// settingsOverview = {
//   settings: { teamMachines: string; sharedMachineUser: string; enforcement: EnforcementMode;
//               fallbackEmail: string; selfSelectedIdentity: boolean; selectionPublicOrigin: string;
//               signingKey: SigningKeyStatus };
//   directory: { ok: boolean; error: string | null; people: number };
//   firstRun: boolean;           // people.length === 0 && every writable setting at its default
//   accessSeen: boolean;         // current request OR any request since load carried the Access header
//                                // (the self-test's SELF_TEST_EMAIL never counts)
//   pickerStatus: PickerStatus;
//   selfTest: SelfTestResult | null;
//   ledgers: LedgerFill;         // max = MAX_STARTER_RECORDS / MAX_QUEUED_REQUESTERS
//   conflicts: number;           // machines whose classification carries a conflict
//   enforceRisks: string[];
//   readiness: ReadinessItem[];  // exactly six, in the order profile, people, machines, browser, guardrail, check
//   lint: LintIssue[];
//   auditCommand: string;        // === AUDIT_JQ_COMMAND
// }
identity_update_settings: { input: settingsPatchSchema, output: { ok: true; changed: string[] } | { ok: false; reason: string } }
identity_rotate_signing_key: { input: { confirm: "rotate" }, output: { ok: true } | { ok: false; reason: string } }
identity_resolve_pin: { input: { hostId: string(1..200); action: "keep" | "repin" | "unpin"; person?: string(1..200) },
                        output: { ok: true; machine: HostClassification | null } | { ok: false; reason: "unknown-host" | "no-pin" | "not-in-directory" | "no-person" | "write-failed" } }
identity_rerun_self_test: { input: none, output: { selfTest: SelfTestResult; pickerStatus: PickerStatus } }
identity_diagnostics: { input: none, output: { text: string } }
export type SettingsOverview = z.infer<typeof settingsOverview>;
export type SettingsWriteAnswer = z.infer<typeof settingsWrite>;
export type PinResolution = z.infer<typeof pinResolution>;
```

**Behaviour details (server.ts)**
- `applySettings` uses `validateSelectionOrigin` (delete the inline copy) and sets
  `machineCache = null` so a teamMachines change reclassifies immediately. It records
  `directoryError` (parse error text, or null) for the overview.
- In the `requestContext.observe` callback, **before** the `if (!auditing()) return;`,
  set `accessSeen = true` when `facts.email` is non-null and `!== SELF_TEST_EMAIL`.
- `identity_update_settings`: `checkSettingsPatch(input, { enforcement })`; on `ok`,
  compute the keys whose value actually differs from `await settings.get()`; if none,
  return `{ ok: true, changed: [] }` without writing or logging; otherwise
  `await settings.experimental_set(changedValues)`, then
  `applySettings(await settings.get(), false)` (don't rely on `onChange` timing), then
  one `settings.change` audit line, then `{ ok: true, changed }`. It never accepts
  `directory` or `selectionSigningKey` (the strict schema rejects them).
- `identity_rotate_signing_key`: writes `randomBytes(32).toString("base64url")`
  through `experimental_set`, re-applies, logs `settings.change` with the redacted
  pair, returns `{ ok: true }`.
- `identity_resolve_pin`: find the host by id in `(await machines()).machines` (a
  fresh read — set `machineCache = null` first). Unknown → `unknown-host`. `keep`
  without a pin → `no-pin`. `repin` with no `person` uses `personFromHostName(name)`
  (none → `no-person`); a `person` not in the directory → `not-in-directory`. After a
  write: `machineCache = null`, re-list, return the host's new classification, emit
  one `host.pin` audit line. A pin write that fails → `write-failed`.
- `identity_rerun_self_test`: clear any pending retry timer, run
  `selfTestRequestContext` once (coalesce concurrent calls onto one promise), store it
  in `selfTest`, log exactly as `runSelfTest` does, return it with `pickerStatus()`.
- `identity_diagnostics`: `{ text: redactDiagnostics({...facts, generatedAt: Date.now(), ledgers, sharedMachineUser, lint}) }`.

**Pure-logic rules (settings-admin.ts)** — implement exactly:
- `lintConfig` issue ids (only emit when the condition holds):
  `directory-invalid` (error) ·
  `directory-duplicate-email` (warning, one per email that two people share, names both) ·
  `team-machine-missing` (warning, a teamMachines name not in the host list; skipped when
  `machinesUnavailable`) · `team-machine-named-for-person` (warning, a teamMachines name
  whose suffix names a directory person — teamMachines wins, so that person's box counts
  as team) · `fallback-on-shared` (warning, fallbackEmail set and (`accessSeen` or
  `people.length > 1`)) · `picker-origin` (error, picker on and origin invalid/empty) ·
  `picker-signing-key` (error, picker on and key not `valid`) · `picker-cookie`
  (warning, picker on and `pickerStatus === "cookie-bridge-unavailable"`) ·
  `self-test-failed` (error, `selfTest?.ok === false`) · `enforcement-no-team-machines`
  (warning, enforcement ≠ off and teamMachines empty: "every automation would be
  refused") · `pin-conflicts` (warning, ≥1 conflict) · `machines-unavailable` (warning)
  · `unclaimed-machines` (info, ≥1 unclaimed host). Each `fix` is one imperative
  sentence naming where to fix it (tab name or `ew_bb_people`).
- `readiness` (exact order and rules):
  - profile → `accessSeen`: ok "Cloudflare Access" · else fallbackEmail: ok "Only me" ·
    else picker on: ok "Direct (browser names)" · else attention "Not chosen"; tab `profile`.
  - people → directoryError: problem "Directory invalid" · 0 people: attention "Nobody
    registered" · else ok "`N` people"; tab `people`.
  - machines → unavailable: problem "List unavailable" · conflicts: attention "`N`
    conflict(s)" · no team machine: attention "No team machine" · else ok "`N`
    machines"; tab `machines`.
  - browser → pickerStatus `off`: off "Off" · `ready`: ok "Ready" · else problem with
    the human label ("Origin not configured", "Signing key unavailable", "Cookie bridge
    unavailable"); tab `browser`.
  - guardrail → off: off "Off" · audit: ok "Audit — logging only" · enforce: ok
    "Enforcing"; problem "Enforcing without a working self-test" when enforce and
    `selfTest?.ok !== true`; tab `rules`.
  - check → `selfTest === null`: attention "Not run yet" · any error lint: problem
    "`N` problem(s)" · any warning: attention "`N` warning(s)" · else ok "All checks
    pass"; tab `health`.
- `enforceRisks`: (a) teamMachines empty → "Every automation would be refused: no team
  machine is configured (rule C)." (b) for each `person` machine with a conflict:
  "`<currentName>` is pinned to `<pinnedPerson>`, but its name now says
  `<derived displayName | "nobody">`: `<derived displayName>` starting a thread there
  would be refused (rule A)." (drop the second clause when derived is nobody).
  (c) for each teamMachines name also matching a person's suffix → no risk (team).
  Returns `[]` when nothing is predictable.
- `redactDiagnostics` output keys, in order: `generatedAt` (ISO string), `plugin`
  ("identity"), `schema` (1), `selfTest`, `picker` ({ status, enabled, origin,
  signingKey }), `enforcement`, `sharedMachineUser`, `fallbackEmail` (redacted),
  `accessSeen`, `directory` ({ ok, error, people: count, emails: count }),
  `teamMachines` (names), `machines` ({ total, person, team, unclaimed, conflicts,
  unavailable }), `ledgers`, `lint` ([{ id, severity }]). **No** email in clear, **no**
  person display names, **no** signing key. A test asserts that none of the fixture's
  emails, display names or key appear in the output.
- `AUDIT_JQ_COMMAND` is exactly:
  `bb plugin logs identity | sed -n 's/.*identity-audit //p' | jq -c 'select(.kind == "dispatch" and .verdict == "reject") | {at, mode, rule, person, host: .host.name, action}'`
- `profileRecommendation`:
  - `access` → `{ selfSelectedIdentity: false, fallbackEmail: "", enforcement: current.enforcement === "off" ? "audit" : current.enforcement }`; note "Access supplies identities; start in audit and read the log before enforcing."
  - `direct` → `{ selfSelectedIdentity: true, fallbackEmail: "", enforcement: "off" }`
    plus `selectionPublicOrigin: browserOrigin` when current origin is invalid and
    `validateSelectionOrigin(browserOrigin)` accepts it (else a note "Set the public
    origin in This browser"); note "Without Access nobody can be refused — browser
    names are labels only."
  - `solo` → `{ fallbackEmail: myEmail ?? "", selfSelectedIdentity: false, enforcement: "off", confirmSoleUser: true }`; note "Every header-less caller, agents included, will be attributed to this email."
  - `changes` lists only settings whose recommended value differs from `current`.

**Steps**
- [ ] Write `settings-admin.test.ts` covering: origin rule table (https host ✓, http
      localhost/127.0.0.1/[::1] ✓, http other ✗, trailing slash ✗, path ✗, garbage ✗);
      every `checkSettingsPatch` reason; add/removeTeamMachine (dedupe, case, order,
      JSON-array input); each lint id firing and not firing; the six readiness items in
      order for a healthy fixture and for a broken one; enforceRisks (a) and (b);
      redactEmail; redactDiagnostics leaks nothing (assert with `not.toContain` for
      every fixture email/displayName/key); profileRecommendation for all three
      profiles including "changes lists only differences". Run → fails (module missing).
- [ ] Implement `settings-admin.ts`; add it to `tsconfig.json` include. Run → passes.
- [ ] Extend `hosts.test.ts`: `keptName` suppresses the conflict only while the name
      still equals it (a later rename re-raises it); old pin records without `keptName`
      still parse; `keep` without a pin → null; `repin` to a non-directory person →
      null; `unpin` then `observe` re-derives from the name; all three clear
      `conflicts()` for the host and never throw when kv rejects or times out. Run →
      fail; implement; pass.
- [ ] Extend `attribution.test.ts` and `queued-requester.test.ts` with `count()`:
      reads the index once (spy on `kv.get` — exactly one call), returns length, `null`
      on timeout/throw. Run → fail; implement; pass.
- [ ] Extend `audit.test.ts` for `settingsChangeAuditLine` / `pinChangeAuditLine`
      shapes, including the signing-key redaction. Run → fail; implement; pass.
- [ ] Write `settings-rpc.test.ts` driving the real plugin factory with
      `createFakePluginHost({ settings: {...} })` from `@get-bb/plugin-sdk/testing`
      (stub `globalThis.fetch` with `vi.stubGlobal` so `/api/v1/hosts` returns a fixture
      host list and the probe route fails fast; dispose the host in `afterEach`; use fake
      timers or dispose to stop the self-test retry timer). Cover: overview shape and
      that it never contains the key; update refuses enforce without acknowledgement and
      a fallback without sole-user; a successful update writes, re-applies (a following
      `identity_machines` reflects new teamMachines) and logs exactly one
      `settings.change` line (inspect `harness.logEntries`, which records every
      `bb.log` line in order; the fake host implements `settings.experimental_set`); an update that
      changes nothing writes nothing and logs nothing; rotate changes the stored key and
      logs `[rotated]` without the key; `directory` / `selectionSigningKey` in the patch
      are rejected by the schema; resolve_pin keep/repin/unpin happy paths and each
      failure reason, each successful action logging one `host.pin` line;
      rerun_self_test returns a result; diagnostics text contains no email. Run → fail.
- [ ] Implement the RPCs and server changes. Run the whole gate
      (`npm run typecheck && npm test && bb plugin build .`) → passes.
- [ ] Commit: `feat(identity): settings admin API — writes, pins, self-test, diagnostics`

**Deliverable:** all new RPCs callable and covered by tests; no UI change yet.

---

## Task 2: Settings shell — identity bar, readiness strip, tabs, People, first run

**Files**
- Create `plugins/identity/components/settings/IdentitySettings.tsx` (section root)
- Create `plugins/identity/components/settings/IdentityBar.tsx`,
  `ReadinessStrip.tsx`, `SettingsTabs.tsx`, `PeopleTab.tsx`, `ProfilePanel.tsx`,
  `ConfirmDialog.tsx`, `StatusBadge.tsx`
- Create `plugins/identity/lib/recognised-by.ts`, `plugins/identity/lib/recognised-by.test.ts`
- Create `plugins/identity/settings-shell.test.tsx`
- Modify `plugins/identity/app.tsx` (register the new root; keep id `people`, title
  "People & machines", description "Who and what Identity recognises, why, and what it
  does about it.")
- Modify `plugins/identity/identity.css`
- Modify `plugins/identity/identity-picker.test.tsx` — **only** its `mount` helper, per
  Global constraint 14 (select the "This browser" tab once Task 3 moves the picker; in
  this task the picker may still render on the People tab — whichever keeps the four
  assertions passing unchanged).

**Consumes:** Task 1's `SettingsOverview`, `ReadinessItem`, `SettingsTab`,
`profileRecommendation`, `ServerProfile`, `SERVER_PROFILES`, `redactEmail`; existing
`RosterAnswer`, `WhoAmI`, `MachineList`, `ColorWriteAnswer`, `RosterPersonRow`,
`IdentityPicker`, `SEEN_UNKNOWN_CAVEAT`.

**Produces:**
```ts
// components/settings/IdentitySettings.tsx
export function IdentitySettings(): JSX.Element; // the settingsSection component
export type SettingsData = {
  overview: SettingsOverview | null; roster: RosterAnswer | null; whoami: WhoAmI | null; machines: MachineList | null;
  errors: Partial<Record<"overview" | "roster" | "whoami" | "machines", string>>;
  reload: () => void;   // re-fetches all four
};
export function useSettingsData(): SettingsData; // four RPCs in parallel; each failure is isolated (a failed
                                                 // overview still renders people, etc.)
// components/settings/SettingsTabs.tsx
export function SettingsTabs(props: { selected: SettingsTab; onSelect: (tab: SettingsTab) => void;
  panels: Record<SettingsTab, ReactNode>; badges?: Partial<Record<SettingsTab, ReactNode>> }): JSX.Element;
export const TAB_LABELS: Record<SettingsTab, string>; // People, Machines, This browser, Rules, Health
// components/settings/ConfirmDialog.tsx
export function ConfirmDialog(props: {
  open: boolean; title: string; consequence: ReactNode; confirmLabel: string; destructive?: boolean;
  gate?: { kind: "checkbox"; label: string } | { kind: "typed"; word: string; label: string };
  busy?: boolean; onConfirm: () => void; onCancel: () => void; children?: ReactNode;
}): JSX.Element;   // Radix Dialog; Cancel focused on open (onOpenAutoFocus); confirm disabled until the gate is met;
                   // Escape/overlay = cancel; focus returns to the opener (Radix default — keep it).
// components/settings/StatusBadge.tsx
export function StatusBadge(props: { status: ReadinessStatus | LintSeverity; text: string }): JSX.Element; // icon + text
// lib/recognised-by.ts
export type RecognisedByRow = { signal: string; from: string; countsFor: string };
export function recognisedBy(row: RosterAnswer["people"][number], context: {
  machines: readonly HostClassification[]; teamMachines: readonly string[]; pickerOn: boolean }): RecognisedByRow[];
```

**UI specification** (mockup Direction 2 screens `#d-people`, identity bar, plus the
Direction 1 readiness rail condensed to a strip):
- **Identity bar** (`role="status"` is NOT used — it's static text): "You: {displayName
  | email | Anonymous} · {provenance phrase} · counts for {…}" then the trust sentence
  "Identity is a guardrail against mistakes, not a lock." Phrases:
  upstream-header → "from your Access email, read as-is" · counts for "attribution and
  the guardrail"; self-selected → "from the name this browser chose" · "attribution
  only — never the guardrail"; configured-fallback → "from the Fallback email setting"
  · "attribution only — never the guardrail"; unknown → "anonymous" · "nothing is
  refused for anonymous requests".
- **Readiness strip**: an `<ol aria-label="Identity readiness">` of six items; each is a
  button (≥ 40px) reading "{label}: {text}" with a `StatusBadge`; activating one selects
  its tab (profile → opens `ProfilePanel`). Wraps on narrow widths; never scrolls the
  page horizontally.
- **Tabs**: WAI-ARIA tabs (`role="tablist"` with `aria-label="Identity settings"`,
  `role="tab"` + `aria-selected` + `aria-controls`, `role="tabpanel"` +
  `aria-labelledby`, roving tabindex, ←/→ wrap, Home/End). Default tab: People.
  Tasks 3–4 fill Machines/This browser/Rules/Health; in this task they render a
  one-line placeholder each ("Coming in this change set" is NOT acceptable copy — use
  the real panel title and a short description of what it will show).
- **Directory-error takeover**: when `overview.directory.ok === false`, the People panel
  shows an alert (`role="alert"`) "The People directory setting is invalid: {error}.
  Everyone is anonymous and nothing is refused until it is fixed." with both fixes:
  "Fix `ew_bb_people` in infrastructure and redeploy" and the CLI line
  `bb plugin config identity set directory '<json>'` in a `<code>`. The readiness
  strip shows People as problem.
- **People tab**: the existing roster rows (`RosterPersonRow`, unchanged colour
  behaviour, clash warnings, "Reset to dealt") inside a master-detail layout: a list of
  people (name + colour dot + "seen" phrase) and a detail pane for the selected person
  with a "Recognised by" table (columns: Signal · From · Counts for) from
  `recognisedBy`, their colour control, their machines, and a "Copy directory entry"
  button that copies `JSON.stringify({ person, github, displayName, emails }, null, 2)`
  (clipboard failure → show the JSON in a `<pre>` with "Copy it from here"). A static
  notice: "People are managed in infrastructure (`ew_bb_people`). Colours are
  Identity's own and anyone can change them; every change is logged." Keep
  `SEEN_UNKNOWN_CAVEAT` and the "Machines are not listed: …" line. Empty directory →
  "Nobody is registered yet. Identity reads its people from the directory setting
  above, which infrastructure manages." Below 720px container width, master-detail
  stacks.
- `recognisedBy` rows: one per email → { signal: email, from: "Access email",
  countsFor: "attribution and the guardrail" }; when `pickerOn` → { signal: "Browser
  name", from: "This browser's picker", countsFor: "attribution only" }; one per
  machine classified as this person → { signal: hostName, from: "pin" | "name suffix"
  (pin when the classification came from a pin — treat a machine as pinned when the
  roster lists it and its name suffix does not name this person, else "name suffix"),
  countsFor: "machine owner (rule A)" }.
- **First-run ProfilePanel**: shown above the tabs when `overview.firstRun` is true, or
  when the Profile readiness item is activated (then with a Close button). Question
  "How do people reach this BB server?" as a radiogroup of three options: "Cloudflare
  Access" (append " — detected" when `overview.accessSeen`), "Direct, without Access",
  "Only me". Choosing one renders a "Now → Recommended" table from
  `profileRecommendation(profile, overview.settings-as-WritableSettings, { myEmail:
  whoami.email, browserOrigin: window.location.origin })` plus its notes. Nothing is
  written until **Apply**. For `solo`, an email input (prefilled with `myEmail`) and the
  checkbox "Only one person uses this server" must be ticked before Apply enables.
  Apply → `identity_update_settings(patch)`; on `ok:false` show the reason as a
  sentence; on success `reload()` and close.
- **Loading/error**: nothing renders until the first roster/overview answer (as today);
  per-RPC failures show one muted sentence each, never a blank section.

**Steps**
- [ ] Write `lib/recognised-by.test.ts` (emails, picker on/off, pinned vs suffix
      machines). Run → fail. Implement. Pass.
- [ ] Write `settings-shell.test.tsx` using `loadPluginApp` + `renderSlot(section,
      {}, { rpc: {...} })` with fixture answers for `identity_settings_overview`,
      `identity_roster`, `identity_whoami`, `identity_machines`,
      `identity_update_settings`, `identity_set_person_color`,
      `identity_clear_person_color`, `identity_prepare_selection`. Cover: section id
      `people` and title "People & machines"; identity bar phrase for each provenance;
      six readiness items in order with icon+text; activating "Machines" readiness item
      selects the Machines tab; ARIA tabs keyboard (ArrowRight, ArrowLeft wrap,
      Home/End, `aria-selected`, only the selected tab has `tabIndex=0`); People
      master-detail shows "Recognised by" rows and "Copy directory entry" (stub
      `navigator.clipboard.writeText`); colour change still calls
      `identity_set_person_color`; directory-error takeover text and CLI fix; first-run
      panel appears only when `firstRun`, Apply disabled until a choice (and for Only
      me until the sole-user checkbox), Apply sends exactly the recommended patch; a
      failing overview RPC still renders the People list. Run → fail.
- [ ] Implement the components, CSS and registration. Update
      `identity-picker.test.tsx`'s `mount` helper only as allowed. Run the gate → pass.
- [ ] Commit: `feat(identity): People & machines settings shell with readiness and first run`

**Deliverable:** the new section renders with a working People tab, readiness strip,
identity bar and first-run question; the other four tabs are titled placeholders.

---

## Task 3: This browser and Machines tabs

**Files**
- Create `plugins/identity/components/settings/BrowserTab.tsx`, `MachinesTab.tsx`
- Create `plugins/identity/lib/precedence.ts`, `plugins/identity/lib/precedence.test.ts`
- Create `plugins/identity/browser-machines-tabs.test.tsx`
- Modify `components/settings/IdentitySettings.tsx`, `identity.css`,
  `identity-picker.test.tsx` (`mount` helper only)

**Consumes:** Task 1 RPCs (`identity_update_settings`, `identity_rotate_signing_key`,
`identity_resolve_pin`), `validateSelectionOrigin`, `addTeamMachine`,
`removeTeamMachine`, `PickerStatus`; Task 2 `ConfirmDialog`, `StatusBadge`,
`SettingsData`; existing `IdentityPicker`, `MachineList`, `HostClassification`.

**Produces:**
```ts
// lib/precedence.ts
export type RungId = "access" | "selection" | "fallback" | "anonymous";
export type RungState = "decided" | "skipped" | "not-reached";
export type Rung = { id: RungId; label: string; state: RungState; detail: string };
export function precedenceLadder(whoami: WhoAmI, context: { fallbackConfigured: boolean }): Rung[];
// exactly four rungs in order; exactly one "decided"; rungs above it "skipped", below "not-reached".
// A selection whose status is stale | expired | invalid decides ANONYMOUS (not the fallback) and the
// selection rung's detail says so: "This browser's choice is {status}; Identity treats you as
// anonymous rather than falling back." "overridden" = Access decided, selection rung skipped with
// detail "Your Access email outranks this browser's choice."
export const PICKER_CHAIN: ReadonlyArray<{ status: PickerStatus; label: string; fix: string }>;
```

**This browser tab** (mockup `#d-browser`, Direction 1 ladder):
- "Why am I shown as …?" — the precedence ladder as an `<ol>`, each rung with
  `StatusBadge`-style icon + text and a "you are here" marker (`aria-current="step"`)
  on the decided rung.
- The existing `IdentityPicker` (unchanged; "Your name" combobox, "Use this name",
  Switch/Forget) with its disclaimer.
- **Picker settings**: toggle "Let browsers choose a name (attribution only)"
  (`selfSelectedIdentity`), the public-origin text input validated live with
  `validateSelectionOrigin` (invalid → inline error, Save disabled), and the readiness
  chain `PICKER_CHAIN` rendered as an `<ol>` marking the current `pickerStatus` step.
- **Fallback email**: input + Save. Saving a non-empty value opens `ConfirmDialog`
  (title "Set a fallback email?", checkbox gate "Only one person uses this server";
  consequence: "Every request without an Access email — agents and the CLI included —
  will be attributed to {redactEmail(value)}. The guardrail never refuses on it.";
  when `overview.accessSeen` or `people > 1`, add "This server looks shared."). Clearing
  it needs no dialog. Sends `{ fallbackEmail, confirmSoleUser: true }`.
- **Rotate signing key**: button opens `ConfirmDialog` (destructive; typed gate
  `rotate`; consequence "Every browser's chosen name expires at once. How many browsers
  that affects cannot be known."). Calls `identity_rotate_signing_key({ confirm:
  "rotate" })`. Shows key status (`valid | invalid | missing`) — never the key.

**Machines tab** (mockup `#d-machines`):
- A filter (`<input type="search">` labelled "Filter machines") and a table: Machine ·
  Kind (Person/Team/Unclaimed, icon + text) · Owner / from (e.g. "Alex · pin", "Team ·
  teamMachines", "— · unclaimed") · Status (conflict text when present) · Actions.
  Below 720px container width each row is a labelled card (`<dl>`).
- Problem rows first: conflicts, then teamMachines names missing from the host list
  (a synthetic row "listed in teamMachines but not seen" with a "Remove from team"
  action), then unclaimed, then the rest alphabetically.
- Row actions (each confirmed with `ConfirmDialog`, Cancel focused):
  - conflict row: **Keep pin** (`keep`; consequence "`{host}` stays {pinned
    person}'s machine even though its name says {derived}."), **Re-pin to {derived}**
    (`repin`; consequence "{pinned person} starting a thread on `{host}` would be
    refused (rule A) once enforcing."), **Unpin** (`unpin`; consequence "Identity
    re-derives the owner from the name on next sight.").
  - person/unclaimed row: **Make team machine** (update `teamMachines` with
    `addTeamMachine`; consequence "Anyone may start threads here and automations may
    run here.").
  - team row: **Remove from team** (`removeTeamMachine`; consequence "Automations
    headed for `{host}` would be refused (rule C) once enforcing.").
- An "Add a team machine by name" input + Add (no dialog — additive and reversible).
- "Shared machine user" input + Save (display only; shows the account team machines run
  as).
- After any write: `reload()`; an `ok:false` answer renders as a sentence next to the
  row. While a write is in flight the row's buttons are disabled.
- Empty host list → "Identity sees no machines yet." `machines.unavailable` → the reason.

**Steps**
- [ ] Write `lib/precedence.test.ts`: one test per decided rung, each non-valid
      selection status deciding anonymous even with a fallback configured,
      "overridden". Run → fail. Implement. Pass.
- [ ] Write `browser-machines-tabs.test.tsx` (same harness as Task 2, spy RPC stubs):
      ladder marks the decided rung with `aria-current="step"`; picker still labelled
      "Your name"; invalid origin disables Save and shows the error; valid origin sends
      `{ selectionPublicOrigin }`; fallback save opens the dialog with Cancel focused,
      confirm disabled until the checkbox is ticked, then sends `confirmSoleUser:
      true`; Escape cancels without calling the RPC; rotate needs the typed word and
      never renders a key; Machines conflict row first with Keep/Re-pin/Unpin each
      sending the right `identity_resolve_pin` input after confirmation; Make team /
      Remove from team send the recomputed `teamMachines` text; missing team machine
      row; filter narrows rows; `ok:false` reason rendered. Run → fail.
- [ ] Implement. Move the picker off the People tab; update `identity-picker.test.tsx`'s
      `mount` helper to select "This browser" (assertions unchanged). Gate → pass.
- [ ] Commit: `feat(identity): This browser and Machines tabs with confirmed actions`

**Deliverable:** browser identity can be diagnosed and configured; machine conflicts
and team membership can be resolved from the section, each through a confirm dialog.

---

## Task 4: Rules and Health tabs — enforcement, simulator, coverage, diagnostics

**Files**
- Create `plugins/identity/components/settings/RulesTab.tsx`, `HealthTab.tsx`
- Create `plugins/identity/lib/simulator.ts`, `plugins/identity/lib/simulator.test.ts`
- Create `plugins/identity/lib/coverage.ts`, `plugins/identity/lib/coverage.test.ts`
- Create `plugins/identity/rules-health-tabs.test.tsx`
- Modify `components/settings/IdentitySettings.tsx`, `identity.css`

**Consumes:** `decideGuardrail`, `GuardrailFacts`, `GuardrailMachines`,
`AUTOMATIONS_PLUGIN_ID` (guardrail.ts — import the real function); Task 1
`identity_update_settings`, `identity_rerun_self_test`, `identity_diagnostics`,
`SettingsOverview`, `AUDIT_JQ_COMMAND`; Task 2 `ConfirmDialog`, `StatusBadge`;
Task 3 `PICKER_CHAIN`.

**Produces:**
```ts
// lib/simulator.ts
export type SimWho = "access-person" | "browser-name" | "fallback" | "anonymous" | "automation";
export type SimWhat = "start" | "follow-up-own" | "follow-up-others";
export type SimMachine = "own" | "another-persons" | "team" | "unclaimed";
export type SimOutcome = { mode: EnforcementMode; result: "allowed" | "logged-would-refuse" | "refused"; rule: GuardrailRule | null; message: string | null };
export function simulate(input: { who: SimWho; what: SimWhat; machine: SimMachine }): SimOutcome[]; // [off, audit, enforce]
// Builds GuardrailFacts the way makeGuardrail does: requester is non-null ONLY for "access-person"
// (browser-name and fallback identities are never persons to the guardrail); "automation" sets
// origin "plugin" + originPluginId AUTOMATIONS_PLUGIN_ID; follow-up-others records another starter.
// Calls decideGuardrail(true, facts, machines) once; off → allowed; audit → reject ? logged-would-refuse : allowed;
// enforce → reject ? refused : allowed. message = the real refusal text (not abridged in data).
// lib/coverage.ts
export type CoverageStatus = "checked" | "seen-after" | "logged-only" | "blind";
export type CoverageRow = { path: string; status: CoverageStatus; note: string };
export const COVERAGE_ROWS: readonly CoverageRow[];
```

`COVERAGE_ROWS` content (exact, in order):
1. "Composer send (new thread or follow-up)" · checked · "The dispatch hook sees it and the guardrail can refuse it."
2. "Send now (queued message)" · seen-after · "Skips the dispatch hook; Identity records the requester afterwards. A Send-now dispatch hook in BB core would move this to Checked."
3. "Automation spawning a thread (threads.spawn)" · checked · "Rule C applies to stamped automation spawns."
4. "Automation sending into an existing thread (threads.send)" · blind · "Arrives unstamped, so rule C cannot see it. Needs BB core to stamp threads.send."
5. "Agents and the CLI (no Access header)" · checked · "Always allowed: no identity means nothing to refuse. Attributed to the fallback email when one is set."
6. "Terminals, Stop, Archive, approvals, host routes, plugin RPCs" · logged-only · "Seen by the request stream in audit/enforce modes; never refused."
7. "Raw API calls with an Access header" · checked · "Same hook as the composer."

**Rules tab** (mockup Direction 2 Rules plus Direction 3 simulator/coverage):
- **Enforcement** radiogroup Off / Audit / Enforce, each with one sentence (Off: "Record
  and label only; never refuse." Audit: "Take the same decision Enforce would and write
  it to the log — let everything through." Enforce: "Refuse a known person's start on
  someone else's machine, their message into someone else's thread, and an automation
  off a team machine."). Choosing Off or Audit saves immediately. Choosing Enforce
  opens `ConfirmDialog` (checkbox gate "I have read the audit log and understand who
  would be refused"; consequence lists `overview.enforceRisks` as a `<ul>`, or "Identity
  cannot predict anyone being refused from machine state alone." when empty; always adds
  "Rule B (someone else's thread) cannot be predicted — check the audit log."). Cancel /
  Escape leaves the previous radio checked and focused. Confirm sends `{ enforcement:
  "enforce", acknowledgeEnforce: true }`.
- **Audit evidence (deferred)**: a paragraph "Identity keeps no log in the UI — by
  decision. To see what the guardrail would refuse, run:" + the command in a `<code>`
  block + Copy button (clipboard fallback as in Task 2). Label it "Needs BB core: a
  plugin log query" in the same dashed style the mockup uses for core-blocked items.
- **Simulator**: three labelled `<select>`s (Who / What / Machine) and an `aria-live="polite"`
  table with Off / Audit / Enforce columns showing result (icon + text) and, when
  refused, the rule and the refusal text in a disclosure. Note under it: "Runs
  Identity's real guardrail decision in your browser. Browser names and the fallback
  email are never refused."
- **Coverage map**: a `<details>` "Where the guardrail can and cannot see" rendering
  `COVERAGE_ROWS` as a table (cards below 720px), status as icon + text.

**Health tab** (mockup Direction 3 Health):
- **Self-test**: three legs — "Patch live", "Access email reaches Identity", "Cookie
  bridge" — derived from `overview.selfTest` (`null` → all "Not run yet"; `ok:false`
  → first two fail with `detail`; cookie leg from `selfTest.cookie`). A "Run the
  self-test again" button calls `identity_rerun_self_test`, shows a busy state, then
  `reload()`.
- **Picker chain**: `PICKER_CHAIN` with the current status marked.
- **Ledgers**: "Thread starters: {count ?? "unknown"} of {max}" and "Queued requesters:
  …" each with a `<meter>` (omitted when count is null) and a sentence "Oldest entries
  are dropped beyond the limit."
- **Config lint**: `overview.lint` grouped error → warning → info, each with
  `StatusBadge`, message and fix; empty → "No configuration problems found."
- **Redacted diagnostics**: "Copy diagnostics" calls `identity_diagnostics` and copies
  `text` (clipboard fallback: show it in a `<pre>`); a line stating exactly what is
  redacted: "Emails are shortened, people's names and the signing key are left out.
  Host names are included."

**Steps**
- [ ] Write `lib/simulator.test.ts`: table-driven over every (who, what, machine)
      combination asserting (i) off is always allowed, (ii) audit and enforce carry the
      same rule, (iii) only access-person can hit rule A/B, (iv) automation hits rule C
      off-team, (v) the message equals `decideGuardrail`'s own (spy/compare by calling
      it directly with the same facts). Write `lib/coverage.test.ts` (seven rows, the
      threads.send row is `blind`, Send now is `seen-after`). Run → fail. Implement.
      Pass.
- [ ] Write `rules-health-tabs.test.tsx`: Off/Audit save immediately; Enforce opens the
      dialog listing risks, confirm disabled until the checkbox, Escape restores the
      previous radio as checked **and focused** without an RPC call, confirm sends
      `acknowledgeEnforce: true`; jq command text equals `AUDIT_JQ_COMMAND` and Copy
      calls the clipboard; simulator updates the live table when a select changes;
      coverage disclosure lists seven rows; self-test legs for null / failing /
      passing fixtures; rerun calls the RPC; ledgers render counts and "unknown"; lint
      grouping; diagnostics copy calls `identity_diagnostics`. Run → fail.
- [ ] Implement. Gate → pass.
- [ ] Commit: `feat(identity): Rules and Health tabs with simulator and diagnostics`

**Deliverable:** every tab is real; the section can explain, simulate and diagnose the
guardrail without any in-UI audit evidence.

---

## Task 5: Browser smoke for the section, docs, and polish

**Files**
- Modify `plugins/identity/browser/runtime.ts` (capture the `settingsSection`
  component; add fixture answers for the six new RPCs, `identity_roster`, and write
  RPCs that resolve `{ ok: true, changed: [...] }`), `browser/main.tsx` (render the
  section when `?screen=settings`), `browser/smoke.mjs` (new block),
  `browser/README.md`
- Modify `plugins/identity/README.md` (settings section: tabs, what each write does,
  the trust model, the jq command, what is deferred to BB core)
- Modify any component/CSS the smoke exposes as broken

**Consumes:** everything above.

**Produces:** a `?screen=settings` browser fixture and these smoke assertions, at
widths 320, 390 and 1280 (touch at < 600):
- `document.documentElement.scrollWidth === width` (no horizontal overflow) on each of
  the five tabs, and no element inside `.identity-settings` has `scrollWidth >
  clientWidth` except elements that intentionally scroll (`pre`, `code` blocks with
  `overflow-x: auto`).
- Tabs: focus the selected tab, ArrowRight moves selection and focus, End/Home work.
- Enforce dialog: selecting Enforce opens a dialog whose Cancel is focused; Escape
  closes it, Audit is still checked and focused.
- Rotate dialog: the confirm button is disabled until `rotate` is typed.
- Every button and input inside `.identity-settings` is ≥ 40px tall.
- A screenshot per width per tab into `$IDENTITY_SCREENSHOTS/settings-<width>-<tab>.png`.
- `pageerror` count is 0.

**Steps**
- [ ] Add the fixture and the smoke block; run
      `IDENTITY_SCREENSHOTS="$PWD/.local/identity-screens" npm run test:browser` →
      expect failures that reveal real layout/focus problems (or pass).
- [ ] Fix what fails in components/CSS (not in the smoke's expectations). Re-run →
      pass. Look at the screenshots for 320px and 1280px on every tab and fix anything
      visibly clipped, overlapping, or unreadable in either colour scheme you can check.
- [ ] Update both READMEs.
- [ ] Gate + smoke → pass.
- [ ] Commit: `test(identity): browser smoke for the settings section; docs`

**Deliverable:** the whole section is verified in a real browser at three widths; docs
describe the new surface honestly, including what still needs BB core.

---

## Out of scope (Phase 3 — BB core, do not attempt)

Grouping/hiding the generated settings form; setting provenance/locks; a host owner
field; a plugin log query (and any in-UI would-refuse counts); a Send-now dispatch
hook; stamping `threads.send`; a settings deep link; composer visibility of the
selected host. Where the UI mentions one of these, label it "Needs BB core".
