import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCheckpoint, MAX_FILE_BYTES, resumeProject } from '../src/resumer/core.js';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/resumer/cli.js', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'local-resumer-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'plan.md'), '# Plan\nShip an actual workflow.\n');
  return root;
}

function checkpoint(root, overrides = {}) {
  return createCheckpoint({
    root,
    files: ['plan.md'],
    statePath: '.resumer/checkpoint.json',
    goal: 'Prepare a verifiable local demo',
    nextAction: 'Inspect the remaining workflow gap',
    blockers: ['Account access is still unverified'],
    decisions: ['Do not claim inference without evidence'],
    ...overrides,
  });
}

function resume(root, overrides = {}) {
  return resumeProject({ root, statePath: '.resumer/checkpoint.json', outputPath: '.resumer/continuation.md', ...overrides });
}

test('checkpoint and resume preserve user context and expose real changed/deleted files', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'notes.md'), 'Old source retained in snapshot.\n');
  await checkpoint(root, { files: ['plan.md', 'notes.md'] });
  await writeFile(path.join(root, 'plan.md'), '# Plan\nVerify the blocked account separately.\n');
  await unlink(path.join(root, 'notes.md'));
  await writeFile(path.join(root, 'new-unselected.md'), 'This must not enter the report.');

  const result = await resume(root);
  assert.deepEqual(result.files, [{ path: 'notes.md', status: 'deleted' }, { path: 'plan.md', status: 'changed' }]);
  assert.equal(result.blockersValidated, false);
  assert.equal(result.nextActionExecuted, false);
  const artifact = await readFile(result.outputPath, 'utf8');
  assert.match(artifact, /Ship an actual workflow/);
  assert.match(artifact, /Verify the blocked account separately/);
  assert.match(artifact, /Old source retained in snapshot/);
  assert.match(artifact, /Unvalidated: Account access is still unverified/);
  assert.match(artifact, /Do not claim inference without evidence/);
  assert.match(artifact, /Inspect the remaining workflow gap/);
  assert.match(artifact, /\[plan\.md\]\(<\/.*\/plan\.md>\)/);
  assert.doesNotMatch(artifact, /new-unselected\.md/);
  assert.match(artifact, /no task or blocker was marked complete/);
});

