import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';
import { createTavilyService, safeResearchUrl } from '../src/integrations/tavily.js';
import { hashStructuredOutput } from '../src/integrations/runtime.js';

const input = { product: 'resumer', query: 'Vendor error contract documentation', consent: true };
const result = () => ({ query: input.query, request_id: 'fixture-search-001', usage: { credits: 1 }, results: [
  { title: 'Provider error reference', url: 'https://docs.tavily.com/documentation/api-reference/endpoint/search', content: 'An invalid request returns a validation error. Check the response status before accepting a result.', score: 0.9 },
  { title: 'Second reference', url: 'https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html', content: 'This other source was not selected.' },
] });
async function fixture(t, options = {}) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'tavily-research-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const calls = [];
  const service = await createTavilyService({ dataRoot, env: { TAVILY_API_KEY: 'fixture-secret' }, fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json(result()); }, ...options });
  return { service, calls, dataRoot };
}
function modelValue(request) {
  const source = request.input.sources[0];
  const statement = { text: 'Review how the integration handles validation errors.', citations: [{ sourceId: source.id, quote: 'An invalid request returns a validation error.' }] };
  return { summary: statement, checks: [structuredClone(statement)], questions: [] };
}
function modelResponse(value) {
  return { value, inference: { provider: 'nebius-token-factory', model: 'nvidia/fixture-nemotron', responseId: 'fixture-inference', outputSha256: hashStructuredOutput(value), liveInferenceVerified: false, transport: 'test-fixture' } };
}

test('Tavily uses one explicit basic query with bounded results, usage and fixture provenance', async (t) => {
  const { service, calls, dataRoot } = await fixture(t);
  const status = await service.handle('status');
  assert.equal(calls.length, 0);
  assert.equal(status.liveAccessVerified, false);
  assert.equal(status.funding.providerBalanceVerified, false);
  assert.doesNotMatch(JSON.stringify(status), /fixture-secret/);
  const search = await service.handle('search', input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.tavily.com/search');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(calls[0].options.body), { query: input.query, topic: 'general', search_depth: 'basic', max_results: 5, chunks_per_source: 2,
    auto_parameters: false, include_answer: false, include_raw_content: false, include_images: false, include_favicon: false, include_usage: true });
  assert.equal(search.receipt.liveSearchVerified, false);
  assert.equal(search.receipt.transport, 'test-fixture');
  assert.equal(search.receipt.freeUsage, null);
  assert.equal(search.receipt.usage.credits, 1);
  assert.equal(search.receipt.outputSha256, hashStructuredOutput({ product: input.product, query: input.query, results: search.results }));
  assert.equal((await readdir(path.join(dataRoot, 'research'))).length, 1);
  const reopened = await createTavilyService({ dataRoot, env: {} });
  assert.deepEqual(await reopened.handle('record', { id: search.id }), search);
});

test('missing credentials, absent or expired free-only funding, and custom endpoints cannot send a request', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('A live transport must never be reached by this test'); });
  for (const env of [{}, { TAVILY_API_KEY: 'fixture-key' }, { TAVILY_API_KEY: 'fixture-key', TAVILY_FREE_ONLY_CONFIRMED: 'true', TAVILY_FREE_VERIFIED_AT: '2020-01-01T00:00:00.000Z', TAVILY_FREE_REQUEST_LIMIT: '1' }, { TAVILY_API_KEY: 'fixture-key', TAVILY_BASE_URL: 'https://attacker.example/search' }]) {
    const { service } = await fixture(t, { env, fetchImpl: undefined });
    assert.equal(service.status().available, false);
    await assert.rejects(service.handle('search', input), /TAVILY_API_KEY|blocked|official search endpoint/);
  }
  assert.equal(calls, 0);
});

