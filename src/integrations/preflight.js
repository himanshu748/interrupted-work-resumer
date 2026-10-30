import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInferenceRuntime } from './runtime.js';

export async function runPreflight({ chat = false, env = process.env, fetchImpl } = {}) {
  const runtime = createInferenceRuntime({ env, fetchImpl });
  const result = await runtime.catalog();
  if (!chat) return { ...result, liveChat: null };
  const { value, inference } = await runtime.generate({
    purpose: 'token-factory-preflight', schemaName: 'token_factory_preflight',
    schema: { type: 'object', additionalProperties: false, required: ['result'], properties: { result: { const: 'token-factory-preflight-ok', type: 'string' } } },
    system: 'Return the required JSON object with result set to token-factory-preflight-ok.',
    input: { task: 'Check structured inference connectivity only.' }, maxTokens: 64,
  });
  return { ...result, status: inference.liveInferenceVerified ? 'live_inference_verified' : 'fixture_inference_verified',
    liveInferenceVerified: inference.liveInferenceVerified, liveChat: { value, inference },
    note: 'Structured inference connectivity only. This does not verify any product workflow, Sandbox execution, or Cloud Job.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((argument) => argument !== '--chat') || process.argv.slice(2).length > 1) throw new Error('Use no arguments for catalog inspection, or --chat for one guarded structured inference request.');
    try { process.loadEnvFile('.env'); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not load local .env configuration.'); }
    console.log(JSON.stringify(await runPreflight({ chat: process.argv.includes('--chat') }), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'not_verified', reason: error.message }, null, 2));
    process.exitCode = /NEBIUS_API_KEY/.test(error.message) ? 78 : 1;
  }
}
