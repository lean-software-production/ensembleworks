# EnsembleWorks as a BB plugin collection

**Status:** Proposed

**Date:** 2026-09-12

## Summary

EnsembleWorks should evolve from one vertically integrated application into a
small collection of capability-complete BB plugins, backed by shared libraries
where code reuse is useful. Plugin boundaries should represent independently
installable products with their own configuration, storage, lifecycle, failure
modes, and release cadence. They should not mirror every source directory or
small feature.

The first target collection is:

1. **Canvas** — the durable spatial workspace and its BB-thread integration.
2. **Presence** — BB-wide whereabouts and composer awareness, beginning with
   “Alice is typing…”.
3. **Transcript** — transcript ingestion, reading, search, agent context, and
   optional transcription workers.
4. **Discord Bridge** — Discord connectivity and Canvas/Transcript workflows.

LiveKit audio/video remains inside Canvas initially because its spatial behavior
is tightly coupled to Canvas state. It may later become a **Huddle** plugin after
there is a clean cross-plugin presence/location contract.

The plugins should remain in the EnsembleWorks monorepo during this transition.
A `.bb/plugins.json` collection manifest makes local path installation easy.
Each plugin receives its own package version and prefixed Git tags. A small
private EnsembleWorks marketplace publishes approved version ranges to
production BB instances while leaving each instance in control of when it
updates.

## Context

The current [Canvas plugin](../../plugins/canvas/) is already an isolated npm
package and a useful extraction boundary, but it contains several products:

- A Loro-backed Canvas document and synchronization host.
- Canvas pages, rendering, tools, and cursor presence.
- Canvas-shape to BB-thread links and agent status.
- BB-wide user location tracking.
- LiveKit voice/video and a global presence strip.
- Transcript ingestion, persistence, panels, and agent context.

The existing implementation also demonstrates two different kinds of
collaborative state:

- `canvas-doc` uses a durable Loro CRDT for pages, shapes, bindings, assets,
  and text.
- [`canvas-sync` presence](../../canvas-sync/src/presence.ts) uses Loro's
  `EphemeralStore` for cursor, viewport, editing, presentation, and Canvas-page
  awareness. It is last-write-wins, expires, and is never persisted as Canvas
  history.

BB-wide whereabouts currently use a third implementation. The Canvas plugin's
[`LocationBook`](../../plugins/canvas/canvas/locations.ts) receives a per-tab
path, title, focus flag, identity, and last-seen time. This exists separately
because a BB tab viewing a thread has not joined the Canvas sync room and should
not receive Canvas document traffic.

This is a good architectural precedent: durable collaboration and ephemeral
awareness can share transport ideas without sharing one document or one
membership scope.

## Goals

- Make each user-facing capability independently installable where it has
  meaningful standalone value.
- Preserve fast local development from one checkout.
- Allow plugins to use independent semantic versions and release cadences.
- Allow different production BB instances to remain on different known plugin
  versions.
- Keep plugin-owned storage, settings, secrets, routes, and lifecycle isolated.
- Reuse Loro and synchronization code without building one universal shared
  document.
- Keep BB authoritative for threads, agents, message dispatch, permissions,
  terminals, browsers, and workspace state.
- Create explicit, versioned integration contracts where two plugins genuinely
  need to cooperate.

## Non-goals

- One plugin per existing Bun workspace or UI feature.
- Reimplementing BB terminals, browser tabs, file previews, authentication, or
  thread lifecycle in EnsembleWorks.
- A runtime “suite plugin” that secretly installs or controls other plugins.
- A single Loro document containing all Canvas, presence, transcript, and BB
  state.
- Publishing every shared `@ensembleworks/*` package to npm immediately.
- Automatic production upgrades merely because a new version was published.

## Boundary rules

A capability should become a separate plugin when most of the following are
true:

- It is useful without the other EnsembleWorks plugins.
- It has distinct settings, secrets, or external accounts.
- It has a distinct background lifecycle or operational failure mode.
- Users may reasonably want to install or disable it independently.
- It can own its state without reading another plugin's database.
- Its integration with other plugins can be expressed through a small stable
  contract.

A capability should remain an internal module or shared package when it mainly
exists to organize code, renders inside another plugin's surface, or would need
continuous access to another plugin's in-memory implementation.

