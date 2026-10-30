import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_DEEPGRAM_MODEL, generateNarration, planNarration } from '../src/integrations/deepgramNarration.js';
import { runNarrationCli } from '../scripts/deepgram_narration.mjs';

const text = 'Show the observed result, then the evidence.';
const request = { text, maxCharacters: 100, apiKey: 'TEST_PRIVATE_KEY' };
const mp3 = Buffer.alloc(834);
Buffer.from([0xff, 0xfb, 0x90, 0x00]).copy(mp3, 0);
Buffer.from([0xff, 0xfb, 0x90, 0x00]).copy(mp3, 417);
const headers = {
  'content-type': 'audio/mpeg',
  'dg-model-name': DEFAULT_DEEPGRAM_MODEL,
  'dg-model-uuid': 'a04ff013-4ce1-4329-a8c8-b9b4e2b82346',
  'dg-request-id': '313c416c-d1ad-47b0-a24a-ea4fd4f49cb5',
  'dg-char-count': String(text.length),
};
const response = (body = mp3, overrides = {}) => new Response(body, { headers: { ...headers, ...overrides } });
const fixture = async () => response();

test('planning is bounded and contains hashes instead of source text', () => {
  const plan = planNarration({ text });
  assert.equal(plan.characters, text.length);
  assert.equal(plan.maxCharacters, null);
  assert.equal(plan.costVerified, false);
  assert.equal(plan.inputSha256, createHash('sha256').update(text).digest('hex'));
  assert.ok(!JSON.stringify(plan).includes(text));
  assert.equal(planNarration({ text: '😀' }).characters, 2);
  for (const invalid of [undefined, '', '  ', '\u0000', 'a'.repeat(2001)]) {
    assert.throws(() => planNarration({ text: invalid }));
  }
  for (const maxCharacters of [0, 2001, -1, 1.5, '100', NaN]) {
    assert.throws(() => planNarration({ text, maxCharacters }));
  }
  assert.throws(() => planNarration({ text, maxCharacters: 3 }), /allowance/);
  assert.throws(() => planNarration({ text, model: 'https://attacker.example' }), /verified model/);
});

test('a fixture generates an honest receipt and a single official bounded request', async () => {
  const calls = [];
  const { audio, receipt } = await generateNarration(request, { fetchImpl: async (...args) => { calls.push(args); return response(); } });
  assert.deepEqual(audio, mp3);
  assert.equal(receipt.transport, 'test-fixture');
  assert.equal(receipt.liveGenerationVerified, false);
  assert.equal(receipt.providerCharacters, text.length);
  assert.equal(receipt.audioSha256, createHash('sha256').update(mp3).digest('hex'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3');
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[0][1].headers.authorization, 'Token TEST_PRIVATE_KEY');
  assert.deepEqual(JSON.parse(calls[0][1].body), { text });
  assert.ok(!JSON.stringify(receipt).includes(request.apiKey));
  assert.ok(!JSON.stringify(receipt).includes(text));
});

test('generation requires credentials and an explicit allowance before transport', async () => {
  let calls = 0;
  for (const invalid of [{ ...request, apiKey: '' }, { ...request, maxCharacters: undefined }, { ...request, maxCharacters: 3 }]) {
    await assert.rejects(generateNarration(invalid, { fetchImpl: async () => { calls++; return response(); } }));
  }
  assert.equal(calls, 0);
});

test('provider, transport and interrupted stream errors are sanitized and never retried', async () => {
  for (const implementation of [
    async () => { throw new Error('TEST_PRIVATE_KEY private narration'); },
    async () => new Response('TEST_PRIVATE_KEY private narration', { status: 429 }),
    async () => response(new ReadableStream({ start(controller) { controller.error(new Error('TEST_PRIVATE_KEY private narration')); } })),
  ]) {
    let calls = 0;
    await assert.rejects(generateNarration(request, { fetchImpl: async (...args) => { calls++; return implementation(...args); } }),
      (error) => !/TEST_PRIVATE_KEY|private narration/.test(error.message));
    assert.equal(calls, 1);
  }
});

test('non-audio, truncated MP3 and missing or mismatched metadata fail closed', async () => {
  for (const getResponse of [
    () => response(mp3, { 'content-type': 'application/json' }),
    () => response('not audio'),
    () => response(Buffer.from('ID3')),
    () => response(mp3.subarray(0, 500)),
    () => response(mp3, { 'dg-request-id': '' }),
    () => response(mp3, { 'dg-request-id': 'TEST_PRIVATE_KEY' }),
    () => response(mp3, { 'dg-model-name': 'aura-asteria-en' }),
    () => response(mp3, { 'dg-char-count': '3000' }),
  ]) {
    await assert.rejects(generateNarration(request, { fetchImpl: async () => getResponse() }));
  }
  const tagged = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]), mp3]);
  assert.deepEqual((await generateNarration(request, { fetchImpl: async () => response(tagged) })).audio, tagged);
});

