# Unified `ensembleworks` CLI — design

- **Status: Superseded** (2026-07-05)
- **Superseded by:** [`../../unified-architecture-design.md`](../../unified-architecture-design.md)

This spec was merged into the unified architecture document (§6 for the
CLI, §2 for the Bun runtime consolidation, §7 for the migration
roadmap). Two things changed in the merge:

- The migration adopted a **big-bang cutover posture**: `bin/canvas`,
  routes, env names and live connections all break in one designated
  release (roadmap Phase 3) instead of the phased coexistence described
  here. Data import remains the hard requirement.
- The phased retirement ordering was re-sequenced into the unified
  roadmap (contracts → kernel split → cutover → registry completion →
  memory → plugin packages).

The pty spike results (Bun ≥ 1.3.14 `Bun.Terminal`, compiled-binary
tmux attach, arm64 cross-compile) carried over to §2.1 of the unified
doc. Prior content is in git history.
