# Make Fabro deliveries reviewable in the sidebar

Approved in BB thread thr_jh922rygfz: replace the default raw JSON results display with Summary, Changes, Checks and Review; retain collapsed Raw JSON. Execute with the project Ralph loop.

## Goal and boundaries

Users should be able to review a Fabro delivery without decoding escaped JSON. Work only in plugins/bb-plugin-fabro. Preserve the existing DAG card, sidebar opening, owner-thread routing, external link, acceptance navigation, existing iframe toggle, job persistence, CLI/tools and RPC contracts. Do not add dependencies or change package scripts, lockfiles, compiler/test configuration, credentials, or workflow definitions. No merge, push, deployment, or plugin installation by the workflow.

## Implementation guidance

Inspect app.tsx Panel, contracts.ts, server.ts getRunDetails, host evidence and app.test.tsx. getRunDetails.details is serialized evidence; persisted job.result is a fallback. Evidence workspace.files entries contain text and truncated fields. delivery.json embeds before/after checks, attempts, changedFiles, resultSha, review; validation.json/baseworkflow.json/review.md/diff.patch may be available before delivery. Support current and legacy/partial envelopes without assuming every field exists. Parse at the boundary into typed presentation data, guard JSON parsing and field types, honor truncation indicators, and avoid throwing on malformed or unexpected payloads. Prefer fresh valid detail evidence, with explicit fallback to persisted evidence. Never let unavailable data imply success.

Use installed public SDK exports (inspect declarations): Markdown for review and experimental_Diff for per-file unified patches if supported. The latter takes one file patch; split multi-file diffs correctly, with readable plain-text fallback for unsupported/binary/malformed patches. Do not use raw HTML injection. Existing styles/components should make the result look native to BB. No new backend protocol is required.

## Required behavior

- Summary shows execution status and acceptance separately, changed files, attempts and delivery commit when known. Show the retained checkout path accessibly with wrapping.
- Changes displays actual diff with workflow breaks and added/removed highlighting, per-file where possible. Handle no change, unavailable, binary and truncated diffs honestly.
- Checks groups available baseline and final/latest validation evidence, labels commands with pass/fail/unknown, and exposes stdout/stderr/error/exit details in keyboard-accessible expandable logs. Null exit, signal or execution errors cannot count as passing. Quality checks are included.
- Review displays formatted Markdown and acceptance verdict/reason separately from the workflow's own review.
- Raw JSON remains available in a collapsed section. Malformed details remain inspectable there and show a concise fallback message.
- Running, failed and missing/partial results render useful status and available evidence without crashing or inventing completion. Async detail fetches must clear previous-job state and ignore stale responses when switching jobs; a failed refresh must not present old evidence as fresh.
- Keep narrow sidebars usable around 360px wide: wrap metadata; confine horizontal scrolling to diff/log/raw regions; native accessible disclosure controls and clear headings.

## Verification and acceptance

Add meaningful fixture-based parser/UI tests for successful multi-file delivery, failed checks, running/partial/malformed evidence, raw JSON disclosure, check-log disclosure, review formatting, and stale results when switching jobs. Preserve existing navigation and graph tests. Run plugin npm run typecheck, env -u FABRO_GRAPH_TEST npm test, npm run build and git diff --check. Validate rendering with a browser screenshot at narrow width if available; record actual visual evidence or explicitly report its absence, never claim a browser check from jsdom.

The affected code is outside the canvas interaction-contract paths in AGENTS.md. No canvas contract/adapters are needed for this scope; exercise the new sidebar interactions with plugin UI tests. If scope would expand to canvas interaction-bearing paths, stop: declaration, verbatim RED before fixing, both Obs adapters, and independent RED/GREEN reproduction would be required.

Delivery must include a real scoped diff, completed Ralph task checklist and evidence for each work-order criterion. The originating thread independently reviews and records acceptance; acceptance does not land the commit.
