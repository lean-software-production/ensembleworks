// The canvas-v2 LOAD harness's own Playwright config — deliberately separate
// from playwright.config.ts.
//
// WHY A SEPARATE CONFIG: the shared config serves the client from the Vite DEV
// server. In dev the v2 module graph is hundreds of unbundled, individually
// transformed modules — there is no single ~4.3 MB CanvasV2App chunk to time,
// and loro-crdt's WASM arrives via the dep optimizer, not the production path.
// Timing "the lazy chunk" there would measure an artifact that does not exist
// in production, and dev-server module-fetch cost would dominate and
// mis-attribute the whole budget. Attribution IS this harness's purpose, so it
// must run against a real `vite build` served by `vite preview`. Folding that
// build into the shared config would tax every existing e2e run for nothing.
//
// PORTS: preview on 5274, deliberately NOT the shared rig's 5273 — the two
// configs must be runnable back-to-back without a stale-port collision. The
// sync server stays on 8788 (the preview proxy target, and what
// scripts/start-server.ts hardcodes).
import { defineConfig } from '@playwright/test'

export default defineConfig({
	testDir: './perf-load',
	// Load timing is the subject. Parallel workers would contend for CPU and
	// network and corrupt every number; retries would launder a flaky baseline
	// into a green one. Both off, matching playwright.config.ts's reasoning.
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 300_000,
	use: {
		baseURL: 'http://127.0.0.1:5274',
		viewport: { width: 1280, height: 720 },
		deviceScaleFactor: 1,
		colorScheme: 'light',
		locale: 'en-US',
		timezoneId: 'UTC',
		trace: 'off', // tracing perturbs exactly what is being measured
	},
	webServer: [
		{
			command: 'bun scripts/start-server.ts',
			url: 'http://127.0.0.1:8788/api/health',
			reuseExistingServer: false,
			gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
		},
		{
			// PRODUCTION build, served by preview. `--strictPort` so a busy port
			// fails loudly instead of silently serving from somewhere else and
			// producing numbers for the wrong bundle.
			command: 'bunx vite build && bunx vite preview --host 127.0.0.1 --port 5274 --strictPort',
			cwd: '../client',
			url: 'http://127.0.0.1:5274',
			reuseExistingServer: false,
			timeout: 300_000, // a cold `vite build` of this client is slow
		},
	],
})
