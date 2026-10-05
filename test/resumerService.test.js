import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createResumerService } from '../src/resumer/service.js';

async function fixture(t) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'resumer-service-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const workspaceRoot = path.join(temporary, 'workspace');
  const dataRoot = path.join(temporary, 'data');
  const project = path.join(workspaceRoot, 'website');
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'plan.md'), '# Plan\n\nPublish the preview.\n');
  await writeFile(path.join(project, 'handoff.md'), 'Waiting for test account access.\n');
  const config = { workspaceRoot, dataRoot };
  const service = await createResumerService(config);
  const input = { projectDirectory: 'website', files: ['plan.md', 'handoff.md'], goal: 'Prepare a website preview.', nextAction: 'Publish after reviewing the plan.', decisions: ['Keep the current layout.'], blockers: ['Test account access is unverified.'] };
  return { temporary, workspaceRoot, project, dataRoot, config, service, input };
}

test('checkpoints real selected files and persists changed/deleted evidence without touching project files', async (t) => {
  const { service, input, project, dataRoot } = await fixture(t);
  assert.deepEqual((await service.handle('list')).checkpoints, []);
  const { checkpoint } = await service.handle('checkpoint', input);
  assert.deepEqual((await readdir(project)).sort(), ['handoff.md', 'plan.md']);
  assert.equal(checkpoint.synthetic, false);
  assert.equal(checkpoint.blockers[0], input.blockers[0]);
  await writeFile(path.join(project, 'plan.md'), '# Plan\n\nReview accessibility before publishing.\n');
  await unlink(path.join(project, 'handoff.md'));
  const response = await service.handle('resume', { checkpointId: checkpoint.id });
  assert.deepEqual(response.comparisons.map(({ path: file, status }) => [file, status]), [['handoff.md', 'deleted'], ['plan.md', 'changed']]);
  assert.match(response.artifact.markdown, /Publish the preview/);
  assert.match(response.artifact.markdown, /Review accessibility before publishing/);
  assert.match(response.artifact.markdown, /Unvalidated: Test account access is unverified/);
  assert.equal(response.blockersValidated, false);
  assert.equal(response.nextActionExecuted, false);
  assert.equal(await readFile(response.artifact.outputPath, 'utf8'), response.artifact.markdown);
  assert.ok(response.artifact.outputPath.startsWith(`${dataRoot}${path.sep}`));
  assert.equal((await stat(response.artifact.outputPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(project), ['plan.md']);
  assert.equal(await readFile(path.join(project, 'plan.md'), 'utf8'), '# Plan\n\nReview accessibility before publishing.\n');
});

test('checkpoints and continuations survive service restart and repeated resumes create new outputs', async (t) => {
  const { service, input, config } = await fixture(t);
  const { checkpoint } = await service.handle('checkpoint', input);
  const first = await service.handle('resume', { checkpointId: checkpoint.id });
  const restarted = await createResumerService(config);
  const listing = await restarted.handle('list');
  assert.equal(listing.checkpoints[0].id, checkpoint.id);
  assert.equal(listing.checkpoints[0].artifacts[0].id, first.artifact.id);
  const reopened = await restarted.handle('artifact', { artifactId: first.artifact.id });
  assert.equal(reopened.artifact.markdown, first.artifact.markdown);
  const second = await restarted.handle('resume', { checkpointId: checkpoint.id });
  assert.notEqual(second.artifact.id, first.artifact.id);
  assert.notEqual(second.artifact.outputPath, first.artifact.outputPath);
  assert.equal(await readFile(first.artifact.outputPath, 'utf8'), first.artifact.markdown);
  assert.ok(second.comparisons.every(({ status }) => status === 'unchanged'));
  assert.match(second.artifact.markdown, /does not prove that external dependencies/);
});

test('rejects escapes, credential paths, symlinks, and caller-controlled output destinations', async (t) => {
  const { service, input, project, workspaceRoot, temporary } = await fixture(t);
  await writeFile(path.join(temporary, 'outside.md'), 'Must not read this.');
  await writeFile(path.join(project, '.env'), 'Never expose this.');
  await mkdir(path.join(workspaceRoot, 'credentials'));
  await symlink(project, path.join(workspaceRoot, 'linked-project'));
  await symlink(path.join(temporary, 'outside.md'), path.join(project, 'linked.md'));
  for (const projectDirectory of ['../', '../workspace/website', '/tmp', 'linked-project', 'credentials', 'website/..']) {
    await assert.rejects(service.handle('checkpoint', { ...input, projectDirectory }));
  }
  for (const file of ['../outside.md', '/tmp/outside.md', '.env', 'linked.md', 'secrets/value.md', 'certificate.pem']) {
    await assert.rejects(service.handle('checkpoint', { ...input, files: [file] }));
  }
  const { checkpoint } = await service.handle('checkpoint', input);
  await assert.rejects(service.handle('checkpoint', { ...input, statePath: 'plan.md' }), /Output paths are managed/);
  await assert.rejects(service.handle('resume', { checkpointId: checkpoint.id, outputPath: 'plan.md' }), /Output paths are managed/);
  await assert.rejects(service.handle('resume', { checkpointId: '../outside' }));
  assert.equal(await readFile(path.join(project, 'plan.md'), 'utf8'), '# Plan\n\nPublish the preview.\n');
  assert.equal(await readFile(path.join(temporary, 'outside.md'), 'utf8'), 'Must not read this.');
});

test('checks project directory and selected-file safety again at resume time', async (t) => {
  const { service, input, workspaceRoot, project, temporary } = await fixture(t);
  const { checkpoint } = await service.handle('checkpoint', input);
  await unlink(path.join(project, 'plan.md'));
  await writeFile(path.join(temporary, 'external.md'), 'External content.');
  await symlink(path.join(temporary, 'external.md'), path.join(project, 'plan.md'));
  await assert.rejects(service.handle('resume', { checkpointId: checkpoint.id }), /Symlinks/);
  await rm(project, { recursive: true });
  await symlink(temporary, path.join(workspaceRoot, 'website'));
  await assert.rejects(service.handle('resume', { checkpointId: checkpoint.id }), /Symlinks/);
});

test('concurrent requests and independent service instances never lose checkpoints or overwrite artifacts', async (t) => {
  const { service, input, config, dataRoot } = await fixture(t);
  const second = await createResumerService(config);
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? service : second).handle('checkpoint', { ...input, goal: `Goal ${index}` })));
  assert.equal(new Set(results.map(({ checkpoint }) => checkpoint.id)).size, 12);
  assert.equal((await service.handle('list')).checkpoints.length, 12);
  const checkpointId = results[0].checkpoint.id;
  const resumptions = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? service : second).handle('resume', { checkpointId })));
  assert.equal(new Set(resumptions.map(({ artifact }) => artifact.id)).size, 8);
  assert.equal((await service.handle('list')).checkpoints.find((item) => item.id === checkpointId).artifacts.length, 8);
  assert.equal((await readdir(path.join(dataRoot, 'checkpoints'))).length, 12);
  assert.equal((await readdir(path.join(dataRoot, 'continuations'))).filter((name) => name.endsWith('.md')).length, 8);
});