test('research refuses automatic disclosures, nonconsensual requests and unsupported controls before fetching', async (t) => {
  const { service, calls } = await fixture(t);
  for (const patch of [{ consent: false }, { query: '' }, { query: 'x'.repeat(501) }, { product: 'any-project' }, { quote: { private: true } }, { search_depth: 'advanced' }, { auto_parameters: true }, { max_results: 20 }]) {
    await assert.rejects(service.handle('search', { ...input, ...patch }));
  }
  assert.equal(calls.length, 0);
});

test('source links reject executable schemes, credentials, IPs, local names and malformed URLs', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'http://docs.nvidia.com/', 'https://127.0.0.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://10.0.0.1/', 'https://169.254.169.254/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://localhost/', 'https://name.local/', 'https://metadata.google.internal/', 'https://user:pass@docs.nvidia.com/', 'https://docs.nvidia.com:8443/', 'https://docs.nvidia.com/a b', 'https://docs.nvidia.com\\@evil.com/', 'not a URL']) assert.throws(() => safeResearchUrl(url), /unsupported source URL/, url);
  assert.equal(safeResearchUrl('https://docs.nvidia.com/nim/?a=1&b=2#reference'), 'https://docs.nvidia.com/nim/?a=1&b=2#reference');
});

test('provider failures, oversized bodies, malformed receipts and unsafe results fail without retries or fallback', async (t) => {
  const responses = [
    () => new Response('secret provider detail', { status: 429 }),
    () => new Response('not json'),
    () => new Response(new ReadableStream({ start(controller) { controller.error(Object.assign(new Error('fixture-secret private query material'), { statusCode: 502 })); } })),
    () => new Response('x'.repeat(512 * 1024 + 1)),
    () => Response.json({ ...result(), usage: undefined }),
    () => Response.json({ ...result(), usage: { credits: 2 } }),
    () => Response.json({ ...result(), request_id: undefined }),
    () => Response.json({ ...result(), results: Array(6).fill(result().results[0]) }),
    () => Response.json({ ...result(), results: [{ ...result().results[0], url: 'javascript:alert(1)' }] }),
    () => { throw new Error('fixture-secret: private query material'); },
  ];
  for (const response of responses) {
    let calls = 0;
    const { service, dataRoot } = await fixture(t, { fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(service.handle('search', input), (error) => !/fixture-secret|secret provider detail|private query material/.test(error.message));
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(path.join(dataRoot, 'research')), []);
  }
});

test('overlapping searches cannot consume a second provider request', async (t) => {
  let complete; let calls = 0;
  const { service } = await fixture(t, { fetchImpl: async () => { calls++; return new Promise((resolve) => { complete = resolve; }); } });
  const first = service.handle('search', input);
  await assert.rejects(service.handle('search', input), /already running/);
  assert.equal(calls, 1);
  complete(Response.json(result()));
  await first;
});

test('Nemotron receives selected passages only, validates literal citations and records separate output proof', async (t) => {
  const requests = [];
  const { service } = await fixture(t, { inferenceRuntime: { async generate(request) { requests.push(request); return modelResponse(modelValue(request)); } } });
  const search = await service.handle('search', { ...input, product: 'resumer' });
  const request = { searchId: search.id, selectedSourceIds: ['S1'], consent: true };
  for (const changes of [{ consent: false }, { selectedSourceIds: [] }, { selectedSourceIds: ['S1', 'S1'] }, { selectedSourceIds: ['S3'] }, { privateQuote: 'not sent' }]) await assert.rejects(service.handle('brief', { ...request, ...changes }));
  assert.equal(requests.length, 0);
  const brief = await service.handle('brief', request);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].maxTokens, 1800);
  assert.equal(requests[0].purpose, 'resumer-web-research');
  assert.match(requests[0].system, /Do not claim saved tasks ran/);
  assert.match(requests[0].system, /untrusted data/);
  assert.match(requests[0].system, /directly support the specific claim/);
  assert.match(requests[0].system, /does not establish that this product uses it/);
  assert.doesNotMatch(JSON.stringify(requests[0].input), /This other source was not selected/);
  assert.deepEqual(Object.keys(requests[0].input).sort(), ['product', 'question', 'quoteChoices', 'sources']);
  assert.equal(brief.searchReceipt.liveSearchVerified, false);
  assert.equal(brief.inference.liveInferenceVerified, false);
  assert.equal(brief.actionExecuted, false);
  assert.equal(brief.inference.outputSha256, hashStructuredOutput(brief.brief));
});

