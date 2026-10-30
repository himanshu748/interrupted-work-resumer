import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createResumerService } from '../src/resumer/service.js';
import { createInferenceRuntime, hashStructuredOutput } from '../src/integrations/runtime.js';

const inference = { provider: 'fixture-nebius', model: 'fixture-nemotron', responseModel: 'fixture-nemotron', responseId: 'fixture-response',
  startedAt: '2026-09-29T00:00:00.000Z', completedAt: '2026-09-29T00:00:01.000Z', requestSha256: 'a'.repeat(64), responseSha256: 'b'.repeat(64), usage: {}, liveInferenceVerified: false, transport: 'fixture' };
const modelResponse = (value) => ({ value, inference: { ...inference, outputSha256: hashStructuredOutput(value) } });
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nemotron-workflows-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'data');
  return { root, dataRoot };
}

async function resumerFixture(t, makeResponse) {
  const { root, dataRoot } = await fixture(t);
  const project = path.join(root, 'project');
  await mkdir(project);
  await writeFile(path.join(project, 'plan.md'), 'Publish the preview.\n');
  await writeFile(path.join(project, 'not-selected.md'), 'Do not disclose this other file.\n');
  const calls = [];
  const service = await createResumerService({ workspaceRoot: root, dataRoot, inferenceRuntime: { async generate(request) {
    calls.push(request); return modelResponse(makeResponse(request));
  } } });
  const { checkpoint } = await service.handle('checkpoint', { projectDirectory: 'project', files: ['plan.md', 'not-selected.md'],
    goal: 'Review the preview', nextAction: 'Publish the preview', decisions: ['Private omitted decision'], blockers: ['Account access is unverified'] });
  await writeFile(path.join(project, 'plan.md'), 'Review revised accessibility requirements before publishing.\n');
  return { root, dataRoot, project, service, calls, checkpoint };
}
function planValue({ input }) {
  const evidence = input.evidence.find((entry) => entry.side === 'after');
  const statement = { text: 'Review the accessibility requirements before deciding whether to publish.', citations: [{ evidenceId: evidence.id, quote: 'Review revised accessibility requirements' }] };
  return { summary: statement, actions: [structuredClone(statement)], questions: [] };
}

test('resumer sends only selected bounded evidence, saves cited suggestions, and reopens historical observations', async (t) => {
  const { service, checkpoint, calls, project, dataRoot, root } = await resumerFixture(t, planValue);
  const { analysis } = await service.handle('analyze', { checkpointId: checkpoint.id, selectedPaths: ['plan.md'], contextFields: ['goal'], consent: true });
  const payload = calls[0].input;
  assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(payload), /Do not disclose|Private omitted decision|Account access|projectRoot|outputPath/);
  assert.ok(!JSON.stringify(payload).includes(root));
  assert.deepEqual(payload.evidence.filter((entry) => entry.field).map((entry) => entry.field), ['goal']);
  assert.equal(analysis.files[0].status, 'changed');
  assert.equal(analysis.nextActionExecuted, false);
  assert.equal(analysis.blockersValidated, false);
  assert.equal(analysis.inference.liveInferenceVerified, false);
  assert.match(analysis.markdown, /Live inference was not verified/);
  assert.match(analysis.markdown, /No saved action was executed/);
  const contentBefore = await readFile(path.join(project, 'plan.md'), 'utf8');
  const second = await service.handle('analyze', { checkpointId: checkpoint.id, selectedPaths: ['plan.md'], contextFields: [], consent: true });
  assert.notEqual(second.analysis.id, analysis.id);
  assert.equal(await readFile(path.join(project, 'plan.md'), 'utf8'), contentBefore);
  await rm(project, { recursive: true });
  const restarted = await createResumerService({ workspaceRoot: root, dataRoot });
  assert.deepEqual((await restarted.handle('analysis', { analysisId: analysis.id })).analysis, analysis);
  assert.equal((await restarted.handle('list')).checkpoints[0].analyses.length, 2);
});

