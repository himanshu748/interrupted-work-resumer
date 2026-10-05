import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { startDeskServer } from '../src/desk/server.js';
import { createInferenceRuntime } from '../src/integrations/runtime.js';

test('standalone home leads to working UI with local assets and no sibling navigation', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'standalone-browser-'));
  const running = await startDeskServer({ port: 0, workspaceRoot: root, inferenceRuntime: createInferenceRuntime({ env: {}, fetchImpl: () => { throw Error('No provider calls.'); } }) });
  let browser;
  t.after(async () => { await browser?.close(); await running.close(); await rm(root, { recursive: true, force: true }); });
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const errors = [], external = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => {
    if (!request.url().startsWith(running.url) && !request.url().startsWith('data:')) external.push(request.url());
    if (request.method() !== 'GET') writes.push(request.url());
  });
  await page.goto(running.url + '/');
  assert.equal(await page.locator('h1').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const image = page.locator('figure img').first();
  await image.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => [...document.querySelectorAll('figure img')].some(image => image.naturalWidth > 0));
  for (const href of await page.locator('a[href]').evaluateAll(links => links.map(link => link.getAttribute('href'))))
    assert.ok(href.startsWith('#') || href === '/' || href === '/products/resumer' || href === '/resumer' || href.startsWith('/product-evidence/'), 'Unexpected sibling or external link: ' + href);
  assert.deepEqual(writes, [], 'Landing must not call APIs');
  await page.locator('a[href="/resumer"]').first().click();
  await page.waitForURL(running.url + '/resumer');
  await page.getByRole('button', { name: 'Try example', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
});
