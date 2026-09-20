# Canvas GitHub issue card (2026-09-23)

## Follow-up implementation

The shipped placement flow now creates an unlinked shared card immediately. Its URL/search draft stays local while the card can be moved, resized, copied, and left on the canvas. Linking stores one canonical `issueUrl` field in version-2 props; version-1 linked cards remain readable. The unlinked card offers a keyboard-accessible cached-issue picker and a URL paste fallback. Picker results come from the installed GitHub plugin's cache-only `listItems` RPC, limited to repositories tracked by this Canvas project's ID and projected to issue identity, title, state, and update time. Pull requests are excluded. The plugin cache is bounded, so missing picker results do not imply a missing or deleted issue.

The picker interaction contract's unfixed RED was: `AssertionError: unlinked card must expose an issue search combobox: expected null not to be null` (`plugins/canvas/tests/github-issue-picker.test.tsx`). After implementation, the contract test and pointer-selection test passed. The live Canvas RPC returned only the configured project's cached issues; a `cohort` query returned three matching issue titles.

## Decision and scope

The BB Canvas plugin adds a read-only GitHub issue card. The toolbar has an Issue button. Placing it opens a local URL-entry draft; submitting a valid `https://github.com/<owner>/<repo>/issues/<number>` URL for a repository tracked by the Canvas project creates a shared card. The card can be freely resized. It displays the issue number as a new-tab link, title, open/closed state, labels, assignee, author, issue update time, and the BB GitHub plugin's **global** sync time. Clicking the card selects it. The GitHub-style HTML mockup in the thread's reports directory is the visual reference; use the number link in the large card's header.

No GitHub mutations, Canvas-owned GitHub credentials/API client, direct issue refresh, BB thread creation/linking, arbitrary hosts, or arbitrary repositories in this increment. The issue number link is the only navigation. Do not call the GitHub plugin's live `getIssue` or `refresh` methods from Canvas.

## Model, persistence, and compatibility

- Add a versioned `github-issue` shape kind to the shared model. Props are the box dimensions and a canonical identity, for example `schemaVersion: 1`, `repo: "owner/repo"`, and positive integer `number`. Derive the public URL from the validated identity; do not persist title, labels, status, assignee, author, or timestamps.
- Use existing box geometry, selection, transform, resize, copy/paste, and CRDT operations. A local draft exists only in editor/plugin UI until URL validation and placement complete. Cancel/Escape leaves no shared shape. Two people can independently add cards for the same issue; each card has its own layout but reads the same cache.
- Register the renderer only in the BB plugin, like `bbthread`; the web app must handle the new kind safely, even though its toolbar does not expose it. Review snapshot import/export and old-client unknown-kind behavior before changing the schema. Shape schema validation must reject malformed identities and unsupported versions without silently turning them into misleading cards.

## Data boundary

- Add a thin Canvas server RPC that calls the installed official GitHub plugin through `bb.sdk.plugins.callRpc`. Use `status` to obtain tracked repositories and global `lastSyncedAt`; use cache-only `listItems` for issue rows. Validate that the requested repository belongs to this Canvas plugin's configured project ID, including on every read. Return only display fields required by the card; never forward issue body or credentials.
- Treat plugin-unavailable, auth/sync failure, untracked repository, missing cache row, and malformed URL distinctly. A missing row says **Not in GitHub cache**, not **deleted**: the plugin caches only a bounded newest set of open/closed issues, and a miss cannot prove deletion. Preserve the identity link when details are unavailable.
- The plugin sync cursor is global, not proof that a particular issue was refreshed. Label it `GitHub sync` (or clearer equivalent) and explain the scope in accessible help text. Label the remote issue's `updatedAt` separately as `Issue updated`. No card refresh button.
- Fetch on first render from Canvas's adapter. Re-read the plugin cache on panel focus and after a bounded shared status check detects a newer global sync time; deduplicate by repository so cards do not make one RPC each. An updated global cursor triggers a cache re-read but does not imply per-repo success. Keep the last successful display payload locally while a later read fails, with a visible stale/error message. Do not copy remote data into Loro.

## Visual and interaction states

