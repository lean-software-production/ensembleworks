import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineConfig } from '@playwright/test'

// Fresh server data dir per run → deterministic rooms for goldens.
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ew-e2e-'))

export default defineConfig({
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
	},
	expect: {
		toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' },
	},
	snapshotPathTemplate: '{testDir}/../goldens/visual/{arg}{ext}',
	webServer: [
		{
			command: 'bun scripts/start-server.ts',
			url: 'http://127.0.0.1:8788/api/health',
			reuseExistingServer: false,
			env: { EW_E2E_DATA_DIR: dataDir },
		},
		{
			command: 'bunx vite --host 127.0.0.1 --port 5273 --strictPort',
			cwd: '../client',
			url: 'http://127.0.0.1:5273',
			reuseExistingServer: false,
		},
	],
})
