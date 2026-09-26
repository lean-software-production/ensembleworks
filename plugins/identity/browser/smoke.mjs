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
  // The People & machines settings section: every tab at three widths, the tabs' keys, and
  // the two gated dialogs. Disclosures are opened first, so what they hide is measured too.
  const tabs = [['people', 'People'], ['machines', 'Machines'], ['browser', 'This browser'], ['rules', 'Rules'], ['health', 'Health']];
  const describe = (el) => `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ').join('.') : ''} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40)}"`;
  for (const [width, scheme] of [[320, 'light'], [390, 'light'], [1280, 'light'], [390, 'dark']]) {
    const shot = (name) => `${artifacts}/settings-${scheme === 'dark' ? 'dark-' : ''}${width}-${name}.png`;
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: width < 600, colorScheme: scheme });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => { errors.push(error.message); console.error(error.message); });
    await page.goto(server.resolvedUrls.local[0] + '?screen=settings');
    const section = page.locator('.identity-settings');
    await expect(page.getByRole('tablist', { name: 'Identity settings' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Identity readiness' })).toBeVisible();
    for (const [key, name] of tabs) {
      const tab = page.getByRole('tab', { name, exact: true });
      if (width < 600) await tab.tap(); else await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      const panel = page.getByRole('tabpanel', { name });
      await expect(panel.getByRole('heading', { level: 3, name, exact: true })).toBeVisible();
      await panel.evaluate((el) => el.querySelectorAll('details').forEach((details) => { details.open = true; }));
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${width}px ${name}: page width`).toBe(width);
      const overflowing = await section.evaluate((root, describeSource) => {
        const label = new Function(`return ${describeSource}`)();
        return [...root.querySelectorAll('*')]
          .filter((el) => el.getClientRects().length > 0 && el.scrollWidth > el.clientWidth)
          .filter((el) => !(el.matches('pre, code') && getComputedStyle(el).overflowX === 'auto'))
          .map(label);
      }, describe.toString());
      expect(overflowing, `${width}px ${name}: elements wider than their box`).toEqual([]);
      // A checkbox or radio is reached through its label, so the label is the target measured.
      const small = await section.evaluate((root, describeSource) => {
        const label = new Function(`return ${describeSource}`)();
        return [...root.querySelectorAll('button, input, select')]
          .filter((el) => el.getClientRects().length > 0)
          .map((el) => (el.matches('[type="checkbox"], [type="radio"]') ? el.closest('label') ?? el : el))
          .filter((el) => el.getBoundingClientRect().height < 40)
          .map((el) => `${label(el)} ${el.getBoundingClientRect().height}px`);
      }, describe.toString());
      expect(small, `${width}px ${name}: targets under 40px`).toEqual([]);
      await page.screenshot({ path: shot(key), fullPage: true });
    }

    const people = page.getByRole('tab', { name: 'People', exact: true });
    if (width < 600) await people.tap(); else await people.click();
    await people.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Machines', exact: true })).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Machines', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: 'Health', exact: true })).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Health', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(people).toBeFocused();
    await expect(people).toHaveAttribute('aria-selected', 'true');

    await page.getByRole('tab', { name: 'Rules', exact: true }).click();
    const enforce = page.getByRole('radio', { name: 'Enforce' });
    if (width < 600) await enforce.tap(); else await enforce.click();
    const enforceDialog = page.getByRole('dialog', { name: 'Turn on Enforce?' });
    await expect(enforceDialog).toBeVisible();
    await expect(enforceDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    const enforceBounds = await enforceDialog.boundingBox();
    expect(enforceBounds.x).toBeGreaterThanOrEqual(8);
    expect(enforceBounds.x + enforceBounds.width).toBeLessThanOrEqual(width - 8);
    await page.screenshot({ path: shot('enforce-dialog') });
    await page.keyboard.press('Escape');
    await expect(enforceDialog).toHaveCount(0);
    await expect(page.getByRole('radio', { name: 'Audit' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'Audit' })).toBeFocused();
    await expect(enforce).not.toBeChecked();

    await page.getByRole('tab', { name: 'This browser', exact: true }).click();
    const rotate = page.getByRole('button', { name: 'Rotate signing key' });
    if (width < 600) await rotate.tap(); else await rotate.click();
    const rotateDialog = page.getByRole('dialog', { name: 'Rotate the signing key?' });
    await expect(rotateDialog).toBeVisible();
    await expect(rotateDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    const confirmRotate = rotateDialog.getByRole('button', { name: 'Rotate key' });
    await expect(confirmRotate).toBeDisabled();
    await rotateDialog.getByRole('textbox', { name: 'Type rotate to confirm' }).fill('rotat');
    await expect(confirmRotate).toBeDisabled();
    await rotateDialog.getByRole('textbox', { name: 'Type rotate to confirm' }).fill('rotate');
    await expect(confirmRotate).toBeEnabled();
    await page.screenshot({ path: shot('rotate-dialog') });
    await rotateDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(rotateDialog).toHaveCount(0);
    await expect(rotate).toBeFocused();

    expect(errors).toEqual([]);
    console.log(`PASS ${width}px ${scheme} settings: five tabs without overflow, 40px targets, tab keys, Enforce and rotate dialogs`);
    await context.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
