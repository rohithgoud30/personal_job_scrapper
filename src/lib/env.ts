import dotenv from "dotenv";

dotenv.config();

// Setup mistakes (missing key, bad provider, not logged in): never worth retrying.
export class ConfigError extends Error {}

export const env = {
  // Optional DeepInfra provider
  aiApiKey: process.env.AI_API_KEY ?? "",
  aiBaseUrl: process.env.AI_BASE_URL ?? "",
  aiModel: process.env.AI_MODEL ?? "",
  // Optional Gemini provider
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL ?? "",
  // Jev (TypeSafe) for the final per-listing decision
  typesafeApiKey: process.env.TYPESAFE_API_KEY ?? "",
  // Second-opinion model for cases Jev is unsure about: "none" (default), "codex", "deepinfra", or "gemini"
  aiProvider: (process.env.AI_PROVIDER || "none").toLowerCase(),
  titleBatchSize: Number(process.env.TITLE_BATCH_SIZE ?? "0") || 0,
  keywordBatchSize: Number(process.env.KEYWORD_BATCH_SIZE ?? "0") || 0,
  aiRetryDelayMs: Number(process.env.AI_RETRY_DELAY_MS ?? "0") || 0,
  runDateOverride: (process.env.TEST_RUN_DATE ?? "").trim(),
};

export function requireEnv(
  name:
    | "aiApiKey"
    | "aiBaseUrl"
    | "aiModel"
    | "geminiApiKey"
    | "geminiModel"
    | "typesafeApiKey"
): string {
  const value = env[name];
  if (!value) {
    throw new ConfigError(
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