test('synthetic example demonstrates changed/deleted observations only after an explicit change', async (t) => {
  const { service, input, project } = await fixture(t);
  const { checkpoint } = await service.handle('demo', { operation: 'create' });
  assert.equal(checkpoint.synthetic, true);
  const before = await service.handle('resume', { checkpointId: checkpoint.id });
  assert.ok(before.comparisons.every(({ status }) => status === 'unchanged'));
  await service.handle('demo', { operation: 'change', checkpointId: checkpoint.id });
  const after = await service.handle('resume', { checkpointId: checkpoint.id });
  assert.deepEqual(after.comparisons.map(({ status }) => status), ['deleted', 'changed']);
  assert.match(after.artifact.markdown, /Synthetic example/);
  assert.match(after.artifact.markdown, /Unvalidated: Shared test account access is unverified/);
  const real = await service.handle('checkpoint', input);
  await assert.rejects(service.handle('demo', { operation: 'change', checkpointId: real.checkpoint.id }), /Only synthetic/);
  assert.equal(await readFile(path.join(project, 'plan.md'), 'utf8'), '# Plan\n\nPublish the preview.\n');
});

test('metadata remains literal text and managed storage is not selectable as source', async (t) => {
  const { workspaceRoot, input, dataRoot } = await fixture(t);
  const inWorkspace = await createResumerService({ workspaceRoot, dataRoot: path.join(workspaceRoot, 'managed') });
  const unsafeText = '<img src=x onerror=alert(1)> & [link](javascript:alert(1))';
  const { checkpoint } = await inWorkspace.handle('checkpoint', { ...input, goal: unsafeText });
  assert.equal(checkpoint.goal, unsafeText);
  const result = await inWorkspace.handle('resume', { checkpointId: checkpoint.id });
  assert.match(result.artifact.markdown, /\\<img/);
  await assert.rejects(inWorkspace.handle('checkpoint', { ...input, projectDirectory: '.', files: [`managed/checkpoints/${checkpoint.id}.json`] }), /Managed resumer data/);
  await symlink(dataRoot, path.join(workspaceRoot, 'linked-storage'));
  await assert.rejects(createResumerService({ workspaceRoot, dataRoot: path.join(workspaceRoot, 'linked-storage') }), /ordinary directory/);
});

