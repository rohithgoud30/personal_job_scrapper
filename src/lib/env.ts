import dotenv from 'dotenv';

dotenv.config();

export const env = {
  zAiApiKey: process.env.ZAI_API_KEY ?? '',
  zAiBaseUrl: process.env.ZAI_BASE_URL ?? 'https://api.z.ai/api/paas/v4/',
  keywordBatchSize: Number(process.env.KEYWORD_BATCH_SIZE ?? '5') || 5,
  runDateOverride: (process.env.TEST_RUN_DATE ?? '').trim()
};

export function requireEnv(name: 'zAiApiKey' | 'zAiBaseUrl'): string {
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
  const match = env.runDateOverride.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid TEST_RUN_DATE value: ${env.runDateOverride}`);
  }
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid TEST_RUN_DATE value: ${env.runDateOverride}`);
  }
  return date;
}
