import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createResumerService } from '../src/resumer/service.js';

function clock() {
  let now = Date.parse('2026-09-29T12:00:00Z');
  let id = 0;
  const tasks = new Map();
  return {
    tasks, now: () => now,
    setTimeout(callback, delay) { const key = ++id; tasks.set(key, { callback, delay }); return key; },
    clearTimeout(key) { tasks.delete(key); },
    async tick() {
      const pending = [...tasks.entries()];
      now += 30_000;
      for (const [key, task] of pending) { if (!tasks.delete(key)) continue; await task.callback(); }
    },
  };
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'resumer-watch-')));
  const project = path.join(root, 'project');
  const dataRoot = path.join(root, 'managed');
  await mkdir(project);
  await writeFile(path.join(project, 'plan.md'), 'Review the original plan.\n');
  await writeFile(path.join(project, 'notes.md'), 'Await access.\n');
  const scheduler = clock();
  const config = { workspaceRoot: root, dataRoot, scheduler,
    inferenceRuntime: { generate() { assert.fail('Local file watching must never invoke inference.'); } } };
  const service = await createResumerService(config);
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const { checkpoint } = await service.handle('checkpoint', { projectDirectory: 'project', files: ['plan.md', 'notes.md'],
    goal: 'Review the project', nextAction: 'A free-text saved action; never execute it', decisions: ['Use current layout'], blockers: ['Access unvalidated'] });
  const start = (extra = {}) => service.handle('watch', { checkpointId: checkpoint.id, enabled: true, intervalSeconds: 30, consent: true, ...extra });
  const saved = async () => (await service.handle('list')).checkpoints[0];
  return { root, project, dataRoot, scheduler, service, checkpoint, config, start, saved };
}

test('local watcher requires explicit scoped consent and a bounded interval', async (t) => {
  const { service, scheduler, checkpoint, start } = await fixture(t);
  for (const extra of [{ consent: false }, { intervalSeconds: 29 }, { intervalSeconds: 30.5 }, { intervalSeconds: 86401 },
    { paths: ['../outside'] }, { command: 'execute saved text' }, { enabled: 'true' }]) await assert.rejects(start(extra));
  assert.equal(scheduler.tasks.size, 0);
  const { watch } = await start({ intervalSeconds: 90 });
  assert.deepEqual(watch.paths, ['notes.md', 'plan.md']);
  assert.equal(watch.checkpointId, checkpoint.id);
  assert.equal([...scheduler.tasks.values()][0].delay, 90_000);
  await assert.rejects(service.handle('watch', { checkpointId: checkpoint.id, enabled: false }), /consent/);
  await service.handle('watch', { checkpointId: checkpoint.id, enabled: false, consent: true });
  assert.equal(scheduler.tasks.size, 0);
});

test('watch publishes only changed selected observations and deduplicates across restart', async (t) => {
  const { project, dataRoot, scheduler, service, checkpoint, config, start, saved } = await fixture(t);
  await start();
  await scheduler.tick();
  assert.equal((await saved()).artifacts.length, 0);
  await writeFile(path.join(project, '.env'), 'UNSELECTED_SECRET');
  await writeFile(path.join(project, 'new.md'), 'New unselected document');
  await scheduler.tick();
  assert.equal((await saved()).artifacts.length, 0);
  const watchBefore = await readFile(path.join(dataRoot, 'watches', `${checkpoint.id}.json`), 'utf8');
  await writeFile(path.join(project, 'plan.md'), 'Review changed accessibility requirements.\n');
  await unlink(path.join(project, 'notes.md'));
  await scheduler.tick();
  const state = await saved();
  assert.equal(state.artifacts.length, 1);
  assert.equal(state.watch.lastError, null);
  const firstId = state.watch.lastArtifactId;
  const { artifact, comparisons } = await service.handle('artifact', { artifactId: firstId });
  assert.deepEqual(comparisons.map(({ status }) => status), ['deleted', 'changed']);
  assert.equal(artifact.execution, 'local-file-watch');
  assert.equal(artifact.liveInferenceVerified, false);
  assert.equal(artifact.nextActionExecuted, false);
  assert.equal(artifact.blockersValidated, false);
  assert.equal(artifact.inference, undefined);
  assert.match(artifact.markdown, /No model ran/);
  assert.ok(!artifact.markdown.includes('UNSELECTED_SECRET'));
  assert.equal(artifact.outputPath, null, 'watch Markdown is atomically stored inside its JSON receipt');
  await scheduler.tick();
  assert.equal((await saved()).artifacts.length, 1);
  await service.close();
  assert.equal(scheduler.tasks.size, 0);
  // Simulate a stop after artifact publication but before watch-state publication.
  await writeFile(path.join(dataRoot, 'watches', `${checkpoint.id}.json`), watchBefore);
  const restarted = await createResumerService(config);
  t.after(() => restarted.close());
  assert.equal((await restarted.handle('list')).checkpoints[0].watch.enabled, true);
  await scheduler.tick();
  const afterRestart = (await restarted.handle('list')).checkpoints[0];
  assert.equal(afterRestart.artifacts.length, 1);
  assert.equal(afterRestart.watch.lastArtifactId, firstId);
  assert.equal(afterRestart.watch.lastError, null);
  await restarted.handle('watch', { checkpointId: checkpoint.id, enabled: false, consent: true });
  await restarted.close();
  const disabled = await createResumerService(config);
  t.after(() => disabled.close());
  assert.equal(scheduler.tasks.size, 0);
  assert.equal((await disabled.handle('list')).checkpoints[0].watch.enabled, false);
  assert.equal((await readdir(path.join(dataRoot, 'continuations'))).length, 1);
});

test('watch failures remain visible, selected-path guards are repeated, and recovery never widens selection', async (t) => {
  const { root, project, scheduler, service, start, saved } = await fixture(t);
  await start();
  await writeFile(path.join(root, 'outside.md'), 'DO_NOT_READ');
  await unlink(path.join(project, 'plan.md'));
  await symlink(path.join(root, 'outside.md'), path.join(project, 'plan.md'));
  await scheduler.tick();
  assert.match((await saved()).watch.lastError, /Symlinks/);
  assert.equal((await saved()).artifacts.length, 0);
  await unlink(path.join(project, 'plan.md'));
  await writeFile(path.join(project, 'plan.md'), 'Safe changed plan.\n');
  await scheduler.tick();
  assert.equal((await saved()).watch.lastError, null);
  assert.equal((await saved()).artifacts.length, 1);
  await rm(project, { recursive: true });
  await scheduler.tick();
  assert.match((await saved()).watch.lastError, /does not exist/);
  const receipt = (await saved()).watch;
  await service.handle('watch', { checkpointId: receipt.checkpointId, enabled: false, consent: true });
  assert.equal(scheduler.tasks.size, 0, 'a missing project must still allow its watch to be stopped');
});

test('service close cancels pending local execution and refuses re-enabling', async (t) => {
  const { scheduler, service, start, saved } = await fixture(t);
  await start();
  const callback = [...scheduler.tasks.values()][0].callback;
  await service.close();
  assert.equal(scheduler.tasks.size, 0);
  await callback();
  assert.equal((await saved()).artifacts.length, 0);
  assert.equal(scheduler.tasks.size, 0);
  await assert.rejects(start(), /closing/);
});
