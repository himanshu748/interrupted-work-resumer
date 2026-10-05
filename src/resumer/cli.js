#!/usr/bin/env node
import { createCheckpoint, resumeProject } from './core.js';

const HELP = `Local interrupted-work resumer

Explicitly snapshot selected text files, then prepare a continuation document
from their current state. Runs offline; no AI inference or task execution.

Usage:
  node src/resumer/cli.js checkpoint --root DIR --state PATH --file PATH [...]
    --goal TEXT --next-action TEXT [--blocker TEXT] [--decision TEXT]
  node src/resumer/cli.js resume --root DIR --state PATH --out PATH
  node src/resumer/cli.js --help

--root          Project directory (defaults to the current directory).
--state         Relative checkpoint JSON path. Required for both commands.
--file          Explicit relative text file to save; repeat to select more.
--goal          User-supplied project goal. Required for checkpoint.
--next-action   User-supplied starting action. Required for checkpoint.
--blocker       Saved, unvalidated blocker; repeat as needed.
--decision      Saved user decision; repeat as needed.
--out           Relative continuation Markdown path. Required for resume.

All file paths are relative to --root. Outputs must not already exist.
The CLI refuses traversal, symlinks, common credential paths, binary text,
files over 64 KiB, and selections over 50 files. Parent output directories
are created as needed. Checkpoints contain the selected files' full contents.

Exit codes: 0 = artifact created/help shown; 1 = refused or failed.
See outputs/resumer-README.md for a repeatable offline example.
`;

function parse(args) {
  const [command, ...rest] = args;
  if (command !== 'checkpoint' && command !== 'resume') throw new Error('Expected checkpoint or resume. Use --help for usage.');
  const allowed = new Set(command === 'checkpoint'
    ? ['--root', '--state', '--file', '--goal', '--next-action', '--blocker', '--decision']
    : ['--root', '--state', '--out']);
  const repeated = new Set(['--file', '--blocker', '--decision']);
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    if (!allowed.has(key)) throw new Error(`Unknown option: ${key}. Use --help for usage.`);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}.`);
    if (repeated.has(key)) (options[key] ??= []).push(value);
    else {
      if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: ${key}.`);
      options[key] = value;
    }
  }
  const required = command === 'checkpoint' ? ['--state', '--file', '--goal', '--next-action'] : ['--state', '--out'];
  for (const key of required) if (!options[key]) throw new Error(`Missing required option: ${key}.`);
  return { command, options };
}

try {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help')) {
    process.stdout.write(HELP);
  } else {
    const { command, options } = parse(args);
    const common = { root: options['--root'] ?? process.cwd(), statePath: options['--state'] };
    const result = command === 'checkpoint'
      ? await createCheckpoint({ ...common, files: options['--file'], goal: options['--goal'], nextAction: options['--next-action'], blockers: options['--blocker'], decisions: options['--decision'] })
      : await resumeProject({ ...common, outputPath: options['--out'] });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`Resumer: ${error.message}\n`);
  process.exitCode = 1;
}
