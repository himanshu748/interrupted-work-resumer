import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createResumerService } from '../src/resumer/service.js';
import { createInferenceRuntime } from '../src/integrations/runtime.js';

const inference = { provider: 'fixture-nebius', model: 'fixture-nemotron', responseModel: 'fixture-nemotron', responseId: 'fixture-response',
  startedAt: '2026-09-29T00:00:00.000Z', completedAt: '2026-09-29T00:00:01.000Z', requestSha256: 'a'.repeat(64), responseSha256: 'b'.repeat(64), usage: {}, liveInferenceVerified: false, transport: 'fixture' };
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
    calls.push(request); return { value: makeResponse(request), inference };
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
    return { value: { summary: { text: 'Review the selected excerpt.', citations: [{ evidenceId: cited.id, quote: 'line 0' }] }, actions: [], questions: [] }, inference };
  } } });
  const { checkpoint } = await service.handle('checkpoint', { projectDirectory: '.', files: ['long.md'], goal: 'Review lines', nextAction: 'Inspect changes', decisions: Array.from({ length: 20 }, () => 'x'.repeat(4000)) });
  const { analysis } = await service.handle('analyze', { checkpointId: checkpoint.id, selectedPaths: ['long.md'], contextFields: [], consent: true });
  assert.equal(analysis.evidence.find((entry) => entry.side === 'after').truncated, true);
  assert.equal(received.input.evidence.find((entry) => entry.side === 'after').endLine, 40);
  received = null;
  await assert.rejects(service.handle('analyze', { checkpointId: checkpoint.id, selectedPaths: ['long.md'], contextFields: ['decisions'], consent: true }), /exceeds 64 KiB/);
  assert.equal(received, null);
});
