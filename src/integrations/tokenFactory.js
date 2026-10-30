export const TOKEN_FACTORY_ENDPOINT = 'https://api.tokenfactory.nebius.com/v1';

export function getTokenFactoryConfig(env = process.env) {
  return { baseUrl: env.NEBIUS_BASE_URL || TOKEN_FACTORY_ENDPOINT, apiKey: env.NEBIUS_API_KEY || '', model: env.NEBIUS_MODEL_ID || '' };
}

// Catalog inspection and production inference must use the same selection rule.
export function chooseCandidateModel(models, preferredModel = '') {
  if (!Array.isArray(models)) return null;
  const candidates = models.filter((entry) => typeof entry?.id === 'string' && /^nvidia\//i.test(entry.id) && /nemotron/i.test(entry.id));
  if (preferredModel) return candidates.find((entry) => entry.id === preferredModel) ?? null;
  return [...candidates].sort((a, b) => (/nano|lightning/i.test(a.id) ? 0 : 1) - (/nano|lightning/i.test(b.id) ? 0 : 1) || a.id.localeCompare(b.id))[0] ?? null;
}
