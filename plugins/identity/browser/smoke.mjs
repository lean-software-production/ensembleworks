// Uses the repository's Vite/Playwright harness; never connects to a BB server.
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
const root = fileURLToPath(new URL('.', import.meta.url));
const server = await createServer({
  configFile: false, root,
  resolve: { alias: { '@get-bb/plugin-sdk/app': root + 'runtime.ts' }, dedupe: ['react', 'react-dom'] },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root + '../..'] } },
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  const artifacts = process.env.IDENTITY_SCREENSHOTS || '/tmp/identity-header-screenshots';
  await mkdir(artifacts, { recursive: true });
  for (const width of [320, 390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 720 }, hasTouch: width < 600 });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => { errors.push(error.message); console.error(error.message); });
    await page.goto(server.resolvedUrls.local[0]);
    const trigger = page.getByRole('button', { name: 'Started by Erin Example · team machine. Alex and Sam here; Sam is typing. Show thread details' });
    await expect(trigger).toBeVisible();
    const box = await trigger.boundingBox();
    expect(box.width).toBeLessThanOrEqual(60);
    expect(box.height).toBe(44);
    await expect(trigger.locator('[data-identity-bubble="owner"]')).toHaveText('EE');
    await expect(trigger.locator('[data-identity-bubble="viewer"]')).toHaveCount(2);
    await page.keyboard.press('Tab');
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveCSS('outline-style', 'solid');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Thread details' });
    await expect(dialog).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(dialog.locator('p')).toHaveText(await trigger.getAttribute('title'));
    await expect(dialog).toContainText('runs as ensembleworks-agent on shared-machine-');
    await expect(dialog).toContainText('would be refused — Erin Example\'s thread (audit mode, so it went through)');
    await expect(dialog).toContainText('Viewing now');
    await expect(dialog).toContainText('Alex');
    await expect(dialog).toContainText('Sam');
    await expect(dialog).toContainText('typing');
    await expect(page.getByRole('button', { name: 'Close thread details' })).toBeFocused();
    const bounds = await dialog.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(8);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 8);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: `${artifacts}/${width}.png` });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Space');
    await expect(dialog).toBeVisible();
    await page.getByRole('button', { name: 'Close thread details' }).click();
    await expect(trigger).toBeFocused();
    if (width < 600) await trigger.tap(); else await trigger.click();
    await expect(dialog).toBeVisible();
    await page.getByRole('button', { name: 'Outside', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Outside', exact: true })).toBeFocused();
    expect(errors).toEqual([]);
    console.log(`PASS ${width}px: compact owner/viewer bubbles, combined details, viewport bounds, keyboard, focus, touch/click and dismissal`);
    await context.close();
  }
  for (const width of [320, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 720 } });
    await page.goto(server.resolvedUrls.local[0] + '?variant=picker&screen=elsewhere');
    const prompt = page.getByRole('dialog', { name: 'Choose your identity' });
    await expect(prompt).toBeVisible();
    await expect(page.getByText('Another BB screen with no thread header')).toBeVisible();
    await expect(prompt.getByRole('combobox', { name: 'Your name' })).toBeVisible();
    await expect(prompt).toContainText('This does not verify who you are.');
    await expect(prompt.getByRole('button', { name: 'Use this name' })).toBeDisabled();
    const bounds = await prompt.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(8);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 8);
    expect(await prompt.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(prompt).toHaveCount(0);
    await page.reload();
    await expect(page.getByText('Another BB screen with no thread header')).toBeVisible();
    await expect(prompt).toHaveCount(0);
    await page.goto(server.resolvedUrls.local[0] + '?variant=picker');
    const trigger = page.getByRole('button', { name: /Show thread details/ });
    const details = page.getByRole('dialog', { name: 'Thread details' });
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(details).toBeVisible();
    await expect(details.getByRole('combobox', { name: 'Your name' })).toBeVisible();
    console.log(`PASS ${width}px picker: global prompt without thread header, dismissal survives reload, manual thread reopen`);
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 320, height: 720 } });
  for (const [variant, text] of [
    ['unknown', 'Starter not recorded'],
    ['automation', 'Started by an automation'],
    ['agent', 'Started by an agent for Erin Example'],
    ['own', 'Started by Erin Example'],
    ['conflict', 'renamed since it was pinned to Alex'],
  ]) {
    await page.goto(server.resolvedUrls.local[0] + '?variant=' + variant);
    const trigger = page.getByRole('button', { name: /Show thread details/ });
    await trigger.click();
    const detail = page.getByRole('dialog', { name: 'Thread details' }).locator('p');
    await expect(detail).toContainText(text);
    await expect(detail).toHaveText(await trigger.getAttribute('title'));
    console.log(`PASS ${variant}: popover preserves complete headerChip text`);
  }
  await page.close();
} finally {
  await browser?.close();
  await server.close();
}
