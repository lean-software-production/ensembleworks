import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: 'github-issue-card.spec.ts',
  use: { browserName: 'chromium', viewport: { width: 640, height: 480 }, locale: 'en-US', timezoneId: 'UTC' },
})