## Target topology

```text
                              BB core
        threads, agents, auth, dispatch, terminals, browser, files
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
          Canvas             Presence          Transcript
              │                  │                  │
              │            typing now;             │
              │          shared drafts later       │
              │                                     │
              └──────── explicit contracts ─────────┤
                                                    │
                                             Discord Bridge

       Huddle/AV remains a Canvas module initially and may move later.
```

The arrows are capability relationships, not permission to import another
plugin's implementation. BB currently has no general typed plugin-to-plugin
service bus, so cross-plugin dependencies must remain rare and explicit.

## Shared libraries

### Canvas engine packages

The existing packages remain libraries consumed by Canvas:

- `@ensembleworks/canvas-model`
- `@ensembleworks/canvas-doc`
- `@ensembleworks/canvas-sync`
- `@ensembleworks/canvas-editor`
- `@ensembleworks/canvas-react`

These are code and model boundaries, not user-facing plugin boundaries.

### Collaboration synchronization

Do not generalize `canvas-sync` merely in anticipation of future reuse. When a
second durable collaborative feature—most likely a shared thread composer—needs
it, extract two distinct primitives:

```text
DurableReplica<TDocument>
  version vectors
  incremental updates
  snapshots and persistence
  reconnect and backfill

AwarenessStore<TPresence>
  one current value per client
  last-write-wins merge
  expiry
  current-state bootstrap
  no durable history
```

Canvas would instantiate both. BB-wide presence would normally instantiate only
the awareness layer. A shared composer would use a durable Loro text document
for the draft and ephemeral awareness for selections and typing state.

Sharing these primitives does not imply one network room. Canvas documents,
BB-instance presence, and composer drafts should have different scopes,
authorization, traffic, retention, and failure domains.

## Plugin responsibilities

### Canvas

Canvas owns:

- The Canvas navigation panel and page routing.
- Canvas model, Loro document, persistence, synchronization, and compaction.
- Shape rendering, editing, selection, and tools.
- Canvas-scoped cursor, viewport, page, and editing awareness.
- Canvas CLI and agent-tool operations for reading and writing shapes.
- Shape-to-BB-thread links, “run this note as an agent,” and thread-status
  badges.
- Stable Canvas capability contracts needed by approved companions.

Canvas does not ultimately own:

- BB-wide whereabouts.
- Composer typing state or shared drafts.
- Transcript storage and transcript panels.
- Discord credentials or gateway connections.
- BB terminal, browser, file, or agent lifecycle.

Shape/thread binding stays in Canvas initially. It crosses Canvas rendering,
Canvas persistence, and BB thread APIs so deeply that splitting it now would
create an extension system before there is a second real consumer.

### Presence

Presence owns team awareness throughout one BB collaboration scope:

- Per-client and per-person membership.
- Current BB surface, project, and thread whereabouts.
- Focused and visible-tab resolution for people with multiple windows.
- Composer typing indicators.
- Presence expiry, reconnect reconciliation, and roster presentation.
- Privacy and visibility rules for presence information.

The first deliverable is deliberately small: “Alice is typing…” on existing
thread composers.

```text
local composer change
    → throttled typing pulse
    → plugin RPC
    → expiring server entry
    → realtime invalidation
    → other composer banners refresh
```

The first version should:

- Support ordinary existing-thread composers only.
- Emit after an actual text change, not merely focus.
- Throttle to roughly one pulse per second.
- Expire after roughly three seconds without a pulse.
- Clear eagerly on blur, hide, submit, or unmount, while treating expiry as
  authoritative cleanup.
- Send no draft content, cursor position, or character count.
- Exclude the local tab and aggregate multiple tabs for the same person.

This feature does not need Loro. A bounded in-memory expiry map plus BB RPC and
realtime proves identity, scoping, lifecycle, and UI value with much less
machinery.

Once Presence is established, it can absorb the `LocationBook` behavior from
Canvas. A later shared composer can add durable Loro text while keeping message
dispatch authoritative in BB. The CRDT may own drafting; it must not decide
whether an irreversible send occurred.

### Transcript

Transcript owns:

- Authenticated transcript ingestion.
- Append-only transcript persistence.
- Search, time windows, and live-tail reconciliation.
- Thread and New Thread side-panel views.
- Agent mention/context integration and transcript-reading skills.
- Optional transcription-worker configuration and lifecycle.