test('saved source tampering and invented model citations cannot become research evidence', async (t) => {
  let invalid = false;
  const { service, dataRoot } = await fixture(t, { inferenceRuntime: { async generate(request) {
    const value = modelValue(request);
    if (invalid) value.summary.citations[0].quote = 'invented quotation';
    return modelResponse(value);
  } } });
  const search = await service.handle('search', input);
  const request = { searchId: search.id, selectedSourceIds: ['S1'], consent: true };
  invalid = true;
  await assert.rejects(service.handle('brief', request), /outside the selected search passages/);
  const failureFiles = await readdir(path.join(dataRoot, 'research'));
  assert.equal(failureFiles.length, 2, 'Rejected inference keeps a sanitized failure receipt');
  const failure = JSON.parse(await readFile(path.join(dataRoot, 'research', failureFiles.find((name) => name !== `${search.id}.json`)), 'utf8'));
  assert.equal(failure.kind, 'tavily-nemotron-failure');
  assert.equal(failure.inferenceFailure.liveInferenceVerified, false);
  assert.doesNotMatch(JSON.stringify(failure), /invented quotation|validation error|fixture-secret/);
  const file = path.join(dataRoot, 'research', `${search.id}.json`);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  stored.results[0].content = 'Modified source with the old receipt';
  await writeFile(file, JSON.stringify(stored));
  await assert.rejects(service.handle('record', { id: search.id }), /does not match its receipt/);
  await assert.rejects(service.handle('brief', request), /does not match its receipt/);
});

test('saved per-product research and checklist survive reopening without configured providers or new requests', async (t) => {
  let modelCalls = 0;
  const { service, calls, dataRoot } = await fixture(t, { inferenceRuntime: { async generate(request) { modelCalls++; return modelResponse(modelValue(request)); } } });
  const search = await service.handle('search', { ...input, product: 'resumer' });
  const brief = await service.handle('brief', { searchId: search.id, selectedSourceIds: ['S1'], consent: true });
  await assert.rejects(service.handle('search', { ...input, product: 'unsupported-context', query: 'Unsupported context' }), /this product/);
  const reopened = await createTavilyService({ dataRoot, env: {}, fetchImpl: async () => { throw new Error('Recovery must not use a provider'); } });
  const history = await reopened.handle('history', { product: 'resumer' });
  assert.equal(history.unavailable, false);
  assert.equal(history.records.length, 2);
  assert.equal(history.records[0].id, brief.id);
  assert.doesNotMatch(JSON.stringify(history), /Route-only/);
  assert.deepEqual(await reopened.handle('record', { id: brief.id, product: 'resumer' }), brief);
  assert.deepEqual(await reopened.handle('record', { id: search.id, product: 'resumer' }), search);
  await assert.rejects(reopened.handle('record', { id: brief.id, product: 'unsupported-context' }), /this product/);
  await assert.rejects(reopened.handle('history', { product: '../scope' }), /this product/);
  await assert.rejects(reopened.handle('history', { product: 'resumer', directory: '/tmp' }), /Unsupported/);
  assert.equal(calls.length, 1);
  assert.equal(modelCalls, 1);
  assert.equal(reopened.status().configured, false);

  // Previously saved version-1 records had no quote-choice payload.
  const legacy = structuredClone(brief);
  legacy.version = 1; delete legacy.quoteChoices;
  legacy.disclosure.payloadSha256 = hashStructuredOutput({ product: legacy.product, question: legacy.query, sources: legacy.sources });
  await writeFile(path.join(dataRoot, 'research', `${legacy.id}.json`), JSON.stringify(legacy));
  assert.deepEqual(await reopened.handle('record', { id: legacy.id, product: 'resumer' }), legacy);
});

