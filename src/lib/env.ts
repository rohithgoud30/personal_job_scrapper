import dotenv from 'dotenv';

dotenv.config();

export const env = {
  openRouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
  keywordBatchSize: Number(process.env.KEYWORD_BATCH_SIZE ?? '5') || 5,
  runDateOverride: (process.env.TEST_RUN_DATE ?? '').trim()
};

export function requireEnv(name: 'openRouterApiKey' | 'openRouterBaseUrl'): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required for this feature.`);
  }
  return value;
}

export function getRunDateOverride(): Date | null {
  if (!env.runDateOverride) {
    return null;
  }
  const parsed = new Date(env.runDateOverride);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid TEST_RUN_DATE value: ${env.runDateOverride}`);
  }
  return parsed;
}