Speaker, time, and text are the core record. Canvas position, page, and nearest
frame are optional enrichment so Transcript remains useful without Canvas.

### Discord Bridge

Discord Bridge owns:

- Discord credentials and required permissions.
- Discord gateway connection, retry, and disposal.
- Channel bindings.
- Inbound and outbound formatting and delivery.
- Commands or UI used to manage those bindings.

It may use stable Canvas operations to place inbound messages and stable
Transcript operations to publish summaries. It must not import either plugin's
implementation, read either database, or assume either plugin is installed.
Missing optional companions should produce an explicit unavailable or degraded
state.

### Huddle / AV

A future Huddle plugin could own:

- LiveKit settings and token issuance.
- Voice/video session lifecycle.
- Participant controls and speaking indicators.
- Non-spatial BB-wide calls.

It is not an initial extraction. Spatial gain, speaker rings, viewport
coordinates, and Canvas placement currently form a tight client-side cluster.
Moving it before there is a supported Canvas-location capability would replace
local coupling with fragile cross-plugin or DOM coupling.

## State ownership

| Information | Owner | Mechanism |
| --- | --- | --- |
| Canvas pages, shapes, text, assets, bindings | Canvas | Durable Loro document plus plugin SQLite |
| Canvas cursor, viewport, page, editing shape | Canvas | Ephemeral awareness |
| BB route/thread being viewed | Presence | Expiring awareness |
| “Alice is typing” | Presence | Expiring awareness; initially RPC/realtime |
| Shared composer draft, if built | Presence or later Shared Composer | Durable Loro text |
| Composer selections and remote cursors | Presence or later Shared Composer | Ephemeral awareness |
| Final message dispatch | BB | Authoritative serialized command |
| Thread messages and agent state | BB | BB database and lifecycle APIs |
| Transcript entries | Transcript | Append-only plugin storage |
| Discord credentials and bindings | Discord Bridge | Secret settings plus plugin storage |
| LiveKit credentials and call state | Canvas initially; Huddle later | Secret settings plus ephemeral session state |

Secrets, permissions, billing, audit history, terminal ownership, and message
dispatch are never CRDT state. Concurrent merge is not a substitute for an
authoritative security or side-effect boundary.

## Cross-plugin contracts

The preferred integration order is:

1. Use BB-owned entities and events as the rendezvous point where possible.
2. Keep optional enrichment in the record produced by the originating system.
3. Use a small, versioned, schema-validated HTTP contract only when direct
   cooperation is unavoidable.
4. Propose a BB Plugin SDK capability when multiple plugins need the same
   authenticated or client-side behavior.

Cross-plugin contracts must be bounded, versioned, and capability-oriented—for
example, “create a Canvas note” rather than “write this Canvas database row.”
They must treat callers and persisted values as untrusted input.

The following SDK improvements may eventually be preferable to private
EnsembleWorks protocols:

- Authenticated current-person identity for plugin frontend and RPC handlers.
- Scoped client presence and targeted realtime delivery.
- A composer activity event with source and lifecycle information.
- A composer collaboration adapter exposing editor transactions and
  selections, rather than whole-text replacement.
- Typed discovery and invocation of another plugin's declared capability.

None of those is required for the first typing-indicator spike.

## Repository and package layout

The initial layout is:

```text
ensembleworks/
  plugins/
    canvas/
      package.json
      package-lock.json
      PLUGIN_OVERVIEW.md
      server.ts
      app.tsx
    presence/
    transcript/
    discord-bridge/
  canvas-model/
  canvas-doc/
  canvas-sync/
  canvas-editor/
  canvas-react/
  collaboration-protocols/
  .bb/
    plugins.json
```

Each plugin is an isolated npm package with its own lockfile. Plugins do not
join the root Bun workspace. This preserves reproducible managed Git installs
and keeps later repository extraction possible.

The root collection manifest is an index only:

```json
{
  "$schema": "https://getbb.app/schemas/plugins.schema.json",
  "schemaVersion": 1,
  "name": "ensembleworks-plugins",
  "plugins": [
    { "name": "canvas", "source": "./plugins/canvas" },
    { "name": "presence", "source": "./plugins/presence" },
    { "name": "transcript", "source": "./plugins/transcript" },
    { "name": "discord-bridge", "source": "./plugins/discord-bridge" }
  ]
}
```