test('history excludes altered brief, source binding, quote choices and disclosure while preserving valid sources', async (t) => {
  const { service, dataRoot } = await fixture(t, { inferenceRuntime: { async generate(request) { return modelResponse(modelValue(request)); } } });
  const search = await service.handle('search', input);
  const brief = await service.handle('brief', { searchId: search.id, selectedSourceIds: ['S1'], consent: true });
  const file = path.join(dataRoot, 'research', `${brief.id}.json`);
  for (const tamper of [
    (record) => { record.brief.summary.text = 'Changed result with unchanged inference receipt'; },
    (record) => { record.sources[0].content += ' Added source material.'; },
    (record) => { record.quoteChoices[0].quotes[0] = 'Not in the source.'; },
    (record) => { record.disclosure.payloadSha256 = '0'.repeat(64); },
    (record) => { delete record.searchReceipt; },
  ]) {
    const changed = structuredClone(brief); tamper(changed);
    await writeFile(file, JSON.stringify(changed));
    await assert.rejects(service.handle('record', { id: brief.id, product: input.product }));
    const history = await service.handle('history', { product: input.product });
    assert.equal(history.unavailable, true);
    assert.deepEqual(history.records.map((record) => record.id), [search.id]);
  }
  await writeFile(file, '{malformed PRIVATE_STORED_TEXT');
  await assert.rejects(service.handle('record', { id: brief.id }), (error) => /invalid/.test(error.message) && !/PRIVATE_STORED_TEXT/.test(error.message));
  assert.equal((await service.handle('history', { product: input.product })).records.length, 1);
});

test('request schema binds each source to bounded exact quotations and rejects alterations or source swaps', async (t) => {
  let request;
  const { service } = await fixture(t, { inferenceRuntime: { async generate(value) { request = value; return modelResponse(modelValue(value)); } } });
  const search = await service.handle('search', input);
  const brief = await service.handle('brief', { searchId: search.id, selectedSourceIds: ['S1', 'S2'], consent: true });
  const validate = new Ajv({ strict: true }).compile(request.schema);
  const value = modelValue(request);
  assert.equal(validate(value), true);
  const changedQuote = structuredClone(value); changedQuote.summary.citations[0].quote += ' Altered.';
  assert.equal(validate(changedQuote), false);
  const changedSource = structuredClone(value); changedSource.summary.citations[0].sourceId = 'S2';
  assert.equal(validate(changedSource), false);
  const sourceTwo = structuredClone(value); sourceTwo.summary.citations[0] = { sourceId: 'S2', quote: request.input.quoteChoices[1].quotes[0] };
  assert.equal(validate(sourceTwo), true);
  for (const choice of request.input.quoteChoices) {
    assert.ok(choice.quotes.length >= 1 && choice.quotes.length <= 8);
    for (const quote of choice.quotes) assert.ok(quote.length <= 500 && search.results.find((source) => source.id === choice.sourceId).content.includes(quote));
  }
  assert.equal(brief.version, 4);
  assert.deepEqual(brief.quoteChoices, request.input.quoteChoices);
  assert.equal(brief.disclosure.payloadSha256, hashStructuredOutput(request.input));
  assert.equal(brief.inference.outputSha256, hashStructuredOutput(brief.brief));
});

