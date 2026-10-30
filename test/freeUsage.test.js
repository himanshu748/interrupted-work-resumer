import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFreeUsageGuard } from '../src/integrations/freeUsage.js';
import { createInferenceRuntime } from '../src/integrations/runtime.js';
import { generateNarration } from '../src/integrations/deepgramNarration.js';

const clock = Date.parse('2026-10-22T12:00:00.000Z');
const env = { DEEPGRAM_FREE_ONLY_CONFIRMED: 'true', DEEPGRAM_FREE_VERIFIED_AT: new Date(clock - 1000).toISOString(), DEEPGRAM_FREE_REQUEST_LIMIT: '3' };
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'free-usage-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, ledgerRoot: path.join(root, 'ledger') };
}

test('free-only settings fail closed without a fresh complete attestation and bounded allowance', async (t) => {
  const { root, ledgerRoot } = await fixture(t);
  for (const invalid of [{}, { ...env, DEEPGRAM_FREE_ONLY_CONFIRMED: 'yes' }, { ...env, DEEPGRAM_FREE_REQUEST_LIMIT: '0' },
    { ...env, DEEPGRAM_FREE_REQUEST_LIMIT: '101' }, { ...env, DEEPGRAM_FREE_VERIFIED_AT: 'not-a-date' },
    { ...env, DEEPGRAM_FREE_VERIFIED_AT: new Date(clock + 1000).toISOString() },
    { ...env, DEEPGRAM_FREE_VERIFIED_AT: new Date(clock - 86400000).toISOString() }]) {
    const guard = createFreeUsageGuard({ provider: 'deepgram', env: invalid, ledgerRoot, now: () => clock });
    assert.equal(guard.status().enabled, false);
    assert.equal(guard.status().providerBalanceVerified, false);
    assert.equal(guard.status().providerBillingControlled, false);
    await assert.rejects(guard.reserve({ operation: 'narration' }), { code: 'free_usage_not_confirmed' });
  }
  assert.deepEqual(await readdir(root), []);
});

test('concurrent reservations cannot exceed a persistent allowance and unknown outcomes never refund slots', async (t) => {
  const { ledgerRoot } = await fixture(t);
  const guards = Array.from({ length: 12 }, () => createFreeUsageGuard({ provider: 'deepgram', env, ledgerRoot, now: () => clock }));
  const results = await Promise.allSettled(guards.map((guard) => guard.reserve({ operation: 'narration' })));
  const accepted = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  assert.deepEqual(accepted.map((result) => result.slot).sort(), [1, 2, 3]);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === 'free_usage_limit_reached').length, 9);
  for (const reservation of accepted) {
    const stored = JSON.parse(await readFile(path.join(ledgerRoot, 'deepgram', `${reservation.slot}.json`), 'utf8'));
    assert.deepEqual(stored, reservation);
    assert.equal(stored.providerBalanceVerified, false);
  }
  // A process may die after file creation. Even an incomplete slot stays spent.
  await writeFile(path.join(ledgerRoot, 'deepgram/1.json'), '');
  const restarted = createFreeUsageGuard({ provider: 'deepgram', env: { ...env, DEEPGRAM_FREE_VERIFIED_AT: new Date(clock).toISOString() }, ledgerRoot, now: () => clock });
  await assert.rejects(restarted.reserve({ operation: 'narration' }), { code: 'free_usage_limit_reached' });
});

test('expiry is rechecked at reservation and unsafe ledger paths fail without disclosure', async (t) => {
  const { root, ledgerRoot } = await fixture(t);
  let now = clock;
  const guard = createFreeUsageGuard({ provider: 'deepgram', env, ledgerRoot, now: () => now });
  assert.equal(guard.status().enabled, true);
  now += 86400000;
  await assert.rejects(guard.reserve({ operation: 'narration' }), { code: 'free_usage_not_confirmed' });
  await symlink(root, ledgerRoot);
  const unsafe = createFreeUsageGuard({ provider: 'deepgram', env, ledgerRoot, now: () => clock });
  await assert.rejects(unsafe.reserve({ operation: 'narration' }), (error) => error.code === 'free_usage_ledger_unavailable' && !error.message.includes(root));
  assert.deepEqual(await readdir(root), ['ledger']);
});

test('separate processes share the same allowance instead of each getting a fresh budget', async (t) => {
  const { ledgerRoot } = await fixture(t);
  const script = `import { createFreeUsageGuard } from ${JSON.stringify(new URL('../src/integrations/freeUsage.js', import.meta.url).href)};
    const guard = createFreeUsageGuard({ provider: 'deepgram', env: ${JSON.stringify(env)}, ledgerRoot: ${JSON.stringify(ledgerRoot)}, now: () => ${clock} });
    try { await guard.reserve({ operation: 'narration' }); process.stdout.write('reserved'); }
    catch (error) { if (error.code !== 'free_usage_limit_reached') throw error; process.stdout.write('exhausted'); }`;
  const results = await Promise.all(Array.from({ length: 7 }, () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 15000 })));
  assert.equal(results.filter(({ stdout }) => stdout === 'reserved').length, 3);
  assert.equal(results.filter(({ stdout }) => stdout === 'exhausted').length, 4);
});

test('an explicit absolute environment ledger shares budgets across callers and refuses symlink paths', async (t) => {
  const { root, ledgerRoot } = await fixture(t);
  const shared = { ...env, FREE_USAGE_LEDGER_DIR: ledgerRoot, DEEPGRAM_FREE_REQUEST_LIMIT: '1' };
  const first = createFreeUsageGuard({ provider: 'deepgram', env: shared, now: () => clock });
  const second = createFreeUsageGuard({ provider: 'deepgram', env: { ...shared }, now: () => clock });
  assert.equal(first.status().ledgerScope, 'explicit-shared-directory');
  assert.ok(!JSON.stringify(first.status()).includes(root));
  await first.reserve({ operation: 'narration' });
  await assert.rejects(second.reserve({ operation: 'narration' }), { code: 'free_usage_limit_reached' });
  assert.throws(() => createFreeUsageGuard({ provider: 'deepgram', env: { ...env, FREE_USAGE_LEDGER_DIR: 'relative/path' } }), { code: 'invalid_ledger' });
  const link = path.join(root, 'linked');
  await symlink(ledgerRoot, link);
  const unsafe = createFreeUsageGuard({ provider: 'deepgram', env: { ...env, FREE_USAGE_LEDGER_DIR: link }, now: () => clock });
  await assert.rejects(unsafe.reserve({ operation: 'narration' }), { code: 'free_usage_ledger_unavailable' });
});

test('standalone live inference and narration are blocked before paid requests without free-only attestation', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, method: options.method ?? 'GET' });
    assert.ok(url.endsWith('/models?verbose=true'));
    return Response.json({ data: [{ id: 'nvidia/test-nemotron' }] });
  });
  const runtime = createInferenceRuntime({ env: { NEBIUS_API_KEY: 'fixture-secret' } });
  await assert.rejects(runtime.generate({ purpose: 'check', schemaName: 'check', schema: { type: 'object' }, system: 'Check', input: {} }), { code: 'free_usage_not_confirmed' });
  await assert.rejects(generateNarration({ text: 'Hello', maxCharacters: 5, apiKey: 'fixture-key' }, { env: {} }), { code: 'free_usage_not_confirmed' });
  assert.deepEqual(calls.map((call) => call.method), ['GET']);
});