test('resumer refuses wider selection, absent consent, oversized disclosure, and invented citations before saving a plan', async (t) => {
  let invalid = false;
  const { service, checkpoint, calls, dataRoot } = await resumerFixture(t, (request) => {
    const value = planValue(request);
    if (invalid) value.summary.citations[0].quote = 'invented source evidence';
    return value;
  });
  const input = { checkpointId: checkpoint.id, selectedPaths: ['plan.md'], contextFields: [], consent: true };
  for (const values of [{ consent: false }, { selectedPaths: ['../outside'] }, { selectedPaths: [] }, { contextFields: ['allFiles'] }, { selectedPaths: ['plan.md', 'plan.md'] }]) await assert.rejects(service.handle('analyze', { ...input, ...values }));
  assert.equal(calls.length, 0);
  invalid = true;
  await assert.rejects(service.handle('analyze', input), /outside the selected evidence/);
  assert.deepEqual(await readdir(path.join(dataRoot, 'analyses')), []);
});

test('resumer marks truncated file excerpts and rejects context over the disclosure cap', async (t) => {
  const { root, dataRoot } = await fixture(t);
  await writeFile(path.join(root, 'long.md'), Array.from({ length: 80 }, (_, index) => `line ${index}`).join('\n'));
  let received;
  const service = await createResumerService({ workspaceRoot: root, dataRoot, inferenceRuntime: { async generate(request) {
    received = request;
    const cited = request.input.evidence.find((entry) => entry.side === 'after');
    return modelResponse({ summary: { text: 'Review the selected excerpt.', citations: [{ evidenceId: cited.id, quote: 'line 0' }] }, actions: [], questions: [] });
  } } });
  const { checkpoint } = await service.handle('checkpoint', { projectDirectory: '.', files: ['long.md'], goal: 'Review lines', nextAction: 'Inspect changes', decisions: Array.from({ length: 20 }, () => 'x'.repeat(4000)) });
  const { analysis } = await service.handle('analyze', { checkpointId: checkpoint.id, selectedPaths: ['long.md'], contextFields: [], consent: true });
  assert.equal(analysis.evidence.find((entry) => entry.side === 'after').truncated, true);
  assert.equal(received.input.evidence.find((entry) => entry.side === 'after').endLine, 40);
  received = null;
  await assert.rejects(service.handle('analyze', { checkpointId: checkpoint.id, selectedPaths: ['long.md'], contextFields: ['decisions'], consent: true }), /exceeds 64 KiB/);
  assert.equal(received, null);
});
test('resumer checks output receipts in history and rebuilds markdown from the verified plan', async (t) => {
  const { service, checkpoint, dataRoot, root } = await resumerFixture(t, planValue);
  const { analysis } = await service.handle('analyze', { checkpointId: checkpoint.id, selectedPaths: ['plan.md'], contextFields: [], consent: true });
  const file = path.join(dataRoot, 'analyses', `${analysis.id}.json`);
  const restarted = await createResumerService({ workspaceRoot: root, dataRoot });
  for (const mutate of [
    (record) => { record.plan.summary.text = 'The saved action has been completed.'; },
    (record) => { record.plan.actions = []; },
    (record) => { delete record.inference.outputSha256; },
  ]) {
    const changed = structuredClone(analysis);
    mutate(changed);
    await writeFile(file, JSON.stringify(changed));
    await assert.rejects(restarted.handle('analysis', { analysisId: analysis.id }), /does not match its inference receipt/);
    await assert.rejects(restarted.handle('list'), /does not match its inference receipt/);
  }
  await writeFile(file, JSON.stringify({ ...analysis, markdown: '# Everything completed and verified' }));
  assert.equal((await restarted.handle('analysis', { analysisId: analysis.id })).analysis.markdown, analysis.markdown);
});
test('resumer require a matching output receipt before saving new model suggestions', async (t) => {
  const { root, dataRoot } = await fixture(t);
  const runtime = { async generate(request) {
    const value = planValue(request);
    return { value, inference: { ...inference, outputSha256: '0'.repeat(64) } };
  } };
  await writeFile(path.join(root, 'plan.md'), 'Review revised accessibility requirements before publishing.\n');
  const resumer = await createResumerService({ workspaceRoot: root, dataRoot, inferenceRuntime: runtime });
  const { checkpoint } = await resumer.handle('checkpoint', { projectDirectory: '.', files: ['plan.md'], goal: 'Review', nextAction: 'Check changes' });
  await assert.rejects(resumer.handle('analyze', { checkpointId: checkpoint.id, selectedPaths: ['plan.md'], contextFields: [], consent: true }), /does not match its inference receipt/);
  assert.deepEqual(await readdir(path.join(dataRoot, 'analyses')), []);
});
test('legacy resumer records stay readable with unverified output provenance and are never rewritten', async (t) => {
  const { service, checkpoint, dataRoot, root } = await resumerFixture(t, planValue);
  const { analysis } = await service.handle('analyze', { checkpointId: checkpoint.id, selectedPaths: ['plan.md'], contextFields: [], consent: true });
  delete analysis.outputBindingVersion;
  delete analysis.inference.outputSha256;
  analysis.inference.liveInferenceVerified = true;
  const analysisFile = path.join(dataRoot, 'analyses', `${analysis.id}.json`);
  const analysisBytes = JSON.stringify(analysis);
  await writeFile(analysisFile, analysisBytes);
  const restarted = await createResumerService({ workspaceRoot: root, dataRoot });
  const historical = (await restarted.handle('analysis', { analysisId: analysis.id })).analysis;
  assert.equal(historical.inference.liveInferenceVerified, false);
  assert.equal(historical.outputBindingVerified, false);
  assert.match(historical.markdown, /Legacy analysis has no structured-output hash/);
  assert.equal((await restarted.handle('list')).checkpoints[0].analyses[0].inference.liveInferenceVerified, false);
  assert.equal(await readFile(analysisFile, 'utf8'), analysisBytes);
});

