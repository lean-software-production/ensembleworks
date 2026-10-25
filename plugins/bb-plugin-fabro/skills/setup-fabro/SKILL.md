---
name: setup-fabro
description: Set up a project-specific starter set of Fabro pipelines, or recommend and scaffold workflows for a fresh project. Covers approved-plan implementation, code-quality refactoring, review-only and reproduced-bug repair. Not for running an existing workflow or ordinary feature implementation.
---

# Set up Fabro for a project

Guide the user from repository conventions to a small, working selection of project-owned workflows. Creating workflows never automatically submits a run. Preserve existing authorization: if the user already selected recipes, proceed; otherwise recommend a selection and ask which to create while inspecting the project.

## Discover and recommend

Run `node scripts/setup-project.mjs inspect /absolute/project` using the script next to this skill. It reports markers, package scripts, existing workflows and the catalog without executing project commands. Read repository instructions, CI and the actual test/build configuration; markers are hints, not proof of the right commands. Inspect workspace packages when the root delegates checks. Check the installed Fabro version, available environments and configured models (do not read or print credentials). Do not install or upgrade Fabro implicitly. If sandbox permissions or server connectivity prevent listing environments/models, report the unresolved check, preserve the configured model default, and do not claim execution readiness. Offline scaffolding and validation can still proceed.

Read `references/recipes.md` for recipe prerequisites and selection. Recommend the smallest set matching the user's work. For a typical tested codebase suggest implement-plan, refactor-code-quality, review-change and fix-bug; explain that the bug workflow needs a committed reproducer per task, and the plan workflow needs a committed approved plan. If a repository lacks meaningful checks, report that gap and help establish them within authorized scope instead of substituting `true`, `echo`, or invented commands. Do not infer new frameworks or paid services.

## Customize and create

Write a temporary JSON config with `recipes`, `scope`, `setupCommands`, `validationCommands`, `qualityCommand`, and optionally `environment` (defaults local). Commands run from the project root. Include package-manager frozen installs when appropriate, actual typecheck/test/build gates, and an appropriate quality check. Scope is explicit repo-relative paths. Do not include credentials in commands. Example shape (replace commands based on inspection):

```json
{"recipes":["refactor-code-quality","implement-plan"],"scope":["src","tests"],"setupCommands":["npm ci"],"validationCommands":["npm test","npm run build"],"qualityCommand":"git diff --check"}
```

Run `node scripts/setup-project.mjs create /absolute/project /absolute/config.json`. It copies pinned plugin-owned assets into `.fabro/workflows/<recipe>/`, refuses existing selected workflows, and writes manifest, workflow, runner, README and example work order. For an existing workflow inspect it and discuss the needed adaptation; never erase it to make scaffolding succeed. The catalog ships with the plugin; creation needs no upstream download. Customize generated prompts for project-specific conventions, checks, scope and review policy. Use only model IDs verified on the actual Fabro installation; leaving its configured model default is acceptable.

Generated work orders intentionally contain task-specific placeholders. They are templates, not ready submissions. Fill a concrete example when the user has supplied an objective; otherwise list exactly what remains to be chosen. The pipeworkflow definitions themselves should be complete and valid. Schema validity alone is not readiness: scan the chosen concrete work order for every `REPLACE_WITH` marker and verify referenced files, commands and commits before calling it ready. Do not invent a feature plan, review base or bug to make an example appear runnable.

## Verify and hand off

Compile input/output JSON Schemas using AJV draft-07; validate representative inputs with real task values or clearly identified isolated fixture values. Run `fabro validate <workflow>` with the installed CLI. Check the actual validation command syntax via `fabro --help` if needed. Exercise baseline and failing-check/budget behavior in an isolated temporary repository using the generated runner; for fix-bug include RED then GREEN with the same committed regression, and for review-change verify source edits are rejected. In a plugin development checkout with its npm dependencies installed, `npm run test:recipes` exercises all four recipes with no model calls; set `FABRO_BIN` to the installed CLI path to include graph validation. Installed-skill users can exercise the generated runners directly without the plugin development dependencies. Run project baseline commands only when authorized as part of setup, and inspect any side effects. A failed baseline is a setup gap, not a successful installation.

Keep project interaction-contract obligations in generated prompts/work orders: declare/extend contracts where required, run and record verbatim RED before the fix, stop if unreachable, implement Obs additions in both adapters, and require independent RED/GREEN review. For bug repair, the reproducer must already be committed and its paths are protected from edits; exclude it from baseline validation commands if needed while the rest of the baseline remains passing. Check test discovery: moving a `*.test.mjs` file to another directory may still include it in bare `node --test`. Use an explicit baseline test selection or a separately invoked reproducer outside the discovery pattern. Verify Node command syntax too: on Node 22, `node --test test/` treats the directory as a module; use supported file/glob selection or bare `node --test`.

Report created paths, selected environment (including the default `local`), selected commands, verification results and missing task inputs. Record provenance and customization in the generated README. Workflow files must be committed before submission; do not commit unrelated changes. For an explicitly requested run, switch to fabro-workflows and submit a complete frozen work order. Acceptance never automatically merges, pushes or deploys.
