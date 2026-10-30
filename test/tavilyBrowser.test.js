import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { startDeskServer } from '../src/desk/server.js';
import { createTavilyService } from '../src/integrations/tavily.js';
import { createInferenceRuntime, hashStructuredOutput } from '../src/integrations/runtime.js';

test('standalone research journey render safe passages, require selections, recover saved evidence and respect keyboard/mobile/reduced motion', { timeout: 180000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tavily-browser-'));
  const searches = []; const inferences = [];
  const savedEvidence = new Map();
  let rejectCitation = false;
  const content = 'Inspect the documented failure condition before accepting success. <script>window.researchInjected = true</script>';
  const title = '<img src=x onerror="window.researchInjected=true"> Documentation reference';
  const model = 'nvidia/fixture-nemotron';
  const runtime = createInferenceRuntime({ env: { NEBIUS_API_KEY: 'fixture-key' }, fetchImpl: async (url, options) => {
    if (url.endsWith('/models?verbose=true')) return Response.json({ data: [{ id: model }] });
    const request = JSON.parse(options.body);
    const input = JSON.parse(request.messages[1].content); inferences.push(input);
    const statement = { text: 'Review the failure condition in the selected reference.', citations: [{ sourceId: input.sources[0].id, quote: 'Inspect the documented failure condition before accepting success.' }] };
    if (rejectCitation) statement.citations[0].quote = 'UNTRUSTED_PRIVATE_OUTPUT';
    return Response.json({ id: 'fixture-nemotron-research', model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: statement, checks: [statement], questions: [] }) } }], usage: { total_tokens: 80 } });
  } });
  const running = await startDeskServer({ port: 0, workspaceRoot: root, dataRoot: path.join(root, 'data'), inferenceRuntime: runtime,
    factories: { research: (options) => createTavilyService({ ...options, env: { TAVILY_API_KEY: 'fixture-key' }, fetchImpl: async (url, options) => {
      const input = JSON.parse(options.body); searches.push(input);
      return Response.json({ request_id: `fixture-search-${searches.length}`, query: input.query, usage: { credits: 1 }, results: [
        { title, url: 'https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html', content },
        { title: 'An unselected source', url: 'https://docs.tavily.com/documentation/api-reference/endpoint/search', content: 'Never automatically include this unselected passage.' },
      ] });
    } }) } });
  let browser;
  t.after(async () => { await browser?.close(); await running.close(); await rm(root, { recursive: true, force: true }); });
  browser = await chromium.launch({ headless: true, timeout: 20000, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const screenshots = process.env.TAVILY_SCREENSHOT_DIR;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  for (const mobile of [false, true]) {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1080 });
    await page.emulateMedia({ reducedMotion: mobile ? 'reduce' : 'no-preference' });
    for (const product of ['resumer']) {
      const previousSearches = searches.length;
      await page.goto(`${running.url}/${product}${product === 'route' ? '/' : ''}`);
      await page.locator('#research-status').getByText('Fixture transport. Searches here do not verify live Tavily access.', { exact: true }).waitFor();
      assert.equal(searches.length, previousSearches, 'page load must never initiate a provider search');
      const panel = page.locator('#research-panel');
      const query = page.getByRole('textbox', { name: /documentation query/ });
      await query.fill(`${product} failure handling documentation`);
      assert.equal(await page.locator('#research-search').isDisabled(), true);
      await query.press('Tab');
      assert.equal(await page.locator('#research-search-consent').evaluate((node) => node === document.activeElement), true);
      await page.keyboard.press('Space');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await page.locator('#research-feedback').getByText(/2 sources returned.*Fixture response/).waitFor();
      assert.equal(searches.length, previousSearches + 1);
      assert.equal(await page.locator('#research-search-consent').isChecked(), false);
      assert.equal(await page.locator('#research-brief').isDisabled(), true);
      assert.equal(await panel.locator('img, script').count(), 0);
      assert.equal(await page.evaluate(() => window.researchInjected), undefined);
      assert.match(await page.locator('#research-results').textContent(), /<script>window.researchInjected/);
      const link = page.locator('#research-results a').first();
      assert.equal(await link.getAttribute('target'), '_blank');
      assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
      const afterSearch = searches.length; const beforeBrief = inferences.length;
      await page.reload();
      await page.locator('#research-feedback').getByText(/Restored saved sources from this device/).waitFor();
      assert.equal(searches.length, afterSearch, 'Reload restores saved sources without another search credit');
      assert.equal(inferences.length, beforeBrief, 'Restoring sources cannot generate a model checklist');
      assert.equal(await query.inputValue(), `${product} failure handling documentation`);
      assert.equal(await page.locator('#research-search-consent').isChecked(), false);
      assert.equal(await page.locator('#research-model-consent').isChecked(), false);
      assert.equal(await page.locator('#research-search').isDisabled(), true);
      await page.getByLabel('Select S1', { exact: true }).focus();
      await page.keyboard.press('Space');
      await page.locator('#research-model-consent').focus();
      await page.keyboard.press('Space');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await page.locator('#research-feedback').getByText('Cited checklist saved locally. No saved action ran or blocker was resolved.', { exact: true }).waitFor();
      assert.equal(inferences.at(-1).product, product);
      assert.equal(inferences.at(-1).sources.length, 1);
      assert.doesNotMatch(JSON.stringify(inferences.at(-1)), /unselected passage/);
      assert.match(await page.locator('#research-checklist').textContent(), /Live inference not verified/);
      assert.equal(await page.locator('#research-quotation-warning').count(), 0, 'Substantive citations keep the general review boundary without a fragment warning');
      assert.equal(await page.locator('#research-model-consent').isChecked(), false);
      const downloaded = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download research evidence JSON', exact: true }).click();
      const evidence = JSON.parse(await readFile(await (await downloaded).path(), 'utf8'));
      savedEvidence.set(product, evidence);
      assert.equal(evidence.version, 4);
      assert.equal(evidence.searchReceipt.liveSearchVerified, false);
      assert.equal(evidence.inference.liveInferenceVerified, false);
      assert.equal(evidence.actionExecuted, false);
      assert.equal(evidence.sources.length, 1);
      const afterBrief = inferences.length;
      await page.reload();
      await page.locator('#research-feedback').getByText(/Restored saved checklist and sources from this device/).waitFor();
      assert.equal(searches.length, afterSearch);
      assert.equal(inferences.length, afterBrief, 'Reload reuses the saved inference receipt');
      assert.equal(await page.getByLabel('Select S1', { exact: true }).isChecked(), true);
      assert.equal(await page.getByLabel('Select S2', { exact: true }).isChecked(), false);
      assert.equal(await page.locator('#research-model-consent').isChecked(), false);
      assert.equal(await page.locator('#research-brief').isDisabled(), true);
      const restoredDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download research evidence JSON', exact: true }).click();
      assert.deepEqual(JSON.parse(await readFile(await (await restoredDownload).path(), 'utf8')), evidence, 'Recovered evidence retains the exact original receipt and output');
      await page.getByRole('combobox', { name: 'Saved research', exact: true }).selectOption(evidence.searchId);
      await page.getByRole('button', { name: 'Open saved research', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.locator('#research-feedback').getByText(/Restored saved sources from this device/).waitFor();
      assert.equal(await page.locator('#research-checklist').isHidden(), true);
      await page.getByRole('combobox', { name: 'Saved research', exact: true }).selectOption(evidence.id);
      await page.getByRole('button', { name: 'Open saved research', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.locator('#research-feedback').getByText(/Restored saved checklist and sources from this device/).waitFor();
      assert.equal(searches.length, afterSearch);
      assert.equal(inferences.length, afterBrief, 'History navigation cannot replay either provider action');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${product} at ${mobile ? 'mobile' : 'desktop'} overflows`);
      if (mobile) assert.equal(await panel.evaluate((node) => node.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length), 0);
      if (screenshots) await panel.screenshot({ path: path.join(screenshots, `${product}-${mobile ? 'mobile' : 'desktop'}.png`) });
    }
  }
  rejectCitation = true;
  await page.locator('#research-model-consent').check();
  await page.locator('#research-brief').click();
  await page.locator('#research-feedback').getByText(/Nebius output failed the cited_research_checks schema/).waitFor();
  const failedReceipts = page.locator('#research-failures');
  await failedReceipts.getByText('1 saved failed checklist attempt', { exact: true }).waitFor();
  await page.reload();
  await page.locator('#research-feedback').getByText(/Restored saved checklist and sources from this device/).waitFor();
  await failedReceipts.locator('summary').focus();
  await page.keyboard.press('Enter');
  assert.match(await failedReceipts.locator('pre').textContent(), /schema-mismatch/);
  assert.match(await failedReceipts.locator('pre').textContent(), /not_verified/);
  assert.doesNotMatch(await failedReceipts.locator('pre').textContent(), /UNTRUSTED_PRIVATE_OUTPUT/);
  assert.equal(await page.locator('#research-model-consent').isChecked(), false);
  assert.equal(searches.length, 2);
  assert.equal(inferences.length, 3, 'One explicit rejected fixture attempt is retained, never retried on reload');

  // Reproduce old weak citations using isolated local fixture receipts only.
  // Loading a warning must not repair, rewrite, or replay the historical output.
  for (const [product, template] of savedEvidence) {
    for (const version of [2, 3]) {
      const quote = version === 2 ? '# Keyboard navigation' : '1.';
      const savedSearch = JSON.parse(await readFile(path.join(root, 'data', 'research', `${template.searchId}.json`), 'utf8'));
      savedSearch.id = randomUUID();
      savedSearch.query = 'Historical weak quotation fixture';
      savedSearch.results = [{ ...savedSearch.results[0], title: 'Keyboard documentation', content: '1. Keep focus visible.\n# Keyboard navigation' }];
      savedSearch.receipt.completedAt = new Date().toISOString();
      savedSearch.receipt.outputSha256 = hashStructuredOutput({ product, query: savedSearch.query, results: savedSearch.results });
      const legacy = structuredClone(template);
      legacy.id = randomUUID(); legacy.version = version; legacy.createdAt = new Date().toISOString();
      legacy.searchId = savedSearch.id; legacy.query = savedSearch.query; legacy.sources = savedSearch.results; legacy.searchReceipt = savedSearch.receipt;
      legacy.quoteChoices = [{ sourceId: 'S1', quotes: version === 2 ? ['1.', 'Keep focus visible.', '# Keyboard navigation'] : ['1.', 'Keep focus visible.'] }];
      for (const statement of [legacy.brief.summary, ...legacy.brief.checks, ...legacy.brief.questions]) statement.citations = [{ sourceId: 'S1', quote }];
      legacy.inference.outputSha256 = hashStructuredOutput(legacy.brief);
      legacy.disclosure.payloadSha256 = hashStructuredOutput({ product, question: legacy.query, sources: legacy.sources, quoteChoices: legacy.quoteChoices });
      const legacyFile = path.join(root, 'data', 'research', `${legacy.id}.json`);
      const original = JSON.stringify(legacy);
      await writeFile(path.join(root, 'data', 'research', `${savedSearch.id}.json`), JSON.stringify(savedSearch));
      await writeFile(legacyFile, original);
      await page.setViewportSize(version === 2 ? { width: 1440, height: 1080 } : { width: 390, height: 844 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`${running.url}/${product}${product === 'route' ? '/' : ''}`);
      await page.locator('#research-quotation-warning').getByText('Weak quotations detected; do not use these claims until reviewed.', { exact: true }).waitFor();
      assert.match(await page.locator('#research-checklist').textContent(), /semantic correctness still needs your review/);
      assert.equal(await page.locator('#research-model-consent').isChecked(), false);
      const historicalDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download research evidence JSON', exact: true }).click();
      assert.deepEqual(JSON.parse(await readFile(await (await historicalDownload).path(), 'utf8')), legacy, 'The warning is derived; exported historical evidence stays unchanged');
      await page.reload();
      await page.locator('#research-quotation-warning').waitFor();
      assert.equal(await readFile(legacyFile, 'utf8'), original, 'Viewing the warning never rewrites stored evidence');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${product} warning overflows`);
      assert.equal(await page.locator('#research-panel').evaluate((node) => node.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length), 0);
      assert.equal(searches.length, 2);
      assert.equal(inferences.length, 3, 'Restoring weak legacy quotations must not retry a provider action');
    }
  }
  assert.deepEqual(errors, []);
});
