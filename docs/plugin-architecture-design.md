# Plugin architecture — kernel, capability registries, and project memory

- **Status: Superseded** (2026-07-05)
- **Superseded by:** [`unified-architecture-design.md`](./unified-architecture-design.md)

This design was merged into the unified architecture document, which
combines it with the `ensembleworks` CLI design and owns the single
migration roadmap. The merge also amended three decisions made here:

- Terminal gateway: ~~Go~~ → TypeScript on Bun (shared `Bun.Terminal`
  session manager; the gateway-go spike is retired).
- Runtime: ~~Node~~ → Bun everywhere, with CI-compiled binaries on
  servers (no JS runtime on prod hosts).
- Agent CLI: ~~TypeScript generated from contracts at build time~~ →
  one compiled `ensembleworks` binary that renders the server's
  `/api/tools` manifest at runtime.

All other content (kernel + capability registries, plugin manifest,
memory service, tool registry / MCP) carried over intact — see the
unified doc. Prior content is in git history
(`git log -- docs/plugin-architecture-design.md`).
