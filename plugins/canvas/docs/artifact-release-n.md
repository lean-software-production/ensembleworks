# Release N: Canvas artifact compatibility reader (Stage 1a)

Status: unreleased. This is release/operator text for the compatibility reader,
not approval to release or enable artifacts. At release, replace this status
with the immutable N release tag, source commit, `dist/server.js` SHA-256 and
`dist/app.js` SHA-256. The unchanged plugin package version `0.1.0` cannot
identify this rollback floor.

Release N validates and preserves stored artifact shapes and displays
“Artifact · update the Canvas plugin to view”. Local creation is disabled:
Paste, Duplicate, generic model/shape imports, client/server `putShape`, kind
conversion and `CreateShape` intents cannot originate artifacts. The write
boundary still permits restoring an artifact ID already seen in imported
history (including undo). Raw CRDT snapshot/update import must preserve
compatible future history; it is not an authoring API or an authorization
boundary. The test-only unchecked writer is not used by product code.
Cut keeps selected artifact-containing subtrees intact and omits those subtrees
from its clipboard payload. Other selected roots cut normally. After the
clipboard write succeeds, Cut rechecks the captured roots: a changed subtree
or a newly arrived descendant stays stored. Copy/Paste/Duplicate continue to
exclude artifacts; ordinary Delete and undo retain their existing behavior.

**Rollback floor: Release N.** Once artifacts have existed, rolling back below
Release N can delete them. Pre-N builds ignore format stamps and repair unknown
kinds away; a forward upgrade cannot undo those deletions. Take a room-storage
backup before upgrade. Deploy N to every host sharing room storage, retire all
below-N hosts, and reopen stale panels before enabling N+1. There is no way for
N to retrofit refusal into a pre-N process still attached to that database.

Wire schema 4, storage format 1 and artifact props schemaVersion 1 are separate
version domains. A future writer using artifact schema 1 remains storage format
1 for N rollback compatibility. Any writer introducing data N would destroy
must atomically stamp a newer storage format with its data. N refuses that room;
it does not downgrade the stamp. No artifact viewer, route, placement CLI,
Present, defaults/minimum-size change or new input gesture ships in Stage 1a.

## Persistence boundary

`BEGIN IMMEDIATE` spans startup format validation, the snapshot/log read,
import/repair and stamping. Join/frame processing holds the same boundary from
validation through import and durable append, so the format exception occurs
outside the sync peer's malformed-frame catch. Direct appends and compaction
also validate under a write lock. Frame messages publish only after commit.
Compaction merges the persisted snapshot and log before replacing/truncating,
including data from overlapping hosts. Close uses this guarded compaction.
Touch, leave and sweep update only in-memory membership; they cannot persist a
snapshot or append. After refusal, close is idempotent and writes no room rows.

Any storage transaction failure stops the host and discards its live peer,
pending causal imports, update count, clients and outgoing messages. This
covers lock acquisition, reads, append/savepoints, compaction, outer COMMIT and
rollback cleanup failures. An append exception cannot be swallowed into a
successful host transaction by the sync peer's malformed-frame guard. Startup
storage failures abort construction. No later SyncRequest or close can publish
or persist rejected history. Recover storage, then reload the plugin to create
a fresh host from committed rows; a panel reconnect cannot restart the stopped
host. Do not rebuild on the failed connection automatically: rollback itself
may have failed. Other healthy hosts can continue to commit, and the stopped
host cannot overwrite their history.

SQLite arbitrates the lock across connections/processes: either N commits
before a newer writer acquires the lock, or the newer stamp wins and N refuses
before reading/importing/writing. There is no promise to coordinate a pre-N
writer that ignores the stamp, nor to merge conflicting edits to the same
field beyond Loro's existing CRDT rules.

Migration indices 0–5 retain the exact SQL shipped in repository release
`v0.29.0` (`556ddcca4235505026351927c83cfc1c67b6657c`), including retired
transcript tables. The format table is appended at index 6. The unpushed initial
Stage 1a implementation reused index 2 and could not upgrade that release.
Databases made by that unreleased initial implementation are test fixtures,
not supported released storage; do not deploy its bundle.

## Compatibility evidence and reproduction