test('independent citation validation preserves only sanitized failure usage and hashes, never rejected text', async (t) => {
  const { service, dataRoot } = await fixture(t, { inferenceRuntime: { async generate(request) {
    const value = modelValue(request);
    value.summary.citations[0].quote = 'PRIVATE_REJECTED_QUOTE fixture-secret';
    return { value, inference: { ...modelResponse(value).inference, responseId: 'chatcmpl-0123456789abcdef0123456789abcdef',
      usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300, raw: 'PRIVATE_REJECTED_QUOTE' },
      requestSha256: '1'.repeat(64), responseSha256: '2'.repeat(64), raw: 'PRIVATE_REJECTED_QUOTE' } };
  } } });
  const search = await service.handle('search', input);
  let diagnostic;
  await assert.rejects(service.handle('brief', { searchId: search.id, selectedSourceIds: ['S1'], consent: true }), (error) => {
    diagnostic = error.inferenceFailure;
    assert.match(error.message, /outside the selected search passages/);
    assert.equal(diagnostic.failureRecordSaved, true);
    assert.equal(diagnostic.liveInferenceVerified, false);
    assert.deepEqual(diagnostic.usage, { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 });
    return true;
  });
  const saved = JSON.parse(await readFile(path.join(dataRoot, 'research', `${diagnostic.failureRecordId}.json`), 'utf8'));
  assert.deepEqual(saved.inferenceFailure.usage, diagnostic.usage);
  assert.equal(saved.inferenceFailure.responseSha256, '2'.repeat(64));
  assert.doesNotMatch(JSON.stringify({ saved, status: service.status() }), /PRIVATE_REJECTED_QUOTE|fixture-secret/);
  const reopened = await createTavilyService({ dataRoot, env: {} });
  const history = await reopened.handle('history', { product: input.product });
  assert.equal(history.unavailable, false, 'Failure receipts are not successful history items');
  assert.equal(history.records.length, 1);
  assert.equal(history.failures.length, 1);
  assert.equal(history.failures[0].id, diagnostic.failureRecordId);
  assert.equal(history.failures[0].receipt.status, 'not_verified');
  assert.deepEqual(history.failures[0].receipt.usage, diagnostic.usage);
  assert.doesNotMatch(JSON.stringify(history.failures), /PRIVATE_REJECTED_QUOTE|fixture-secret/);
});

test('runtime schema rejection remains a durable failed attempt with usage and safe validator metadata', async (t) => {
  const { service, dataRoot } = await fixture(t, { inferenceRuntime: { async generate() {
    throw Object.assign(new Error('Nebius output failed the research schema.'), { statusCode: 502, inferenceFailure: {
      failureType: 'schema-mismatch', transport: 'test-fixture', finishReason: 'stop', usage: { completion_tokens: 99 },
      responseSha256: '3'.repeat(64), validation: [{ keyword: 'enum', schemaPath: '#/properties/summary/properties/citations/items/oneOf/0/properties/quote/enum', raw: 'PRIVATE_REJECTED_TEXT' }, { keyword: 'PRIVATE_REJECTED_TEXT', schemaPath: '#' }],
      raw: 'PRIVATE_REJECTED_TEXT',
    } });
  } } });
  const search = await service.handle('search', input);
  await assert.rejects(service.handle('brief', { searchId: search.id, selectedSourceIds: ['S1'], consent: true }), (error) => error.inferenceFailure.failureRecordSaved === true);
  const reopened = await createTavilyService({ dataRoot, env: {} });
  const history = await reopened.handle('history', { product: input.product });
  assert.equal(history.failures[0].receipt.failureType, 'schema-mismatch');
  assert.equal(history.failures[0].receipt.finishReason, 'stop');
  assert.deepEqual(history.failures[0].receipt.usage, { completion_tokens: 99 });
  assert.equal(history.failures[0].receipt.validation.length, 1);
  assert.doesNotMatch(JSON.stringify(history.failures), /PRIVATE_REJECTED_TEXT/);
});

