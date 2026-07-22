import { defineConfig } from '@playwright/test'

export default defineConfig({
	// Fresh server data dir per run → deterministic rooms for goldens. The dir
	// is created AND removed by scripts/start-server.ts itself, not here:
	// workers re-require this config, so a top-level mkdtempSync would leak one
	// temp dir per worker per run — and globalSetup can't hand the server a dir
	// either, because Playwright launches webServer commands during plugin
	// setup, before globalSetup runs.
	projects: [
		{ name: 'e2e', testDir: './tests' },
		{ name: 'perf', testDir: './perf', timeout: 120_000 },
	],
	fullyParallel: false, // one shared server; room-per-spec gives isolation
	workers: 1,
	retries: 0, // a flaky baseline is a broken baseline — fix, don't retry
	use: {
		baseURL: 'http://127.0.0.1:5273',
		viewport: { width: 1280, height: 720 },
		deviceScaleFactor: 1,
		colorScheme: 'light',
		locale: 'en-US',
		timezoneId: 'UTC',
		trace: 'retain-on-failure',
		// Task H1: copy/paste contracts (K1-K3) drive the REAL OS clipboard via
		// navigator.clipboard.writeText/readText — without this grant Chromium
		// throws NotAllowedError on the first clipboard call in a headless
		// context (no user gesture to imply permission).
		permissions: ['clipboard-read', 'clipboard-write'],
	},
	expect: {
		toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' },
	},
	// Goldens are Linux-only by convention — capture/update only on Linux
	// (devcontainer/CI), never a host Mac.
	snapshotPathTemplate: '{testDir}/../goldens/visual/{arg}{ext}',
	webServer: [
		{
			// start-server.ts creates its own temp data dir and deletes it on
			// shutdown. gracefulShutdown is required for that: Playwright's default
			// teardown is SIGKILL, which would skip the server's cleanup hook.
			command: 'bun scripts/start-server.ts',
			url: 'http://127.0.0.1:8788/api/health',
			reuseExistingServer: false,
			gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
		},
		{
			command: 'bunx vite --host 127.0.0.1 --port 5273 --strictPort',
			cwd: '../client',
			url: 'http://127.0.0.1:5273',
			reuseExistingServer: false,
		},
	],
})
