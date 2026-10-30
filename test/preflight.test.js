import test from 'node:test';
import assert from 'node:assert/strict';
import { runPreflight } from '../src/integrations/preflight.js';
import { chooseCandidateModel } from '../src/integrations/tokenFactory.js';

const model = 'nvidia/test-nemotron-nano';
test('preflight and runtime only select catalog NVIDIA Nemotron IDs', async () => {
  const catalog = [{ id: 'other/nemotron' }, { id: 'nvidia/unrelated' }, { id: 'other/unrelated', name: 'NVIDIA Nemotron' }, { id: model }];
  assert.equal(chooseCandidateModel(catalog).id, model);
  assert.equal(chooseCandidateModel(catalog, 'other/nemotron'), null);
  assert.equal(chooseCandidateModel(catalog, 'nvidia/unrelated'), null);
  const calls = [];
  const result = await runPreflight({ env: { NEBIUS_API_KEY: 'secret' }, fetchImpl: async (url) => { calls.push(url); return Response.json({ data: catalog }); } });
  assert.equal(result.liveInferenceVerified, false);
  assert.equal(result.candidateModel.id, model);
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('chat preflight uses the production JSON validator and retains an honest receipt', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.endsWith('/models?verbose=true') ? { data: [{ id: model }] }
      : { id: 'fixture-response', model, choices: [{ finish_reason: 'stop', message: { content: '{"result":"token-factory-preflight-ok"}' } }] });
  };
  const result = await runPreflight({ chat: true, env: { NEBIUS_API_KEY: 'secret' }, fetchImpl });
  assert.equal(result.status, 'fixture_inference_verified');
  assert.equal(result.liveInferenceVerified, false);
  assert.equal(result.liveChat.inference.transport, 'test-fixture');
  assert.equal(result.liveChat.inference.responseId, 'fixture-response');
  assert.match(result.liveChat.inference.outputSha256, /^[a-f0-9]{64}$/);
  const request = JSON.parse(calls[1].options.body);
  assert.equal(request.response_format.type, 'json_schema');
  assert.equal(request.response_format.json_schema.strict, true);
  assert.deepEqual(request.response_format.json_schema.schema.required, ['result']);
  assert.equal(request.max_tokens, 64);
  assert.equal(calls.length, 2);
});

test('arbitrary or partial chat output cannot become a successful preflight', async () => {
  for (const content of ['hello', '{"result":"wrong"}', '{"result":"token-factory-preflight-ok","extra":true}']) {
    let count = 0;
    await assert.rejects(runPreflight({ chat: true, env: { NEBIUS_API_KEY: 'secret' }, fetchImpl: async (url) => {
      count++;
      return Response.json(url.endsWith('/models?verbose=true') ? { data: [{ id: model }] }
        : { id: 'fixture-response', model, choices: [{ finish_reason: 'stop', message: { content } }] });
    } }));
    assert.equal(count, 2, 'Invalid output must not trigger retries.');
  }
});

test('provider failures cannot produce a successful preflight or disclose transport error text', async () => {
  for (const response of [
    async () => { throw new Error('secret-key private query'); },
    async () => new Response('secret-key private query', { status: 429 }),
    async () => new Response(new ReadableStream({ start(controller) { controller.error(Object.assign(new Error('secret-key private query'), { statusCode: 502 })); } })),
  ]) {
    let requests = 0;
    await assert.rejects(runPreflight({ chat: true, env: { NEBIUS_API_KEY: 'secret-key' }, fetchImpl: async (...args) => { requests++; return response(...args); } }),
      (error) => !/secret-key|private query/.test(error.message));
    assert.equal(requests, 1, 'Provider failure must not be retried.');
  }
});