test('refuses a symlink replacing a managed output collection', async (t) => {
  const { service, input, dataRoot, temporary } = await fixture(t);
  const { checkpoint } = await service.handle('checkpoint', input);
  await rm(path.join(dataRoot, 'continuations'), { recursive: true });
  await symlink(temporary, path.join(dataRoot, 'continuations'));
  await assert.rejects(service.handle('resume', { checkpointId: checkpoint.id }), /Symlinks/);
  assert.equal((await readdir(temporary)).filter((name) => name.endsWith('.md')).length, 0);
});

test('previous continuations stay downloadable after the source project is removed', async (t) => {
  const { service, input, project, config } = await fixture(t);
  const { checkpoint } = await service.handle('checkpoint', input);
  const saved = await service.handle('resume', { checkpointId: checkpoint.id });
  await rm(project, { recursive: true });
  const restarted = await createResumerService(config);
  const reopened = await restarted.handle('artifact', { artifactId: saved.artifact.id });
  assert.equal(reopened.artifact.markdown, saved.artifact.markdown);
  assert.equal(reopened.artifact.createdAt, saved.artifact.createdAt);
  await assert.rejects(restarted.handle('resume', { checkpointId: checkpoint.id }), /does not exist/);
});

test('oversized serialized continuation is rejected before either output is written', async (t) => {
  const { service, input, project, dataRoot, config } = await fixture(t);
  // A single changed character makes each long line appear in both excerpts.
  // JSON doubles its backslashes, so 32 allowed 64 KiB files cross the record
  // limit while the checkpoint and unchanged continuation still fit.
  const files = Array.from({ length: 32 }, (_, index) => `long-line-${index}.md`);
  const before = `${'\\'.repeat(64 * 1024 - 1)}a`;
  const after = `${'\\'.repeat(64 * 1024 - 1)}b`;
  for (const file of files) await writeFile(path.join(project, file), before);
  const { checkpoint } = await service.handle('checkpoint', { ...input, files });
  const saved = await service.handle('resume', { checkpointId: checkpoint.id });
  const continuationDirectory = path.join(dataRoot, 'continuations');
  const originalFiles = (await readdir(continuationDirectory)).sort();
  assert.equal(originalFiles.length, 2);
  for (const file of files) await writeFile(path.join(project, file), after);
  await assert.rejects(service.handle('resume', { checkpointId: checkpoint.id }), /Saved record exceeds the storage size limit/);
  assert.deepEqual((await readdir(continuationDirectory)).sort(), originalFiles, 'failed continuation must leave no Markdown, pending, or JSON output');
  assert.equal(await readFile(saved.artifact.outputPath, 'utf8'), saved.artifact.markdown);
  const restarted = await createResumerService(config);
  const listing = await restarted.handle('list');
  assert.equal(listing.checkpoints.length, 1);
  assert.deepEqual(listing.checkpoints[0].artifacts.map(({ id }) => id), [saved.artifact.id]);
  const reopened = await restarted.handle('artifact', { artifactId: saved.artifact.id });
  assert.equal(reopened.artifact.markdown, saved.artifact.markdown);
});