test('unchanged snapshot reports byte equality without declaring project completion', async (t) => {
  const root = await fixture(t);
  const result = await checkpoint(root, { blockers: [], decisions: [] });
  assert.equal(result.selectedFileCount, 1);
  const checkpointFile = await readFile(result.statePath, 'utf8');
  const state = JSON.parse(checkpointFile);
  assert.equal(state.files[0].content, '# Plan\nShip an actual workflow.\n');
  assert.match(state.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal((await stat(result.statePath)).mode & 0o777, 0o600);
  const resumed = await resume(root);
  assert.deepEqual(resumed.files, [{ path: 'plan.md', status: 'unchanged' }]);
  const artifact = await readFile(resumed.outputPath, 'utf8');
  assert.match(artifact, /0 changed · 0 deleted · 1 unchanged/);
  assert.match(artifact, /does not establish that the project is unblocked/);
  assert.match(artifact, /has not performed the saved action/);
  assert.equal(await readFile(result.statePath, 'utf8'), checkpointFile);
});

test('explicit selection rejects traversal and absolute paths before reading', async (t) => {
  const root = await fixture(t);
  for (const selectedPath of ['../outside.md', 'a/../../outside.md', '/tmp/outside.md', './plan.md', 'a//plan.md', 'C:/outside.md', '..\\outside.md']) {
    await assert.rejects(checkpoint(root, { files: [selectedPath] }), /paths|traversal|Absolute/);
  }
  await assert.rejects(checkpoint(root, { statePath: '../state.json' }), /traversal/);
  await checkpoint(root);
  await assert.rejects(resume(root, { outputPath: '../continuation.md' }), /traversal/);
});

test('selected source and output directories cannot be symlinks', async (t) => {
  const root = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'local-resumer-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'outside.md'), 'Outside project.');
  await symlink(path.join(outside, 'outside.md'), path.join(root, 'linked.md'));
  await symlink(outside, path.join(root, 'linked-dir'));
  await symlink(path.join(root, 'plan.md'), path.join(root, 'internal-link.md'));
  for (const selectedPath of ['linked.md', 'linked-dir/outside.md', 'internal-link.md']) {
    await assert.rejects(checkpoint(root, { files: [selectedPath] }), /Symlinks are not allowed/);
  }
  await assert.rejects(checkpoint(root, { statePath: 'linked-dir/checkpoint.json' }), /Symlinks are not allowed/);
  await checkpoint(root);
  await assert.rejects(resume(root, { outputPath: 'linked-dir/report.md' }), /Symlinks are not allowed/);
  await unlink(path.join(root, 'plan.md'));
  await symlink(path.join(outside, 'outside.md'), path.join(root, 'plan.md'));
  await assert.rejects(resume(root), /Symlinks are not allowed/);
});

test('common credential paths are excluded even if explicitly selected', async (t) => {
  const root = await fixture(t);
  for (const selectedPath of ['.env', '.env.local', 'credentials.json', 'secrets.txt', 'key.pem', 'private.key', 'private_key.txt', 'keys/provider.txt', '.aws/config', '.ssh/config', '.npmrc', '.netrc', '.git-credentials']) {
    await assert.rejects(checkpoint(root, { files: [selectedPath] }), /Credential, key, environment/);
  }
});

test('oversized and non-text files fail before a checkpoint is written', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'large.txt'), Buffer.alloc(MAX_FILE_BYTES + 1, 65));
  await assert.rejects(checkpoint(root, { files: ['large.txt'] }), /exceeds 65536 bytes/);
  await writeFile(path.join(root, 'binary.txt'), Buffer.from([65, 0, 66]));
  await assert.rejects(checkpoint(root, { files: ['binary.txt'] }), /binary or control/);
  await writeFile(path.join(root, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
  await assert.rejects(checkpoint(root, { files: ['invalid.txt'] }), /not valid UTF-8/);
  await assert.rejects(readFile(path.join(root, '.resumer/checkpoint.json')), { code: 'ENOENT' });
});

test('checkpoint and continuation refuse all existing destinations without modifying them', async (t) => {
  const root = await fixture(t);
  const result = await checkpoint(root);
  const initialState = await readFile(result.statePath, 'utf8');
  await assert.rejects(checkpoint(root, { goal: 'A different goal' }), /Refusing to overwrite/);
  assert.equal(await readFile(result.statePath, 'utf8'), initialState);
  const resumed = await resume(root);
  const initialArtifact = await readFile(resumed.outputPath, 'utf8');
  await assert.rejects(resume(root), /Refusing to overwrite/);
  assert.equal(await readFile(resumed.outputPath, 'utf8'), initialArtifact);
  const initialSource = await readFile(path.join(root, 'plan.md'), 'utf8');
  await assert.rejects(resume(root, { outputPath: 'plan.md' }), /must not overlap/);
  assert.equal(await readFile(path.join(root, 'plan.md'), 'utf8'), initialSource);
});

test('continuation cannot recreate a deleted selected source at its exact path', async (t) => {
  const root = await fixture(t);
  await checkpoint(root);
  await unlink(path.join(root, 'plan.md'));
  await assert.rejects(resume(root, { outputPath: 'plan.md' }), /must not overlap/);
  await assert.rejects(stat(path.join(root, 'plan.md')), { code: 'ENOENT' });
});

test('continuation cannot create directories beneath a deleted selected source', async (t) => {
  const root = await fixture(t);
  await checkpoint(root);
  await unlink(path.join(root, 'plan.md'));
  await assert.rejects(resume(root, { outputPath: 'plan.md/report.md' }), /must not overlap/);
  await assert.rejects(stat(path.join(root, 'plan.md')), { code: 'ENOENT' });
});