test('new quote choices exclude headings, navigation and XML introductions while old v2 receipts remain readable', async (t) => {
  const content = [
    ...Array.from({ length: 10 }, (_, index) => `## Keyboard heading ${index + 1}`),
    '[Home](https://docs.nvidia.com/) > [Docs](https://docs.nvidia.com/nim/)', 'On this page',
    '* [Previous](https://docs.nvidia.com/previous/)', '1. [Next](https://docs.nvidia.com/next/)', 'Documentation > User guide > Keyboard',
    'Focus order', '-----------', '<h2>Focus navigation</h2>', '**Keyboard controls**',
    'The tree shown above is represented in XML as follows.', 'See the following XML example:',
    'Tab moves keyboard focus between interactive controls.', 'Shift+Tab moves focus in reverse order.',
  ].join('\n');
  let request;
  const { service, dataRoot } = await fixture(t, { fetchImpl: async () => Response.json({ ...result(), results: [{ ...result().results[0], content }] }),
    inferenceRuntime: { async generate(value) {
      request = value;
      const statement = { text: 'Compare this product’s focus order with the documented keyboard behavior.', citations: [{ sourceId: 'S1', quote: value.input.quoteChoices[0].quotes[0] }] };
      return modelResponse({ summary: statement, checks: [structuredClone(statement)], questions: [] });
    } } });
  const search = await service.handle('search', input);
  const brief = await service.handle('brief', { searchId: search.id, selectedSourceIds: ['S1'], consent: true });
  assert.equal(brief.version, 4);
  assert.deepEqual(request.input.quoteChoices, [{ sourceId: 'S1', quotes: ['Tab moves keyboard focus between interactive controls.', 'Shift+Tab moves focus in reverse order.'] }]);
  const validate = new Ajv({ strict: true }).compile(request.schema);
  for (const quote of ['## Keyboard heading 1', 'On this page', 'Focus order', 'The tree shown above is represented in XML as follows.']) {
    const changed = structuredClone(brief.brief); changed.summary.citations[0].quote = quote;
    assert.equal(validate(changed), false, `Boilerplate must not be an eligible quote: ${quote}`);
  }
  assert.match(request.system, /semantic support still requires human review/);
  assert.deepEqual(await service.handle('record', { id: brief.id }), brief);

  // This represents a previously saved v2 fixture, including its weaker choices.
  const legacy = structuredClone(brief);
  legacy.version = 2;
  legacy.quoteChoices = [{ sourceId: 'S1', quotes: Array.from({ length: 8 }, (_, index) => `## Keyboard heading ${index + 1}`) }];
  legacy.brief.summary.citations[0].quote = legacy.quoteChoices[0].quotes[0];
  legacy.brief.checks[0].citations[0].quote = legacy.quoteChoices[0].quotes[0];
  legacy.inference.outputSha256 = hashStructuredOutput(legacy.brief);
  legacy.disclosure.payloadSha256 = hashStructuredOutput({ product: legacy.product, question: legacy.query, sources: legacy.sources, quoteChoices: legacy.quoteChoices });
  await writeFile(path.join(dataRoot, 'research', `${legacy.id}.json`), JSON.stringify(legacy));
  assert.deepEqual(await service.handle('record', { id: legacy.id }), legacy, 'Filtering does not rewrite or invalidate historical v2 evidence');
});

test('all-boilerplate passages block before inference without silently falling back to headings', async (t) => {
  let modelCalls = 0;
  const { service, dataRoot } = await fixture(t, { fetchImpl: async () => Response.json({ ...result(), results: [{ ...result().results[0],
    content: '# Navigation\n[Home](https://docs.nvidia.com/) | [Search](https://docs.nvidia.com/search/)\nTable of contents\nThe tree shown above is represented in XML as follows.',
  }] }), inferenceRuntime: { async generate() { modelCalls++; throw new Error('No model call is permitted for boilerplate-only sources'); } } });
  const search = await service.handle('search', input);
  await assert.rejects(service.handle('brief', { searchId: search.id, selectedSourceIds: ['S1'], consent: true }), /no eligible prose quotations/);
  assert.equal(modelCalls, 0);
  assert.equal((await readdir(path.join(dataRoot, 'research'))).length, 1);
});