It does not override plugin identity or install the collection as a suite.

## Local development

A development BB instance installs plugins from the working checkout:

```sh
bb plugin install path:. --plugin canvas
cd plugins/canvas
bb plugin dev
```

The same applies independently to Presence, Transcript, and Discord Bridge.
Path installation gives the shortest edit/build/reload loop and requires no
published version.

A repository-level developer helper may later wrap installation of a chosen
profile, for example `canvas + presence`, but it should invoke normal BB plugin
commands rather than implement a second installer.

Before release, CI must also test a managed Git installation from a clean
checkout. Local path installs can accidentally succeed because of undeclared
dependencies, existing `node_modules`, or files outside the plugin package.

## Versions and Git releases

Each plugin has an independent semantic version in its own `package.json` and
uses a prefixed annotated Git tag:

```text
canvas/v0.2.0
presence/v0.1.0
transcript/v0.3.1
discord-bridge/v0.1.2
```

The tag points at a repository commit containing both the plugin and the exact
shared-package revisions it was tested against. Moving an existing tag is
forbidden; fixes receive new versions.

A dedicated plugin release script should:

1. Require a clean `main` synchronized with `origin`.
2. Run the affected plugin's install, types, tests, structural gates, and BB
   build.
3. Update that plugin's package version and lockfile.
4. Commit `release(<plugin>): <version>`.
5. Create the annotated `<plugin>/v<version>` tag.
6. Push the commit and tag.

The existing `deploy/release.sh` remains the required release path for the
legacy EnsembleWorks application. Plugin releases use a separate scripted path;
neither release kind is performed through hand-edited versions or manual tags.

## Custom EnsembleWorks marketplace

Create a small separate repository such as `ensembleworks-marketplace`:

```text
ensembleworks-marketplace/
  marketplace.json
  icons/
    canvas.svg
    presence.svg
    transcript.svg
    discord.svg
```

The marketplace is a catalog, not an artifact store. Each entry points to the
source repository, plugin subdirectory, semver range, and tag prefix:

```json
{
  "$schema": "https://getbb.app/schemas/marketplace.schema.json",
  "schemaVersion": 1,
  "name": "ensembleworks",
  "displayName": "EnsembleWorks",
  "description": "Collaborative tools for BB teams.",
  "plugins": [
    {
      "id": "canvas",
      "displayName": "Canvas",
      "description": "Collaborate with teammates and agents on a shared spatial canvas.",
      "icon": { "url": "./icons/canvas.svg" },
      "tags": ["collaboration", "canvas"],
      "author": { "name": "EnsembleWorks" },
      "source": {
        "git": {
          "url": "https://github.com/lean-software-production/ensembleworks.git",
          "subdir": "plugins/canvas",
          "range": "^0.2.0",
          "tagPrefix": "canvas/"
        }
      }
    }
  ]
}
```

A production instance configures the catalog once:

```sh
bb marketplace add git:github.com/lean-software-production/ensembleworks-marketplace@main
```

Operators then use BB's ordinary inventory and update flow:

```sh
bb marketplace refresh ensembleworks
bb plugin outdated
bb plugin update canvas
```

Publishing `canvas/v0.2.1` does not silently update any instance. Each
installation records its resolved tag and commit and moves only when its
operator chooses to update. Separate production instances can therefore run
different versions while using the same marketplace.

The catalog should contain only versions approved for normal production use.
Prereleases remain absent from ordinary ranges unless explicitly named. A
staging instance can install a prerelease tag or exact commit directly, or use
a separate staging catalog if that workflow becomes frequent.

## Relative shared-package dependencies

Canvas currently uses dependencies such as:

```json
"@ensembleworks/canvas-doc": "file:../../canvas-doc"
```

This is acceptable for Git installs from the monorepo: a plugin release tag
identifies the whole repository commit, including the exact relative packages.
It also means the release is reproducible only from that complete repository
layout.

If plugins later move to separate repositories or npm distribution, choose one
of these paths:

- Publish shared `@ensembleworks/*` packages with compatible versions.
- Move the required sources under the plugin package.
- Bundle the shared implementation into the plugin artifact where BB's build
  and runtime model permits it.

