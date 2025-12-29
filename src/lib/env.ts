import dotenv from "dotenv";

dotenv.config();

export const env = {
  aiApiKey: process.env.AI_API_KEY ?? "",
  aiBaseUrl: process.env.AI_BASE_URL ?? "",
  aiTitleFilterModel: process.env.AI_TITLE_FILTER_MODEL ?? "",
  aiDetailEvalModel: process.env.AI_DETAIL_EVAL_MODEL ?? "",
  fallbackAiDetailEvalModel: process.env.FALLBACK_AI_DETAIL_EVAL_MODEL ?? "",
  googleCloudLocation: process.env.GOOGLE_CLOUD_LOCATION ?? "",
  titleBatchSize: Number(process.env.TITLE_BATCH_SIZE ?? "0") || 0,
  keywordBatchSize: Number(process.env.KEYWORD_BATCH_SIZE ?? "0") || 0,
  aiRetryDelayMs: Number(process.env.AI_RETRY_DELAY_MS ?? "0") || 0,
  runDateOverride: (process.env.TEST_RUN_DATE ?? "").trim(),
};

export function requireEnv(
  name:
    | "aiApiKey"
    | "aiBaseUrl"
    | "aiTitleFilterModel"
    | "aiDetailEvalModel"
    | "fallbackAiDetailEvalModel"
    | "googleCloudLocation"
): string {
  const value = env[name];
  if (!value) {
    throw new Error(
      `Environment variable ${name} is required but not set. Please add it to your .env file.`
    );
  }
  return value;
}

export function requireNumericEnv(
  name: "titleBatchSize" | "keywordBatchSize" | "aiRetryDelayMs"
): number {
  const value = env[name];
  if (!value || value <= 0) {
    throw new Error(
      `Environment variable ${name} must be a positive number. Please add it to your .env file.`
    );
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
  const date = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0)
  );
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid TEST_RUN_DATE value: ${env.runDateOverride}`);
  }
  return date;
}