test('v4 excludes bare list markers before the quote cap, retains partial code, and reopens unchanged v3 evidence', async (t) => {
  const markers = ['1.', '2.', '4.', '7', '(8)', 'a.', 'b)', 'iv.', '(ix)', '...', '—', '***', '});'];
  const useful = ['Compare the requested checkout behavior with the documented contract.', 'Check the error status before accepting success.',
    'const output = JSON.parse(message.content);', 'if (output.refusal) {', 'result = json.loads(message.content)'];
  const content = [...markers, `1. ${useful[0]}`, `2. ${useful[1]}`, ...useful.slice(2)].join('\n');
  let request;
  const { service, dataRoot } = await fixture(t, { fetchImpl: async () => Response.json({ ...result(), results: [{ ...result().results[0], content }] }),
    inferenceRuntime: { async generate(value) {
      request = value;
      const statement = { text: 'Compare the product with the selected contract.', citations: [{ sourceId: 'S1', quote: value.input.quoteChoices[0].quotes[0] }] };
      return modelResponse({ summary: statement, checks: [structuredClone(statement)], questions: [] });
    } } });
  const search = await service.handle('search', input);
  const brief = await service.handle('brief', { searchId: search.id, selectedSourceIds: ['S1'], consent: true });
  assert.equal(brief.version, 4);
  assert.deepEqual(request.input.quoteChoices, [{ sourceId: 'S1', quotes: useful }], 'Unusable fragments cannot crowd real prose or code out of the bounded choices');
  const validate = new Ajv({ strict: true }).compile(request.schema);
  for (const quote of markers) {
    const changed = structuredClone(brief.brief); changed.summary.citations[0].quote = quote;
    assert.equal(validate(changed), false, `A bare fragment cannot support a new citation: ${quote}`);
  }
  for (const quote of useful.slice(2)) {
    const changed = structuredClone(brief.brief); changed.summary.citations[0].quote = quote;
    assert.equal(validate(changed), true, `Substantive partial code remains available: ${quote}`);
  }
  assert.deepEqual(await service.handle('record', { id: brief.id }), brief);

  const legacy = structuredClone(brief);
  legacy.version = 3;
  legacy.quoteChoices = [{ sourceId: 'S1', quotes: markers.slice(0, 8) }];
  for (const statement of [legacy.brief.summary, ...legacy.brief.checks]) statement.citations[0].quote = '1.';
  legacy.inference.outputSha256 = hashStructuredOutput(legacy.brief);
  legacy.disclosure.payloadSha256 = hashStructuredOutput({ product: legacy.product, question: legacy.query, sources: legacy.sources, quoteChoices: legacy.quoteChoices });
  const file = path.join(dataRoot, 'research', `${legacy.id}.json`);
  const original = JSON.stringify(legacy);
  await writeFile(file, original);
  const reopened = await createTavilyService({ dataRoot, env: {} });
  assert.deepEqual(await reopened.handle('record', { id: legacy.id }), legacy, 'V4 filtering does not invalidate v3 receipts containing weak quotations');
  assert.equal((await reopened.handle('history', { product: input.product })).unavailable, false);
  assert.equal(await readFile(file, 'utf8'), original, 'Reading legacy evidence never rewrites its original bytes');
});

test('marker-only passages stop before inference instead of spending a request on unusable citations', async (t) => {
  let modelCalls = 0;
  const { service, dataRoot } = await fixture(t, { fetchImpl: async () => Response.json({ ...result(), results: [{ ...result().results[0], content: '1.\n2.\n4.\n(a)\niv.\n...\n});' }] }),
    inferenceRuntime: { async generate() { modelCalls++; throw new Error('No inference is permitted for bare markers'); } } });
  const search = await service.handle('search', input);
  await assert.rejects(service.handle('brief', { searchId: search.id, selectedSourceIds: ['S1'], consent: true }), /no eligible prose quotations/);
  assert.equal(modelCalls, 0);
  assert.equal((await readdir(path.join(dataRoot, 'research'))).length, 1);
});