This decision is deferred until repository extraction or npm publication is a
real requirement.

## Compatibility, storage, and rollback

Every plugin declares honest `engines.bb` and `engines.bbPluginSdk` ranges.
Before changing SDK usage, run `bb plugin types --check` against the supported
BB release and build with that release's plugin toolchain.

Plugin-owned durable state lives in BB's namespaced plugin storage. Database
migrations are append-only. Releases must preserve enough read compatibility
for safe activation and must not assume that downgrading after a data migration
is automatically safe.

BB automatically retains the previous registration set when an update
candidate fails activation. That protects against load-time failure, not every
semantic data migration. Production rollout should therefore proceed through a
staging instance before broad adoption, and migration compatibility should be
tested explicitly.

## Verification gates

Each plugin owns focused checks appropriate to its behavior. The common release
gate is:

```text
npm ci
npm run typecheck
npm test
npm run audit:quality:compare        # where the plugin defines the gate
bb plugin types --check
bb plugin build .
managed Git-install smoke test
```

Frontend plugins verify slot registration, lifecycle cleanup, reconnect
reconciliation, and failure isolation. Background services verify abort and
dispose behavior. Storage tests verify fresh creation and upgrade from every
supported schema version.

Changes to interaction-bearing Canvas surfaces continue to follow the
repository's interaction-contract requirements, including independent
red-then-green verification.

## Adoption sequence

1. Add `.bb/plugins.json` and document path-installed development for the
   existing Canvas plugin.
2. Create Presence with only the existing-thread typing indicator.
3. Move BB-wide whereabouts and roster behavior from Canvas into Presence once
   identity and visibility rules are settled.
4. Extract Transcript without requiring Canvas; retain optional spatial
   enrichment.
5. Extract Discord Bridge behind explicit Canvas and Transcript capabilities.
6. Add prefixed plugin release automation and clean Git-install CI.
7. Publish the private EnsembleWorks marketplace and install the plugins on a
   staging BB instance.
8. Generalize collaboration synchronization only when shared composer text or
   another second consumer requires it.
9. Reconsider Huddle/AV after a supported presence/location integration seam
   exists.

## Risks and mitigations

### Too many plugin boundaries

Over-decomposition increases bundle loading, configuration, release work, and
cross-plugin coordination. Keep a feature inside its owner until it has
standalone value and a small integration contract.

### Marketplace mistaken for deployment

A marketplace publishes discovery metadata and approved source ranges. It does
not update instances automatically or coordinate multi-plugin migrations.
Promotion remains an operator-controlled update process.

### Cross-plugin state leakage

BB realtime is currently broadcast-oriented and is not itself a privacy
boundary. Presence payloads should be minimal, scoped, and authenticated.
Thread IDs, routes, and identities require explicit visibility policy before
use outside a trusted team instance.

### Universal CRDT

Putting unrelated features in one Loro document would couple authorization,
traffic, schemas, persistence, and compaction. Use multiple durable documents
and awareness rooms with narrow scopes.

### Plugin bundle cost

Splitting plugins improves optional installation and failure isolation, not the
combined cost for a user who installs every plugin. Loro's inlined WASM and
LiveKit remain material frontend costs. Measure bundle sizes and avoid loading
large dependencies into plugins that do not need them.

## Open questions

- What is the authoritative person identity on a multi-user BB instance, and
  how does a plugin receive it without accepting a browser assertion?
- Is presence scoped to the entire BB server, a project, or an explicit team
  room?
- Which Canvas and Transcript capabilities genuinely need cross-plugin access?
- Should the marketplace repository be private Git initially or served as a
  small HTTPS catalog?
- What staging and approval policy moves a tag into the stable marketplace
  range?
- When shared composer text is built, should it remain in Presence or become a
  separate Shared Composer plugin?
- What SDK surface should eventually replace private presence and
  cross-plugin protocols?

## Proposed decision

Proceed with a monorepo plugin collection and a thin private marketplace.
Create Presence as the next small plugin, using a typing indicator to validate
identity, thread scoping, lifecycle, composer UI, and realtime delivery. Keep
Canvas as the durable spatial core, extract Transcript and Discord as
independent products, and defer AV extraction and generic Loro refactoring
until concrete second consumers justify their integration seams.
