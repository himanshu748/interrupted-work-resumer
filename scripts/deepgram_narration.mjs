import { open, lstat, link, unlink, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DEEPGRAM_MODEL, NarrationError, generateNarration, planNarration } from '../src/integrations/deepgramNarration.js';
import { createFreeUsageGuard, FreeUsageError } from '../src/integrations/freeUsage.js';

const usage = 'Usage: node scripts/deepgram_narration.mjs --input script.txt --output clip.mp3 [--model aura-2-thalia-en] [--max-characters 2000] [--generate]\nDefault: dry run with no network or output files. Generation requires --generate, --max-characters, DEEPGRAM_API_KEY, and fresh DEEPGRAM_FREE_ONLY_CONFIRMED / FREE_VERIFIED_AT / FREE_REQUEST_LIMIT settings.\n';

export async function runNarrationCli(argv, { env = process.env, fetchImpl, write = (text) => process.stdout.write(text) } = {}) {
  const options = parseArguments(argv);
  if (options.help) { write(usage); return; }
  const input = path.resolve(options.input);
  const output = path.resolve(options.output);
  const receiptPath = `${output}.receipt.json`;
  if (path.extname(output).toLowerCase() !== '.mp3' || input === output || input === receiptPath) {
    throw new NarrationError('invalid_path', 'Choose a distinct output path ending in .mp3.');
  }
  let text;
  try {
    const inputStat = await lstat(input);
    if (!inputStat.isFile() || inputStat.size > 16_384) throw new Error('invalid input');
    text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(input));
  } catch {
    throw new NarrationError('input_unreadable', 'The input must be a readable UTF-8 regular file no larger than 16 KiB.');
  }
  const model = options.model ?? env.DEEPGRAM_MODEL ?? DEFAULT_DEEPGRAM_MODEL;
  const plan = planNarration({ text, model, maxCharacters: options.maxCharacters });
  await assertAbsent(output);
  await assertAbsent(receiptPath);
  if (!options.generate) {
    write(`${JSON.stringify({ mode: 'dry-run', ...plan, networkRequests: 0, output, receiptPath, credentialConfigured: Boolean(env.DEEPGRAM_API_KEY), freeUsage: createFreeUsageGuard({ provider: 'deepgram', env }).status(), note: 'Character allowance is not a price quote. Generation requires a fresh free-only account attestation and a reserved local allowance.' }, null, 2)}\n`);
    return;
  }
  if (options.maxCharacters === undefined) throw new NarrationError('allowance_required', 'Use --max-characters to authorize a bounded generation request.');
  const lockPath = `${output}.lock`;
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch {
    throw new NarrationError('output_locked', 'The output directory is unavailable or this clip already has a generation lock. No request was made.');
  }
  try {
    await assertAbsent(output);
    await assertAbsent(receiptPath);
    const { audio, receipt } = await generateNarration({ text, model, maxCharacters: options.maxCharacters, apiKey: env.DEEPGRAM_API_KEY }, { fetchImpl, env });
    // Publishing uses same-directory temporary files and exclusive hard links: no partial MP3 and no replacement.
    await publishExclusive(receiptPath, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`));
    try {
      await publishExclusive(output, audio);
    } catch {
      throw new NarrationError('audio_publish_failed', 'Generation succeeded and a receipt was saved, but the audio could not be published. Do not retry without checking the output paths and provider usage.');
    }
    write(`${JSON.stringify({ mode: 'generated', output, receiptPath, ...receipt }, null, 2)}\n`);
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}

function parseArguments(argv) {
  const options = {};
  const valued = { '--input': 'input', '--output': 'output', '--model': 'model', '--max-characters': 'maxCharacters' };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const key = valued[arg] ?? ({ '--generate': 'generate', '--help': 'help' })[arg];
    if (!key || Object.hasOwn(options, key)) throw new NarrationError('invalid_arguments', 'Unknown or duplicate argument. Use --help.');
    if (key === 'generate' || key === 'help') { options[key] = true; continue; }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new NarrationError('invalid_arguments', 'A required argument value is missing. Use --help.');
    if (key === 'maxCharacters' && !/^\d+$/.test(value)) throw new NarrationError('invalid_allowance', 'Use an integer character allowance.');
    options[key] = key === 'maxCharacters' ? Number(value) : value;
  }
  if (!options.help && (!options.input || !options.output)) throw new NarrationError('invalid_arguments', 'Both --input and --output are required. Use --help.');
  return options;
}

async function assertAbsent(filename) {
  try { await lstat(filename); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new NarrationError('output_unavailable', 'An output path could not be inspected. No request was made.');
  }
  throw new NarrationError('output_exists', 'The audio or receipt output already exists. Choose a new output name; existing files are never replaced.');
}

async function publishExclusive(filename, content) {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(content);
    await file.sync();
    await file.close();
    file = null;
    await link(temporary, filename);
  } catch {
    throw new NarrationError('output_publish_failed', 'Generation succeeded but output publication failed. Check output paths and provider usage before retrying.');
  } finally {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runNarrationCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof NarrationError || error instanceof FreeUsageError ? `${error.code}: ${error.message}` : 'narration_failed: Narration preparation failed; no automatic retry was attempted.'}\n`);
    process.exitCode = 1;
  });
}