test('continuation cannot occupy an ancestor of a deleted nested source', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'drafts'));
  await writeFile(path.join(root, 'drafts/answer.md'), 'Unfinished answer.');
  await checkpoint(root, { files: ['drafts/answer.md'] });
  await rm(path.join(root, 'drafts'), { recursive: true });
  await assert.rejects(resume(root, { outputPath: 'drafts' }), /must not overlap/);
  await assert.rejects(stat(path.join(root, 'drafts')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(root, 'drafts/answer.md')), { code: 'ENOENT' });
});

test('altered checkpoint content cannot silently change comparison evidence', async (t) => {
  const root = await fixture(t);
  const result = await checkpoint(root);
  const state = JSON.parse(await readFile(result.statePath, 'utf8'));
  state.files[0].content = 'Changed without updating its recorded hash.';
  await writeFile(result.statePath, JSON.stringify(state));
  await assert.rejects(resume(root), /integrity check failed/);
});

test('malformed checkpoint errors do not print its raw contents', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, '.resumer'));
  await writeFile(path.join(root, '.resumer/checkpoint.json'), 'private user notes that are not JSON');
  await assert.rejects(resume(root), (error) => /valid UTF-8 JSON/.test(error.message) && !/private user notes/.test(error.message));
});

test('checkpoint cannot be replayed against another root', async (t) => {
  const root = await fixture(t);
  const otherRoot = await fixture(t);
  const result = await checkpoint(root);
  await mkdir(path.join(otherRoot, '.resumer'));
  await writeFile(path.join(otherRoot, '.resumer/checkpoint.json'), await readFile(result.statePath));
  await assert.rejects(resume(otherRoot), /different project root/);
});

test('missing parent directory counts as a deleted selected file', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'drafts'));
  await writeFile(path.join(root, 'drafts/answer.md'), 'Unfinished answer.');
  await checkpoint(root, { files: ['drafts/answer.md'] });
  await rm(path.join(root, 'drafts'), { recursive: true });
  assert.deepEqual((await resume(root)).files, [{ path: 'drafts/answer.md', status: 'deleted' }]);
});

test('UTF-8 BOM survives checkpoint storage and hash validation', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'plan.md'), '\ufeffSaved plan.\n');
  await checkpoint(root);
  assert.equal((await resume(root)).files[0].status, 'unchanged');
});

test('CLI produces real artifacts and rejects invalid arguments without shell execution', async (t) => {
  const root = await fixture(t);
  const help = await execFileAsync(process.execPath, [cliPath, '--help']);
  assert.match(help.stdout, /Runs offline/);
  const saved = await execFileAsync(process.execPath, [cliPath, 'checkpoint', '--root', root, '--state', 'checkpoint.json', '--file', 'plan.md', '--goal', 'Check the demo', '--next-action', 'Review plan', '--blocker', 'Inference unverified', '--decision', 'Keep the test local']);
  assert.equal(JSON.parse(saved.stdout).status, 'checkpoint_created');
  await writeFile(path.join(root, 'plan.md'), 'Updated plan.');
  const resumed = await execFileAsync(process.execPath, [cliPath, 'resume', '--root', root, '--state', 'checkpoint.json', '--out', 'continuation.md']);
  assert.equal(JSON.parse(resumed.stdout).files[0].status, 'changed');
  assert.match(await readFile(path.join(root, 'continuation.md'), 'utf8'), /Updated plan/);
  await assert.rejects(execFileAsync(process.execPath, [cliPath, 'checkpoint', '--root', root]), (error) => error.code === 1 && /Missing required option/.test(error.stderr));
  await assert.rejects(execFileAsync(process.execPath, [cliPath, 'resume', '--state', 'checkpoint.json', '--out', 'out.md', '--command', 'anything']), (error) => error.code === 1 && /Unknown option/.test(error.stderr));
});