test('audio size is bounded even without a Content-Length header', async () => {
  for (const getResponse of [
    () => response(mp3, { 'content-length': String(10 * 1024 * 1024 + 1) }),
    () => response(Buffer.alloc(10 * 1024 * 1024 + 1)),
  ]) {
    await assert.rejects(generateNarration(request, { fetchImpl: async () => getResponse() }), /10 MiB/);
  }
});

async function workspace(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'deepgram-narration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'script with spaces.txt');
  const output = path.join(directory, 'clip with spaces.mp3');
  await writeFile(input, text);
  return { directory, input, output, args: ['--input', input, '--output', output] };
}

test('default CLI dry run performs no network and creates no files', async (t) => {
  const { directory, args } = await workspace(t);
  let calls = 0;
  let result;
  await runNarrationCli(args, { env: {}, fetchImpl: async () => { calls++; return response(); }, write: (value) => { result = JSON.parse(value); } });
  assert.equal(calls, 0);
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.networkRequests, 0);
  assert.equal(result.credentialConfigured, false);
  assert.deepEqual(await readdir(directory), ['script with spaces.txt']);
});

test('explicit fixture CLI generation publishes matching audio and receipt without temporary files', async (t) => {
  const { directory, output, args } = await workspace(t);
  await runNarrationCli([...args, '--generate', '--max-characters', '100'], { env: { DEEPGRAM_API_KEY: request.apiKey }, fetchImpl: fixture, write() {} });
  assert.deepEqual(await readFile(output), mp3);
  const receipt = JSON.parse(await readFile(`${output}.receipt.json`, 'utf8'));
  assert.equal(receipt.liveGenerationVerified, false);
  assert.equal(receipt.transport, 'test-fixture');
  assert.equal(receipt.audioSha256, createHash('sha256').update(await readFile(output)).digest('hex'));
  assert.equal((await readdir(directory)).length, 3);
  let calls = 0;
  await assert.rejects(runNarrationCli([...args, '--generate', '--max-characters', '100'], { env: { DEEPGRAM_API_KEY: request.apiKey }, fetchImpl: async () => { calls++; return response(); } }), /already exists/);
  assert.equal(calls, 0);
});

test('CLI blocks existing receipts, dangling symlinks, lock conflicts and missing allowance before network', async (t) => {
  const { output, args } = await workspace(t);
  let calls = 0;
  const dependencies = { env: { DEEPGRAM_API_KEY: request.apiKey }, fetchImpl: async () => { calls++; return response(); }, write() {} };
  await assert.rejects(runNarrationCli([...args, '--generate'], dependencies), /--max-characters/);
  await writeFile(`${output}.receipt.json`, 'existing');
  await assert.rejects(runNarrationCli([...args, '--generate', '--max-characters', '100'], dependencies), /already exists/);
  await rm(`${output}.receipt.json`);
  await symlink(`${output}.missing`, output);
  await assert.rejects(runNarrationCli([...args, '--generate', '--max-characters', '100'], dependencies), /already exists/);
  await rm(output);
  await writeFile(`${output}.lock`, 'existing');
  await assert.rejects(runNarrationCli([...args, '--generate', '--max-characters', '100'], dependencies), /lock/);
  assert.equal(calls, 0);
});

test('CLI cleans up its lock and publishes nothing when provider data fails validation', async (t) => {
  const { directory, args } = await workspace(t);
  await assert.rejects(runNarrationCli([...args, '--generate', '--max-characters', '100'], {
    env: { DEEPGRAM_API_KEY: request.apiKey }, fetchImpl: async () => response('invalid'), write() {},
  }), /MP3/);
  assert.deepEqual(await readdir(directory), ['script with spaces.txt']);
});

test('CLI rejects malformed UTF-8, duplicate flags and non-MP3 output', async (t) => {
  const { input, output, args } = await workspace(t);
  await assert.rejects(runNarrationCli([...args, '--generate', '--generate']), /duplicate/);
  await assert.rejects(runNarrationCli(['--input', input, '--output', `${output}.json`]), /\.mp3/);
  await writeFile(input, Buffer.from([0xc3, 0x28]));
  await assert.rejects(runNarrationCli(args), /UTF-8/);
});