- Unbound local draft: URL input, validation feedback, submit/cancel; keyboard focus moves into input, Enter submits, Escape cancels. Keep its viewport position predictable on mobile and with zoom.
- Loaded card: GitHub-like border/header, `#number ↗` link, title, open/closed badge, label pills, assignee/author identifiers, and both timestamps. The official cache exposes label names and user names, not label colors or avatar URLs; use neutral or deterministic local styling and initials, without new network fetches.
- Loading/unavailable/miss/permission states: maintain recognizable card bounds and issue link. Show concise, nondeceptive status text and last known successful data where available. A private/deleted issue cannot be asserted from a cache miss.
- Clicking card selects; activating number link opens a new tab with `noopener,noreferrer` and does not start a canvas drag. Keyboard can reach and activate link. Selection handles permit free resize with readable compact and expanded layouts; never hide the identity link. Use semantic labels, visible focus, and text contrast. Touch input must work without hover. Export/print should show the visible card or honest unavailable state.

## Verification and delivery

- Declare or extend a real interaction contract in `@ensembleworks/interaction-contracts` for the toolbar/draft/commit/select/link or resize boundary. Obtain genuine RED on unfixed code and record the verbatim failing output before implementing. If RED is unreachable, stop and report. Any `Obs` additions must be implemented in both `canvas-editor/src/contracts/fsm-runner.ts` and `e2e/lib/contracts.ts`.
- Test URL parsing, tracked-project repository authorization, cache adapter projection and failures, draft cancellation/commit, selection/link routing, resize, persistence/copy-paste, and stale/miss presentation at the most meaningful layers. Independent validator must reproduce red then green by reverting and restoring the fix, not merely accept the implementer's report.
- Run relevant root typecheck/contract tests and, in `plugins/canvas`, `npm run typecheck`, `npm test`, `npm run audit:quality:compare`, `bb plugin build .`. Report any unavailable browser/live-plugin check as a limit. Do not reload Canvas, merge, publish, or deploy as part of this workflow.

## Acceptance criteria

1. A user can add a valid tracked-repo issue from the toolbar and see a shared, freely resizable card; invalid/untracked URLs do not create a shared shape.
2. The card selects on click; its `#number` link opens the issue in a new tab; keyboard and touch interactions remain usable.
3. The card reflects cached GitHub plugin data, distinguishes `Issue updated` from global `GitHub sync`, and honestly handles unavailable/missing data without claiming deletion.
4. Shared shape state holds identity and layout only; no GitHub secret or remote issue metadata is persisted in the canvas document.
5. Contract RED/GREEN, independent reproduction, targeted tests, typechecks, quality audit, and plugin build are evidenced.

## Repair execution note (2026-09-23)

The mixed-version, interaction, and compact-footer repairs were completed in the existing uncommitted diff. Exact RED/GREEN reproduction, headless Chromium geometry, and check output are recorded in this BB thread's `github-issue-card-repair-evidence.md`. A pre-card Canvas bundle is rejected at join and frame RPCs before it can repair an unknown shape; upgraded peers converge in the integration test. The card footer stacks both timestamp labels at the 260×170 floor. The live BB panel and GitHub plugin were not accessed because this work order forbids Canvas reload and live issue reads.

The subsequent independent review found that, despite the footer fitting, the title collapsed at 260×170 (2.4px in stale state). The short-height layout now reserves two title lines and removes the label row at that size. A dedicated Chromium geometry test covers ready, stale, cache-miss, and loading cards. Its RED/GREEN and final checks are recorded in `/home/ensembleworks-agent/.bb/thread-storage/thr_n7frpw5ze4/github-issue-card-final-repair-evidence.md`.

The second independent review found sliced warning, badge/author, and label/assignee rows at the default 470×256 size and intermediate heights. The renderer now uses compact rows below 300px, omits the label row when it cannot fit, and omits the badge row on 170px stale/auth cards while retaining the title, warning, issue link, and both timestamps. Keyboard activation of the armed Issue button opens the local draft at viewport centre; its coarse-pointer size uses the shared 44px control metric. Browser geometry, toolbar, root/plugin RED/GREEN and final gate evidence is in `/home/ensembleworks-agent/.bb/thread-storage/thr_qng7fz2uz4/github-issue-card-repair-evidence.md`.
