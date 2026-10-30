import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_FILES = 50;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_NOTE_LENGTH = 4000;
const FORBIDDEN_NAMES = /^(?:\.env(?:\..*)?|\.git|\.git-credentials|\.ssh|\.aws|\.azure|\.kube|\.docker|\.npmrc|\.netrc|\.pypirc|gcloud|keys?|private[-_]?keys?|secrets?|credentials?|tokens?|api[-_]?keys?|id_(?:rsa|dsa|ecdsa|ed25519))(?:\..*)?$/i;
const FORBIDDEN_EXTENSIONS = /\.(?:key|pem|p12|pfx|keystore|jks)$/i;

// Shared by the managed local service so it can reuse the same selection,
// integrity, and exclusive-write boundaries without writing into source roots.
export { relativePath, snapshot, note, notes, validateState, writeNew, readLimited, decodeText };

function fail(message) {
  throw new Error(message);
}

function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value)) {
    fail('File paths must be nonempty relative paths without backslashes or control characters.');
  }
  if (path.isAbsolute(value) || /^[a-z]:/i.test(value)) fail('Absolute file paths are not allowed.');
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    fail('File paths must not contain empty, dot, or parent traversal segments.');
  }
  if (parts.some((part) => FORBIDDEN_NAMES.test(part) || FORBIDDEN_EXTENSIONS.test(part))) {
    fail('Credential, key, environment, and private configuration paths are excluded.');
  }
  return parts;
}

async function projectRoot(value) {
  const root = await realpath(value);
  if (!(await lstat(root)).isDirectory()) fail('Project root must be a directory.');
  return root;
}

// Refuse symlinks even when they currently point inside the root. The explicit
// selection must name the actual file, and output directories must be ordinary.
async function inspectPath(root, selectedPath, { createParents = false } = {}) {
  const parts = relativePath(selectedPath);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const isParent = index < parts.length - 1;
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (isParent && createParents) {
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if (mkdirError.code !== 'EEXIST') throw mkdirError;
        }
        stat = await lstat(current);
      } else {
        return { absolutePath: path.join(root, ...parts), exists: false };
      }
    }
    if (stat.isSymbolicLink()) fail(`Symlinks are not allowed: ${selectedPath}`);
    if (isParent && !stat.isDirectory()) fail(`Path parent is not a directory: ${selectedPath}`);
    if (!isParent && !stat.isFile()) fail(`Selected path is not a regular file: ${selectedPath}`);
  }
  return { absolutePath: current, exists: true };
}

async function readLimited(root, selectedPath, limit, { allowMissing = false } = {}) {
  const checked = await inspectPath(root, selectedPath);
  if (!checked.exists) {
    if (allowMissing) return null;
    fail(`Selected file does not exist: ${selectedPath}`);
  }
  const handle = await open(checked.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail(`Selected path is not a regular file: ${selectedPath}`);
    if (stat.size > limit) fail(`File exceeds ${limit} bytes: ${selectedPath}`);
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await handle.read(bytes, count, bytes.length - count, count);
      if (result.bytesRead === 0) break;
      count += result.bytesRead;
    }
    if (count > limit) fail(`File exceeds ${limit} bytes: ${selectedPath}`);
    return bytes.subarray(0, count);
  } finally {
    await handle.close();
  }
}

function decodeText(bytes, selectedPath) {
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail(`Selected file is not valid UTF-8 text: ${selectedPath}`);
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) {
    fail(`Selected file contains binary or control characters: ${selectedPath}`);
  }
  return content;
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function snapshot(root, selectedPath, allowMissing = false) {
  const bytes = await readLimited(root, selectedPath, MAX_FILE_BYTES, { allowMissing });
  return bytes === null ? null : {
    path: selectedPath,
    sha256: hash(bytes),
    bytes: bytes.length,
    content: decodeText(bytes, selectedPath),
  };
}

