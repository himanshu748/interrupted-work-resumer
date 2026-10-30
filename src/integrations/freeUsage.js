import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_LEDGER = fileURLToPath(new URL('../../work/free-usage/', import.meta.url));
const PREFIXES = Object.freeze({
  'nebius-token-factory': 'NEBIUS_TOKEN_FACTORY', 'nebius-sandbox': 'NEBIUS_SANDBOX',
  'nebius-cloud': 'NEBIUS_CLOUD', deepgram: 'DEEPGRAM', tavily: 'TAVILY',
});
const ATTESTATION_LIFETIME = 24 * 60 * 60 * 1000;

export class FreeUsageError extends Error {
  constructor(code, message) { super(message); this.name = 'FreeUsageError'; this.code = code; this.statusCode = 403; }
}

// This local attestation cannot verify a balance or disable provider autopay.
// The account must already be confirmed free-credit-only, with sufficient
// allowance for the bounded operation. Limits count attempts, not dollars.
export function createFreeUsageGuard({ provider, env = process.env, ledgerRoot = env.FREE_USAGE_LEDGER_DIR || DEFAULT_LEDGER, now = Date.now } = {}) {
  const prefix = PREFIXES[provider];
  if (!prefix) throw new FreeUsageError('invalid_provider', 'Unsupported free-usage provider.');
  if (typeof ledgerRoot !== 'string' || !path.isAbsolute(ledgerRoot)) throw new FreeUsageError('invalid_ledger', 'Free-usage ledger must be an absolute local directory.');
  const confirmed = env[`${prefix}_FREE_ONLY_CONFIRMED`] === 'true';
  const verifiedAt = env[`${prefix}_FREE_VERIFIED_AT`] ?? '';
  const rawLimit = env[`${prefix}_FREE_REQUEST_LIMIT`] ?? '';
  const limit = /^[1-9]\d{0,2}$/.test(rawLimit) ? Number(rawLimit) : 0;
  const verifiedTime = Date.parse(verifiedAt);
  const validDate = Number.isFinite(verifiedTime) && new Date(verifiedTime).toISOString() === verifiedAt;
  function status() {
    const age = now() - verifiedTime;
    const fresh = validDate && age >= 0 && age < ATTESTATION_LIFETIME;
    return {
      provider, enabled: confirmed && fresh && limit >= 1 && limit <= 100,
      accountFreeOnlyAttested: confirmed, attestationFresh: fresh,
      requestLimit: limit >= 1 && limit <= 100 ? limit : null,
      providerBalanceVerified: false, providerBillingControlled: false,
      ledgerScope: env.FREE_USAGE_LEDGER_DIR ? 'explicit-shared-directory' : 'checkout-default',
      requiredVariables: ['FREE_ONLY_CONFIRMED', 'FREE_VERIFIED_AT', 'FREE_REQUEST_LIMIT'].map((suffix) => `${prefix}_${suffix}`),
      note: 'Local attestation and lifetime attempt limit only. Confirm free-only account settings and sufficient credits separately. Failed or uncertain attempts consume a slot; no automatic reset or retry.',
    };
  }
  async function reserve({ operation } = {}) {
    if (typeof operation !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(operation)) throw new FreeUsageError('invalid_operation', 'Unsupported free-usage operation.');
    if (!status().enabled) throw new FreeUsageError('free_usage_not_confirmed', `Live ${provider} usage is blocked. Set ${prefix}_FREE_ONLY_CONFIRMED=true, a fresh ${prefix}_FREE_VERIFIED_AT, and ${prefix}_FREE_REQUEST_LIMIT only after verifying free-only account settings and sufficient credits.`);
    try {
      // Walk each component so an existing symlink cannot redirect the ledger.
      const absolute = path.resolve(ledgerRoot);
      let current = path.parse(absolute).root;
      for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        const stat = await lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe ledger.');
      }
      const directory = path.join(absolute, provider);
      try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe provider ledger.');
      for (let slot = 1; slot <= limit; slot++) {
        let file;
        try { file = await open(path.join(directory, `${slot}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
        catch (error) { if (error.code === 'EEXIST') continue; throw error; }
        // Creation itself consumes this slot. Never remove/refund it on failure,
        // process interruption, malformed responses, or an unknown outcome.
        const reservation = { version: 1, provider, operation, slot, requestLimit: limit,
          reservedAt: new Date(now()).toISOString(), attestedAt: verifiedAt,
          accountFreeOnlyAttested: true, providerBalanceVerified: false, providerBillingControlled: false };
        try { await file.writeFile(`${JSON.stringify(reservation)}\n`); await file.sync(); }
        finally { await file.close(); }
        const handle = await open(directory, constants.O_RDONLY);
        try { await handle.sync(); } finally { await handle.close(); }
        return reservation;
      }
    } catch {
      throw new FreeUsageError('free_usage_ledger_unavailable', 'Free-usage allowance could not be reserved safely. No provider request was made. Inspect the local ledger before retrying.');
    }
    throw new FreeUsageError('free_usage_limit_reached', `The local ${provider} attempt allowance is exhausted. Review provider usage and saved reservations before explicitly increasing the limit.`);
  }
  return { status, reserve };
}
