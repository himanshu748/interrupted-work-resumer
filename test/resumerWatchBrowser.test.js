import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { startDeskServer } from '../src/desk/server.js';
import { createResumerService } from '../src/resumer/service.js';
import { createInferenceRuntime } from '../src/integrations/runtime.js';

test('browser explicitly enables a local watch, opens its continuation, and preserves state across restart', { timeout: 90000 }, async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'watch-browser-'));
  const tasks = new Map();
  let sequence = 0;
  let timestamp = Date.parse('2026-09-29T12:00:00Z');
  const scheduler = { now: () => timestamp,
    setTimeout(callback, delay) { assert.ok(delay >= 30000); const id = ++sequence; tasks.set(id, callback); return id; },
    clearTimeout(id) { tasks.delete(id); },
  };
  const tick = async () => { timestamp += 30000; for (const [id, callback] of [...tasks]) { tasks.delete(id); await callback(); } };
  const config = { port: 0, workspaceRoot, dataRoot: path.join(workspaceRoot, 'data'),
    inferenceRuntime: createInferenceRuntime({ env: {} }),
    factories: { resumer: (input) => createResumerService({ ...input, scheduler }) } };
  let running = await startDeskServer(config);
  let browser;
  t.after(async () => { await browser?.close(); await running.close(); await rm(workspaceRoot, { recursive: true, force: true }); });
  browser = await chromium.launch({ headless: true, timeout: 15000, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(running.url + '/resumer');
  await page.getByRole('button', { name: 'Try example', exact: true }).click();
  await page.locator('#notice').getByText(/Synthetic checkpoint saved/).waitFor();
  assert.equal(tasks.size, 0);
  assert.equal(await page.locator('#enable-watch').isDisabled(), true);
  await page.locator('#watch-consent').check();
  await page.locator('#enable-watch').click();
  await page.locator('#watch-status').getByText(/Enabled while the desk is running/).waitFor();
  assert.equal(tasks.size, 1);
  assert.equal(await page.locator('#watch-consent').isChecked(), false);
  await page.getByRole('button', { name: 'Change example files', exact: true }).click();
  await page.locator('#notice').getByText(/Synthetic plan changed/).waitFor();
  await tick();
  await page.locator('#refresh-watch').click();
  await page.locator('#notice').getByText('Local watch status refreshed.', { exact: true }).waitFor();
  await page.locator('#open-watch-artifact').click();
  await page.locator('#notice').getByText(/Opened the saved local watch continuation/).waitFor();
  assert.match(await page.locator('#result-summary').textContent(), /1 changed · 1 deleted/);
  assert.match(await page.locator('#artifact-preview').textContent(), /No model ran and no saved action was executed/);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download').click();
  const download = await downloadPromise;
  assert.match(await readFile(await download.path(), 'utf8'), /Prepared automatically by the local file watch/);
  await running.close();
  assert.equal(tasks.size, 0);
  running = await startDeskServer(config);
  await page.goto(running.url + '/resumer');
  await page.locator('#watch-status').getByText(/Enabled while the desk is running/).waitFor();
  await tick();
  await page.locator('#refresh-watch').click();
  await page.locator('#notice').getByText('Local watch status refreshed.', { exact: true }).waitFor();
  assert.equal(await page.locator('#artifact-list button').count(), 1);
  await page.locator('#disable-watch').click();
  await page.locator('#watch-status').getByText(/^Disabled/).waitFor();
  assert.equal(tasks.size, 0);
  await page.reload();
  await page.locator('#watch-status').getByText(/^Disabled/).waitFor();
  assert.equal(await page.locator('#disable-watch').isDisabled(), true);
  assert.equal(await page.locator('#open-watch-artifact').isEnabled(), true);
  assert.deepEqual(errors, []);
});