test('resumer workflow schema compile and validate through the real runtime with a fixture transport', async (t) => {
  const { root, dataRoot } = await fixture(t);
  const requests = [];
  const model = 'nvidia/fixture-nemotron';
  const runtime = createInferenceRuntime({ env: { NEBIUS_API_KEY: 'fixture-key' }, fetchImpl: async (url, options) => {
    requests.push(url);
    if (url.endsWith('/models?verbose=true')) return Response.json({ data: [{ id: model }] });
    const sent = JSON.parse(options.body);
    const input = JSON.parse(sent.messages[1].content);
    const value = planValue({ input });
    return Response.json({ id: 'fixture-completion', model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { total_tokens: 50 } });
  } });
  await writeFile(path.join(root, 'plan.md'), 'Publish the preview.\n');
  const resumer = await createResumerService({ workspaceRoot: root, dataRoot, inferenceRuntime: runtime });
  const { checkpoint } = await resumer.handle('checkpoint', { projectDirectory: '.', files: ['plan.md'], goal: 'Review', nextAction: 'Check changes' });
  await writeFile(path.join(root, 'plan.md'), 'Review revised accessibility requirements before publishing.\n');
  const { analysis } = await resumer.handle('analyze', { checkpointId: checkpoint.id, selectedPaths: ['plan.md'], contextFields: [], consent: true });
  assert.equal(analysis.inference.model, model);
  assert.equal(analysis.inference.liveInferenceVerified, false);
  assert.equal(requests.filter((url) => url.endsWith('/chat/completions')).length, 1);
  assert.ok(requests.every((url) => url.startsWith('https://api.tokenfactory.nebius.com/v1/')));
});