function note(value, name, required = false) {
  if (typeof value !== 'string' || value.length > MAX_NOTE_LENGTH || (required && !value.trim())) {
    fail(`${name} must be ${required ? 'nonempty text' : 'text'} of at most ${MAX_NOTE_LENGTH} characters.`);
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail(`${name} contains unsupported control characters.`);
  return value;
}

function notes(values, name) {
  if (!Array.isArray(values) || values.length > 20) fail(`${name} must contain at most 20 entries.`);
  return values.map((value) => note(value, name, true));
}

function validateState(state, root) {
  if (!state || state.version !== 1 || state.kind !== 'local-resumer-checkpoint') fail('Unsupported checkpoint format.');
  if (state.projectRoot !== root) fail('Checkpoint belongs to a different project root.');
  if (typeof state.createdAt !== 'string' || !Number.isFinite(Date.parse(state.createdAt))) fail('Checkpoint has an invalid timestamp.');
  note(state.goal, 'Goal', true);
  note(state.nextAction, 'Next action', true);
  notes(state.blockers, 'Blockers');
  notes(state.decisions, 'Decisions');
  if (!Array.isArray(state.files) || state.files.length < 1 || state.files.length > MAX_FILES) fail('Checkpoint has an invalid file selection.');
  const seen = new Set();
  for (const file of state.files) {
    if (!file || typeof file !== 'object') fail('Checkpoint contains an invalid file record.');
    relativePath(file.path);
    if (seen.has(file.path)) fail('Checkpoint contains duplicate selected paths.');
    seen.add(file.path);
    if (typeof file.content !== 'string') fail(`Checkpoint content is missing: ${file.path}`);
    const bytes = Buffer.from(file.content, 'utf8');
    if (bytes.length > MAX_FILE_BYTES || bytes.length !== file.bytes || hash(bytes) !== file.sha256) {
      fail(`Checkpoint content integrity check failed: ${file.path}`);
    }
    decodeText(bytes, file.path);
  }
  return state;
}

async function writeNew(root, selectedPath, content) {
  const checked = await inspectPath(root, selectedPath, { createParents: true });
  if (checked.exists) fail(`Refusing to overwrite existing file: ${selectedPath}`);
  const handle = await open(checked.absolutePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return checked.absolutePath;
}

export async function createCheckpoint({ root: rootInput, files, statePath, goal, nextAction, blockers = [], decisions = [] }) {
  const root = await projectRoot(rootInput);
  relativePath(statePath);
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) fail(`Select between 1 and ${MAX_FILES} files.`);
  files.forEach(relativePath);
  if (new Set(files).size !== files.length) fail('Select each file only once.');
  const state = {
    version: 1,
    kind: 'local-resumer-checkpoint',
    projectRoot: root,
    createdAt: new Date().toISOString(),
    goal: note(goal, 'Goal', true),
    nextAction: note(nextAction, 'Next action', true),
    blockers: notes(blockers, 'Blockers'),
    decisions: notes(decisions, 'Decisions'),
    files: [],
  };
  for (const selectedPath of [...files].sort()) state.files.push(await snapshot(root, selectedPath));
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) fail('Checkpoint exceeds the state size limit.');
  const absolutePath = await writeNew(root, statePath, content);
  return { status: 'checkpoint_created', statePath: absolutePath, selectedFileCount: state.files.length };
}

function markdown(value) {
  return value.replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}

function fileLink(root, selectedPath) {
  const destination = path.join(root, selectedPath).split(path.sep).map(encodeURIComponent).join('/');
  return `[${markdown(selectedPath)}](<${destination}>)`;
}

function excerpt(lines, start) {
  if (lines.length === 0) return '    (no lines)';
  const shown = lines.slice(0, 20).map((line, index) => `    ${start + index + 1}: ${line}`).join('\n');
  return `${shown}${lines.length > 20 ? `\n    ... ${lines.length - 20} additional lines omitted` : ''}`;
}

// A bounded common-prefix/suffix comparison provides literal evidence. It does
// not pretend to understand whether a changed requirement affects an action.
function changeExcerpt(before, after) {
  const oldLines = before.split('\n');
  const newLines = after === null ? [] : after.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  return `Before (checkpoint):\n\n${excerpt(removed, prefix)}\n\nAfter (current file):\n\n${excerpt(added, prefix)}`;
}

