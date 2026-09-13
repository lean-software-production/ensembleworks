# Fabro composer banner lifecycle

Approved in thread thr_jh922rygfz. Implement through the project Ralph loop.

## Goal
Keep the composer focused on active work without hiding unreviewed deliveries. Change only plugins/bb-plugin-assembly-lines. The existing ComposerGraphBanner selects the newest job by createdAt/id across all pages for the composer's thread. Keep that selection; hiding the newest accepted/dismissed job must not resurrect older historical jobs.

## Behavior
- Active, queued, preparing or unknown/unreachable runs retain the current collapsible mini DAG, short displayTitle, full-title tooltip, glyph, accessible status icon, stage display, and sidebar action. Connection failures alone never imply completion or acceptance.
- Successful execution with acceptance pending becomes one line labeled Ready for review. Even if expanded while running, it collapses immediately on completion. This terminal notice does not expand; its sidebar action still opens the delivery. Do not hide it until assessed.
- Accepted results disappear from the composer immediately on refresh/realtime notification. They remain accessible via existing thread cards, nav list and sidebar. Do not delete or change job records.
- Rework or needs_input assessments become one-line Rework needed or Needs input notices with accessible Dismiss and Open details controls. Failed/dead/error/cancelled/canceled execution pending assessment becomes a Failed or Cancelled dismissible notice. Assessment states take precedence over successful execution: succeeded plus needs_input must never show Ready for review. Preserve distinction between execution and acceptance in accessible text/tooltips.
- Dismissal is local UI state only, not an assessment or cancellation. Persist it in sessionStorage (guard storage access failures with an in-memory fallback) for this browser session, keyed by threadId/jobId/resultRevision plus acceptanceVerdict and execution state. The same dismissed result remains hidden across component remounts; a new run, revision, or changed assessment/execution state is eligible again. Do not use updatedAt as the key because polling can change it. Do not store logs, secrets or full work orders.
- Do not mount/poll the graph for hidden or terminal single-line notices. Active expanded/collapsed views retain one graph stream; cleanup timers and prevent stale responses after identity changes/unmount.

## Verification
Add meaningful UI regressions covering running-expanded to succeeded-pending (Ready for review, no graph), accepted disappearing via realtime, succeeded plus rework/needs_input precedence, failure/cancellation dismissal, remount persistence, new revision/run resurfacing, thread isolation, and continued sidebar/card navigation. Guard the fallback if browser storage throws. Existing data parsing and composer tests remain passing; adapt assertions only for intentionally changed terminal lifecycle behavior. Use native accessible controls and preserve narrow-width behavior.

Run plugin npm run typecheck, env -u FABRO_GRAPH_TEST npm test, npm run build and git diff --check. Record actual browser verification if available, otherwise explicitly report its absence. Scope is outside the canvas interaction-contract surfaces. If expanding to those paths would be necessary, stop; their contract declaration, verbatim pre-fix RED, both Obs adapters and independently reproduced RED/GREEN obligations would apply. No dependency, package-script, lockfile, test/compiler configuration or line-definition changes. No merge, push, deploy, plugin installation or additional spawned work in the workflow.

Deliver a scoped implementation with completed task checklist and evidence for each criterion; the originating BB thread independently assesses it.
