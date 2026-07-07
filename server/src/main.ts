// server/src/main.ts — the ensembleworks-server compile entry.
// `ensembleworks-server sync` (default) runs the sync/kernel server; `… term`
// runs the terminal gateway. Literal-specifier dynamic import() means bun bundles
// BOTH entrypoints into the binary but only the selected one's top-level executes
// (ES modules evaluate on first import) — so exactly one server.listen() fires.
//
// DELIBERATE exception to the connector spec's "static imports only" compile rule
// (#5 §8) — do NOT rewrite these to top-level `import` statements. The specifiers
// are string LITERALS, so `bun build --compile` resolves and embeds BOTH modules
// at bundle time (the 561-module count includes both entrypoints) — there is no
// runtime path resolution, which is what #5 §8 guards against. What the dynamic
// form buys is DEFERRED EVALUATION: a top-level `import './sync-server.ts'` +
// `import './terminal-gateway.ts'` would evaluate both modules and fire both
// server.listen() calls (double-bind, instant crash). Awaiting exactly one runs
// exactly one listener. Proven (spec §10.4) and load-bearing.
// Deviation from the plan's verbatim snippet: this file has no static import/
// export, so tsc treats it as a script (not a module) and rejects the
// top-level `await` below (TS1375). `export {}` is a no-op at runtime/bundle
// time (bun's bundler drops it) — it only flips tsc's module-detection so
// typecheck passes without touching the dynamic-import mechanism above.
export {}

const mode = process.argv[2] ?? 'sync'
if (mode === 'term') await import('./terminal-gateway.ts')
else if (mode === 'sync') await import('./sync-server.ts')
else {
	console.error(`ensembleworks-server: unknown mode '${mode}' (expected sync|term)`)
	process.exit(2)
}
