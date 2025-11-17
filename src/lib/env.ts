import dotenv from 'dotenv';

dotenv.config();

export const env = {
  openRouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
  keywordBatchSize: Number(process.env.KEYWORD_BATCH_SIZE ?? '5') || 5
};

export function requireEnv(name: 'openRouterApiKey' | 'openRouterBaseUrl'): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required for this feature.`);
  }
  return value;
}