export function renderContinuation({ state, root, statePath, comparisons, observedAt }) {
  const count = (status) => comparisons.filter((file) => file.status === status).length;
  const lines = [
    '# Continue this project', '',
    'This artifact was produced by deterministic local file comparison. No model ran, no commands were executed, and no task or blocker was marked complete.', '',
    `Checkpoint: ${fileLink(root, statePath)} · ${state.createdAt}`,
    `Observed: ${observedAt}`, '',
    '## Saved goal', '', markdown(state.goal), '',
    '## Starting action saved by the user', '', markdown(state.nextAction), '',
    'Review this action against the changes below before continuing. Its relevance has not been validated.', '',
    '## Saved decisions', '',
    ...(state.decisions.length ? state.decisions.map((value) => `- ${markdown(value)}`) : ['No decisions were recorded.']), '',
    'These are saved user statements, not independently checked facts.', '',
    '## Blockers to revalidate', '',
    ...(state.blockers.length ? state.blockers.map((value) => `- [ ] Unvalidated: ${markdown(value)}`) : ['No blockers were recorded. This does not establish that the project is unblocked.']), '',
    '## Selected-file comparison', '',
    `${count('changed')} changed · ${count('deleted')} deleted · ${count('unchanged')} unchanged. Only the files explicitly selected in the checkpoint were inspected. New, unselected files are outside this report.`, '',
    '| Selected file | Observation |', '| --- | --- |',
    ...comparisons.map((file) => `| ${file.status === 'deleted' ? `${markdown(file.path)} (missing; prior content is in the checkpoint)` : fileLink(root, file.path)} | ${file.status} |`), '',
    '## Change evidence', '',
  ];
  for (const file of comparisons.filter((item) => item.status !== 'unchanged')) {
    lines.push(`### ${markdown(file.path)}: ${file.status}`, '', changeExcerpt(file.before.content, file.after?.content ?? null), '');
  }
  if (!comparisons.some((item) => item.status !== 'unchanged')) lines.push('The selected file bytes match the checkpoint. This does not prove that external dependencies or project requirements are unchanged.', '');
  lines.push('## Continuation checklist', '', '- [ ] Review changed or missing sources and update the saved action if needed.', '- [ ] Recheck each recorded blocker using current evidence.', '- [ ] Carry out the chosen next action and verify its actual result.', '', 'The resumer has prepared this document only. It has not performed the saved action, resolved blockers, inspected unselected files, or assessed task completion.', '');
  return lines.join('\n');
}

export async function resumeProject({ root: rootInput, statePath, outputPath }) {
  const root = await projectRoot(rootInput);
  relativePath(outputPath);
  const bytes = await readLimited(root, statePath, MAX_STATE_BYTES);
  let state;
  try {
    state = JSON.parse(decodeText(bytes, statePath));
  } catch {
    fail('Checkpoint must contain valid UTF-8 JSON.');
  }
  validateState(state, root);
  const normalizedOutputPath = relativePath(outputPath).join('/');
  for (const file of state.files) {
    const selectedPath = relativePath(file.path).join('/');
    if (normalizedOutputPath === selectedPath || normalizedOutputPath.startsWith(`${selectedPath}/`) || selectedPath.startsWith(`${normalizedOutputPath}/`)) {
      fail(`Continuation output must not overlap a selected source path: ${file.path}`);
    }
  }
  const comparisons = [];
  for (const before of state.files) {
    const after = await snapshot(root, before.path, true);
    comparisons.push({ path: before.path, status: after === null ? 'deleted' : after.sha256 === before.sha256 ? 'unchanged' : 'changed', before, after });
  }
  const artifact = renderContinuation({ state, root, statePath, comparisons, observedAt: new Date().toISOString() });
  const absolutePath = await writeNew(root, outputPath, artifact);
  return {
    status: 'continuation_created',
    outputPath: absolutePath,
    files: comparisons.map(({ path: selectedPath, status }) => ({ path: selectedPath, status })),
    blockersValidated: false,
    nextActionExecuted: false,
  };
}
