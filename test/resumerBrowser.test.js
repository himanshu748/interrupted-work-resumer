import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { startDeskServer } from '../src/desk/server.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'resumer-browser-')));
  await mkdir(path.join(root, 'website'));
  await writeFile(path.join(root, 'website', 'plan.md'), 'Review the release plan.\n');
  const running = await startDeskServer({ port: 0, workspaceRoot: root, dataRoot: path.join(root, 'data') });
  let browser;
  const errors = [];
  t.after(async () => {
    await browser?.close();
    await running.close();
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(errors, [], 'browser script and resource errors');
  });
  browser = await chromium.launch({ headless: true, timeout: 15000, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${running.url}/resumer`);
  await page.getByText('Save your goal and selected files to make a first checkpoint, or try the synthetic example.').waitFor();
  return { page, root };
}

test('browser creates, changes, compares, reopens, and downloads a synthetic continuation at desktop and mobile widths', { timeout: 90000 }, async (t) => {
  const { page } = await fixture(t);
  assert.equal(await page.getByRole('button', { name: 'Compare and prepare continuation', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Try example', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#change-example').disabled);
  await page.getByRole('button', { name: 'Change example files', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#notice').textContent.startsWith('Synthetic plan changed'));
  await page.getByRole('button', { name: 'Compare and prepare continuation', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#result-summary').textContent.includes('1 changed · 1 deleted · 0 unchanged'));
  assert.match(await page.locator('#artifact-preview').textContent(), /Unvalidated: Shared test account access is unverified/);
  assert.match(await page.locator('#artifact-preview').textContent(), /Next: prepare a public preview/);
  assert.match(await page.locator('#artifact-preview').textContent(), /review the revised accessibility requirements/);
  assert.match(await page.locator('#artifact-preview').textContent(), /Before \(checkpoint\)/);
  assert.match(await page.locator('#artifact-preview').textContent(), /After \(current file\)/);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download continuation (.md)' }).click();
  const download = await downloading;
  assert.equal(await download.failure(), null);
  const downloaded = await readFile(await download.path(), 'utf8');
  assert.match(downloaded, /Synthetic example/);
  assert.match(downloaded, /1 changed · 1 deleted · 0 unchanged/);
  await page.reload();
  await page.getByRole('button', { name: /Open continuation from/ }).click();
  await page.waitForFunction(() => !document.querySelector('#result').hidden);
  assert.equal(await page.locator('#artifact-preview').textContent(), downloaded);
  assert.match(await page.locator('#notice').textContent(), /observations have not been refreshed/);
  const screenshots = path.resolve('.impeccable/review/2026-09-29');
  await mkdir(screenshots, { recursive: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'desktop must not overflow horizontally');
  await page.screenshot({ path: path.join(screenshots, 'resumer-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile must not overflow horizontally');
  await page.screenshot({ path: path.join(screenshots, 'resumer-mobile.png'), fullPage: true });
  assert.equal(await page.getByRole('button', { name: 'Download continuation (.md)' }).isEnabled(), true);
});

test('browser checkpoints actual selected project files and displays user metadata as literal text', { timeout: 90000 }, async (t) => {
  const { page, root } = await fixture(t);
  await page.getByRole('textbox', { name: 'Project directory', exact: true }).fill('website');
  await page.getByRole('textbox', { name: 'Selected files', exact: true }).fill('plan.md');
  await page.getByRole('textbox', { name: 'Goal', exact: true }).fill('<img src=x onerror=alert(1)>');
  await page.getByRole('textbox', { name: 'Next action', exact: true }).fill('Review the plan.');
  await page.getByRole('button', { name: 'Save checkpoint', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#notice').textContent.startsWith('Checkpoint saved with 1'));
  assert.equal(await page.locator('#checkpoint-details img').count(), 0);
  assert.match(await page.locator('#checkpoint-details').textContent(), /<img src=x onerror=alert\(1\)>/);
  assert.equal(await page.getByRole('button', { name: 'Change example files', exact: true }).isDisabled(), true);
  await writeFile(path.join(root, 'website', 'plan.md'), 'Inspect the revised release requirements.\n');
  await page.getByRole('button', { name: 'Compare and prepare continuation', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#result-summary').textContent.includes('1 changed · 0 deleted · 0 unchanged'));
  assert.match(await page.locator('#artifact-preview').textContent(), /Review the release plan/);
  assert.match(await page.locator('#artifact-preview').textContent(), /Inspect the revised release requirements/);
  assert.equal(await readFile(path.join(root, 'website', 'plan.md'), 'utf8'), 'Inspect the revised release requirements.\n');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#checkpoint-select').options.length === 1 && !document.querySelector('#checkpoint-select').disabled);
  assert.match(await page.locator('#checkpoint-details').textContent(), /<img src=x onerror=alert\(1\)>/);
});