`scripts/compat-real-binary.ts` executes compiled backend bundles with the SDK
fake lifecycle and real SQLite. `tests/artifact-format-race.test.ts` schedules
another connection exactly after the format SELECT. The binary harness also
runs a separate-process future writer at that barrier in startup, frame and
close, asserting lock exclusion and a successful later format-2 commit. It
compares all persisted room rows/BLOBs after refusal and unload.

From `plugins/canvas`, build N with `bb plugin build .`. Separately build an
archive of the prior release; workspace dependencies must resolve inside that
archive, never to N. Keep `compat-provenance.json` at the archive root with
`ref`, full `commit`, `kind` and a description of build/dependency provenance.
Then run:

```sh
bun build scripts/fixtures/future-writer.ts --target=node \
  --external better-sqlite3 --external @get-bb/plugin-sdk \
  --outfile dist/compat-future.mjs
node --import tsx scripts/compat-real-binary.ts \
  --previous /path/to/released-archive/plugins/canvas \
  --current . --future dist/compat-future.mjs
```

The fixture is a **representative N+1 writer**, separately compiled and never
imported by the product entry points. It can emit valid artifact history and
atomically write unknown format-2 data with its stamp. It is not an actual
N+1 release and does not implement Stage 1b or the viewer. The harness fails
on assertion failures; destructive rollback is asserted, not just printed.
Bundle SHA-256s, source identities and dependency limitations appear in its log.

| Writer / reader or overlap | Required assertion |
| --- | --- |
| Tagged pre-N release → N | Upgrade without migration hash conflict; ordinary shapes preserved |
| Future format-1 fixture → N | Full artifact envelope/props preserved through repair, sync and restart |
| N-preserved artifact → pre-N release | Artifact deleted on rollback, from snapshot and logged-update cases; ordinary shapes retained; forward upgrade cannot recover it |
| N / future format-1 fixture overlap | Both hosts' shapes and every prop preserved, in both disposal orders |
| Future format-2 fixture / N | Process barrier prevents an intervening stamp; once the stamp commits, calls visibly refuse and all rows remain unchanged |
| Old protocol panel → N | Join and frame refused with the reopen message |

Limitations: the locally available prior release is a **rebuild of the tagged
repository source**, with recorded installed-dependency reuse, not a recovered
original distributed plugin bundle. The Canvas package has no independent
release identity beyond its repository revision. The harness uses source sync
peers as panel protocol adapters and the SDK fake host lifecycle, not the
actual browser app bundle or real BB loader. It proves logical row/BLOB
preservation, not whole SQLite-file identity. Placeholder rendering has its
own inert-markup tests.

**N+1 release gates remain mandatory:** obtain the actual distributed prior/N
bundles and record their hashes; run rollback and both overlap orders with the
actual N+1 backend and full artifact props; exercise already-open old app
bundles in the real BB loader/browser through each upgrade and rollback,
including visible refusal and the N placeholder. Confirm N is deployed on
every host sharing storage before authorizing artifact creation. Passing the
fixture harness does not satisfy these future-release gates.

## Proposed PR text

Prevent rolled-back Canvas frames from leaking through a later sync or close:
any storage transaction failure now stops the host and discards its live peer
and unpublished state. Recovery requires storage repair and a fresh host load.

Cut preserves selected artifacts and whole selected subtrees containing them,
while unrelated copyable roots cut normally. It rechecks copied subtrees after
the asynchronous clipboard write. Copy/Paste/Duplicate/import/create gates
continue to refuse new artifacts and preserve stored history.

Regression coverage includes a real SQLite COMMIT lock failure followed by a
valid SyncRequest, failed append/savepoints, pending imports, failed rollback
cleanup, overlap/reload, and Cut through the mounted session and real browser.
The declared browser interaction contract is `cut-preserves-artifacts`; the
fixture-props seed works in both adapters, with no new observation API.

Validation includes the literal Canvas typecheck/test/quality/build commands,
repository typechecks and relevant suites, clipboard browser contracts, and
all 36 compiled compatibility assertions. The tagged-source rebuild, future
fixture and real BB loader limitations above remain future release gates.

The artifact renderer itself remains an inert placeholder with no interaction
surface. The existing clipboard interaction changes are covered by the named
contract; the earlier blanket `ux-contract: none` opt-out no longer describes
this rework. No viewer, placement workflow, controls or new gesture is added.
