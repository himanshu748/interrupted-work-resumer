import { createHash } from 'node:crypto';
import { createFreeUsageGuard } from './freeUsage.js';

export const DEFAULT_DEEPGRAM_MODEL = 'aura-2-thalia-en';
const allowedModels = new Set([DEFAULT_DEEPGRAM_MODEL]);
const maximumCharacters = 2000;
const maximumAudioBytes = 10 * 1024 * 1024;

export class NarrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NarrationError';
    this.code = code;
  }
}

export function planNarration({ text, model = DEFAULT_DEEPGRAM_MODEL, maxCharacters } = {}) {
  if (typeof text !== 'string' || !text.trim() || text.includes('\u0000')) {
    throw new NarrationError('invalid_text', 'Provide a nonempty UTF-8 narration file without null characters.');
  }
  if (!allowedModels.has(model)) {
    throw new NarrationError('unsupported_model', `Use the verified model ${DEFAULT_DEEPGRAM_MODEL}.`);
  }
  // UTF-16 length is conservative for non-BMP text relative to Unicode character count.
  if (text.length > maximumCharacters) {
    throw new NarrationError('text_limit', 'A clip may contain at most 2000 characters. Split longer scripts into separate clips.');
  }
  if (maxCharacters !== undefined && (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > maximumCharacters)) {
    throw new NarrationError('invalid_allowance', 'The character allowance must be an integer from 1 to 2000.');
  }
  if (maxCharacters !== undefined && text.length > maxCharacters) {
    throw new NarrationError('allowance_exceeded', 'The narration exceeds the explicit character allowance.');
  }
  return {
    provider: 'deepgram', model, encoding: 'mp3', requestedCalls: 1,
    characters: text.length, unicodeCodePoints: Array.from(text).length,
    inputSha256: sha256(Buffer.from(text, 'utf8')),
    maxCharacters: maxCharacters ?? null,
    costVerified: false,
  };
}

export async function generateNarration({ text, model = DEFAULT_DEEPGRAM_MODEL, maxCharacters, apiKey }, { fetchImpl, env = process.env } = {}) {
  const plan = planNarration({ text, model, maxCharacters });
  if (maxCharacters === undefined) {
    throw new NarrationError('allowance_required', 'Generation requires an explicit character allowance.');
  }
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) {
    throw new NarrationError('missing_key', 'DEEPGRAM_API_KEY is required for generation.');
  }
  const transport = fetchImpl ?? globalThis.fetch;
  const fixture = fetchImpl !== undefined;
  const freeUsage = fixture ? null : await createFreeUsageGuard({ provider: 'deepgram', env }).reserve({ operation: 'narration-generation' });
  let response;
  try {
    response = await transport(`https://api.deepgram.com/v1/speak?model=${model}&encoding=mp3`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Token ${apiKey}`, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text }),
    });
  } catch {
    throw new NarrationError('request_failed', 'Deepgram request failed. It may have been processed; no automatic retry was attempted.');
  }
  if (!response?.ok) {
    await discard(response);
    const status = Number.isInteger(response?.status) ? response.status : 'unknown';
    throw new NarrationError('provider_rejected', `Deepgram returned HTTP ${status}. No audio was saved and no retry was attempted.`);
  }
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'audio/mpeg') {
    await discard(response);
    throw new NarrationError('invalid_content_type', 'Deepgram did not return MP3 audio. No audio was saved.');
  }
  let metadata;
  try {
    metadata = readMetadata(response.headers, model);
    if (JSON.stringify(metadata).includes(apiKey)) {
      throw new NarrationError('invalid_metadata', 'Deepgram response metadata failed validation. No audio was saved.');
    }
  } catch (error) {
    await discard(response);
    throw error;
  }
  const audio = await readBoundedAudio(response);
  if (!hasMpegAudioFrames(audio)) {
    throw new NarrationError('invalid_audio', 'The response does not contain complete MP3 audio frames. No audio was saved.');
  }
  return {
    audio,
    receipt: {
      version: 1, ...plan,
      transport: fixture ? 'test-fixture' : 'deepgram-api',
      liveGenerationVerified: !fixture,
      generatedAt: new Date().toISOString(), freeUsage,
      audioSha256: sha256(audio), audioBytes: audio.length,
      validation: 'MP3 frame headers; listening review still required',
      ...metadata,
    },
  };
}

function readMetadata(headers, requestedModel) {
  const requestId = headers.get('dg-request-id');
  const modelName = headers.get('dg-model-name');
  const modelUuid = headers.get('dg-model-uuid');
  const characterHeader = headers.get('dg-char-count');
  const safeIdentifier = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!safeIdentifier.test(requestId ?? '') || !safeIdentifier.test(modelUuid ?? '') || modelName !== requestedModel
      || !/^\d{1,4}$/.test(characterHeader ?? '') || Number(characterHeader) < 1 || Number(characterHeader) > maximumCharacters) {
    throw new NarrationError('invalid_metadata', 'Deepgram response metadata is missing or does not match the requested model. No audio was saved.');
  }
  return { requestId, modelName, modelUuid, providerCharacters: Number(characterHeader) };
}

async function readBoundedAudio(response) {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumAudioBytes)) {
    await discard(response);
    throw new NarrationError('audio_limit', 'The response exceeds the 10 MiB audio limit. No audio was saved.');
  }
  const chunks = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new NarrationError('empty_audio', 'Deepgram returned an empty audio response.');
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumAudioBytes) {
        await reader.cancel().catch(() => {});
        throw new NarrationError('audio_limit', 'The response exceeds the 10 MiB audio limit. No audio was saved.');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof NarrationError) throw error;
    throw new NarrationError('audio_read_failed', 'Audio transfer failed. It may have been billed; no automatic retry was attempted.');
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function hasMpegAudioFrames(audio) {
  let offset = 0;
  if (audio.subarray(0, 3).toString('ascii') === 'ID3') {
    if (audio.length < 10 || audio.subarray(6, 10).some((byte) => byte > 127)) return false;
    offset = 10 + audio[6] * 2 ** 21 + audio[7] * 2 ** 14 + audio[8] * 2 ** 7 + audio[9];
    if (audio[5] & 0x10) offset += 10;
  }
  for (let frame = 0; frame < 2; frame++) {
    if (offset + 4 > audio.length || audio[offset] !== 0xff || (audio[offset + 1] & 0xe0) !== 0xe0) return false;
    const version = (audio[offset + 1] >> 3) & 3;
    const layer = (audio[offset + 1] >> 1) & 3;
    const bitrateIndex = audio[offset + 2] >> 4;
    const sampleIndex = (audio[offset + 2] >> 2) & 3;
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return false;
    const bitrate = (version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[bitrateIndex];
    const sampleRate = [44100, 48000, 32000][sampleIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    offset += Math.floor((version === 3 ? 144000 : 72000) * bitrate / sampleRate) + ((audio[offset + 2] >> 1) & 1);
    if (offset > audio.length) return false;
  }
  return true;
}

async function discard(response) {
  try { await response?.body?.cancel(); } catch { /* Never expose provider response bodies or transport errors. */ }
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
