import test from 'node:test';
import assert from 'node:assert/strict';
import { createInferenceRuntime, hashStructuredOutput } from '../src/integrations/runtime.js';

const model = 'nvidia/test-nemotron-nano';
const schema = { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { type: 'string', enum: ['hold'] } } };
const input = { purpose: 'test', schemaName: 'safe_action', schema, system: 'Choose an action.', input: { evidence: 'PRIVATE_INPUT' } };
const completion = (changes = {}) => ({ id: 'test-response', model, choices: [{ finish_reason: 'stop', message: { content: '{"action":"hold"}' } }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }, ...changes });
function fixture({ env = {}, response = completion(), fetchImpl } = {}) {
  const calls = [];
  const runtime = createInferenceRuntime({ env: { NEBIUS_API_KEY: 'TEST_SECRET', ...env }, fetchImpl: fetchImpl ?? (async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.includes('/models?') ? { data: [{ id: 'other/unrelated' }, { id: model }] } : response);
  }) });
  return { runtime, calls };
}
test('status is local, contains no credential, and does not claim live access', async () => {
  const { runtime, calls } = fixture();
  const status = await runtime.handle('status', {});
  assert.equal(status.configured, true);
  assert.equal(status.liveAccessVerified, false);
  assert.equal(status.model, null);
  assert.equal(status.sandboxConfigured, false);
  assert.equal(calls.length, 0);
  assert.ok(!JSON.stringify(status).includes('TEST_SECRET'));
  await assert.rejects(runtime.handle('status', { key: 'x' }), /Unknown/);
});
test('discovered NVIDIA model is used with bounded JSON inference and honest fixture receipt', async () => {
  const { runtime, calls } = fixture();
  const result = await runtime.generate(input);
  assert.deepEqual(result.value, { action: 'hold' });
  assert.equal(result.inference.liveInferenceVerified, false);
  assert.equal(result.inference.transport, 'test-fixture');
  assert.match(result.inference.requestSha256, /^[a-f0-9]{64}$/);
  assert.match(result.inference.responseSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.inference.outputSha256, hashStructuredOutput({ action: 'hold' }));
  assert.equal(calls.length, 2);
  const request = JSON.parse(calls[1].options.body);
  assert.equal(request.model, model);
  assert.equal(calls[1].options.redirect, 'error');
  assert.deepEqual(request.response_format, { type: 'json_object' });
  assert.equal(request.max_tokens, 2048);
  assert.ok(!JSON.stringify(result).includes('TEST_SECRET'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_INPUT'));
  await runtime.generate(input);
  assert.equal(calls.length, 3, 'Catalog selection is reused without fallback calls');
});
test('credentials cannot be sent to a custom endpoint or undiscovered model', async () => {
  const wrongEndpoint = fixture({ env: { NEBIUS_BASE_URL: 'https://attacker.example/v1' } });
  await assert.rejects(wrongEndpoint.runtime.generate(input), /official Nebius/);
  assert.equal(wrongEndpoint.calls.length, 0);
  const wrongModel = fixture({ env: { NEBIUS_MODEL_ID: 'other/unrelated' } });
  await assert.rejects(wrongModel.runtime.generate(input), /available NVIDIA/);
  assert.equal(wrongModel.calls.length, 1);
  await assert.rejects(createInferenceRuntime({ env: {} }).generate(input), /not configured/);
});
test('schema violations, truncation, refusal, wrong model and malformed output fail closed', async () => {
  for (const response of [
    completion({ model: 'other/model' }), completion({ id: null }),
    completion({ choices: [{ finish_reason: 'length', message: { content: '{"action":"hold"}' } }] }),
    completion({ choices: [{ finish_reason: 'stop', message: { content: '{"action":"hold"}', refusal: 'no' } }] }),
    completion({ choices: [{ finish_reason: 'stop', message: { content: '```json\n{}\n```' } }] }),
    completion({ choices: [{ finish_reason: 'stop', message: { content: '{"action":"move"}' } }] }),
    completion({ choices: [{ finish_reason: 'stop', message: { content: '{"action":"hold","command":"rm"}' } }] }),
  ]) {
    await assert.rejects(fixture({ response }).runtime.generate(input));
  }
});
test('untrusted network errors never echo keys or prompt data', async () => {
  for (const fetchImpl of [async () => { throw new Error('TEST_SECRET PRIVATE_INPUT'); }, async () => new Response('TEST_SECRET PRIVATE_INPUT', { status: 401 }),
    async () => new Response(new ReadableStream({ start(controller) { controller.error(Object.assign(new Error('TEST_SECRET PRIVATE_INPUT'), { statusCode: 502 })); } })),
  ]) {
    await assert.rejects(fixture({ fetchImpl }).runtime.generate(input), (error) => !/TEST_SECRET|PRIVATE_INPUT/.test(error.message));
  }
});
test('requests and responses have size limits and active inference cannot overlap', async () => {
  const { runtime, calls } = fixture();
  await assert.rejects(runtime.generate({ ...input, input: 'x'.repeat(192 * 1024) }), /192 KiB/);
  assert.equal(calls.length, 0);
  const oversized = fixture({ fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1)) });
  await assert.rejects(oversized.runtime.generate(input), /size limit/);
  let release;
  const paused = fixture({ fetchImpl: async (url) => {
    if (url.includes('/models?')) return Response.json({ data: [{ id: model }] });
    await new Promise((resolve) => { release = resolve; });
    return Response.json(completion());
  } });
  const first = paused.runtime.generate(input);
  while (!release) await new Promise(setImmediate);
  await assert.rejects(paused.runtime.generate(input), (error) => error.statusCode === 409);
  release();
  await first;
});
