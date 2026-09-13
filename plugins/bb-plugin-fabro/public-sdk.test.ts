import { expect, it } from 'vitest';
import { experimental_scanPublicSdkOnly } from '@get-bb/plugin-sdk/testing';
import { fileURLToPath } from 'node:url';
it('uses only public BB SDK surfaces', async () => {
  const report = await experimental_scanPublicSdkOnly(fileURLToPath(new URL('.', import.meta.url)), {
    allow: [/^ajv$/, /^react$/, /^@testing-library\/react$/, /^@radix-ui\/react-slot$/, /^class-variance-authority$/,
      /^@hugeicons\/(react|core-free-icons)$/, /^better-sqlite3$/, /^clsx$/, /^tailwind-merge$/, /^vitest\/config$/],
  });
  expect(report.violations).toEqual([]);
  expect(report.privateDependencies).toEqual([]);
});
