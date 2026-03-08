import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { env, requireEnv, requireNumericEnv } from "./env";
import { loadConfig, SiteConfig } from "./config";
import { sleep } from "./throttle";

export interface TitleEntry {
  title: string;
  company: string;
  location: string;
  url: string;
  job_id: string;
}

export interface DetailPayload {
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
}

interface AiIrrelevantResponse {
  remove?: { job_id?: string; reason?: string }[];
  removeJobIds?: string[];
}

export interface TitleFilterResult {
  removalSet: Set<string>;
  reasons: Map<string, string>;
}

let openAiClient: OpenAI | null = null;
let geminiClient: GoogleGenAI | null = null;

function getOpenAiClient(): OpenAI {
  if (!openAiClient) {
    const apiKey = requireEnv("aiApiKey");
    openAiClient = new OpenAI({
      apiKey,
      baseURL: env.aiBaseUrl,
    });
  }
  return openAiClient;
}

function getGeminiClient(): GoogleGenAI {
  if (!geminiClient) {
    const apiKey = requireEnv("geminiApiKey");
    geminiClient = new GoogleGenAI({ apiKey });
  }
  return geminiClient;
}

function assertNotHtml(text: string): void {
  const trimmed = text.trim();
  if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html")) {
    throw new Error(
      `API returned HTML instead of JSON (likely rate-limited or blocked). Response preview: ${text.slice(0, 100)}...`
    );
  }
}

async function callGemini(
  model: string,
  systemPrompt: string,
  userContent: string
): Promise<string> {
  const client = getGeminiClient();
  const result = await client.models.generateContent({
    model,
    contents: userContent,
    config: {
      systemInstruction: systemPrompt,
      temperature: 0,
      responseMimeType: "application/json",
    },
  });
  const responseText = result.text || "{}";
  assertNotHtml(responseText);
  return responseText;
}

async function callOpenAi(
  model: string,
  systemPrompt: string,
  userContent: string
): Promise<string> {
  const client = getOpenAiClient();
  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  });
  const message = completion.choices[0]?.message?.content ?? "{}";
  assertNotHtml(message);
  return message;
}

function isGeminiProvider(): boolean {
  return requireEnv("aiProvider") === "gemini";
}

async function callAi(
  model: string,
  systemPrompt: string,
  userContent: string
): Promise<string> {
  if (isGeminiProvider()) {
    return callGemini(model, systemPrompt, userContent);
  }
  return callOpenAi(model, systemPrompt, userContent);
}

function normalizePrompt(prompts: string | string[]): string {
  return Array.isArray(prompts) ? prompts.join(" ") : prompts;
}

export async function findIrrelevantJobIds(
  entries: TitleEntry[]
): Promise<TitleFilterResult> {
  if (!entries.length) {
    return { removalSet: new Set(), reasons: new Map() };
  }

  const BATCH_SIZE = requireNumericEnv("titleBatchSize");
  const combinedRemovalSet = new Set<string>();
  const combinedReasons = new Map<string, string>();

  const config = loadConfig();
  const prompts = config.ai?.prompts?.titleFilter;

  if (!prompts || prompts.length === 0) {
    throw new Error(
      "Title filter prompts not found in config.json. Please add 'ai.prompts.titleFilter' to your config file."
    );
  }

  console.log("[AI] Loaded title filter prompt from config.");

  const systemPrompt = normalizePrompt(prompts);

  let failedBatches = 0;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const userContent = JSON.stringify(batch, null, 2);
    let batchSuccess = false;

    console.log(
      `[AI] Processing title batch ${
        Math.floor(i / BATCH_SIZE) + 1
      }/${Math.ceil(entries.length / BATCH_SIZE)} (${batch.length} items)...`
    );

    // 2 attempts: first with primary model, then fallback
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const modelToUse =
          attempt === 1
            ? requireEnv("aiTitleFilterModel")
            : requireEnv("fallbackAiDetailEvalModel");

        console.log(`[AI] Attempt ${attempt}/2: Using model ${modelToUse}...`);

        const responseText = await callAi(modelToUse, systemPrompt, userContent);
        const parsed: AiIrrelevantResponse = JSON.parse(responseText);
        processTitleResponse(parsed, combinedRemovalSet, combinedReasons);

        batchSuccess = true;
        break;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const isRateLimitOrHtml =
          errorMsg.includes("HTML instead of JSON") ||
          errorMsg.includes("rate") ||
          errorMsg.includes("429") ||
          errorMsg.includes("<!DOCTYPE");

        console.warn(
          `[AI] Attempt ${attempt}/2 for title batch failed:`,
          isRateLimitOrHtml ? errorMsg : error
        );

        if (attempt < 2) {
          await sleepBackoff(attempt);
        }
      }
    }

    if (!batchSuccess) {
      failedBatches++;
      console.warn(
        `[AI] Failed to process title batch ${Math.floor(i / BATCH_SIZE) + 1} after 2 attempts. Moving to next batch. (${batch.length} jobs will pass through without AI filtering)`
      );
    }
  }

  if (failedBatches > 0) {
    console.warn(
      `[AI] Title filtering completed with ${failedBatches} failed batch(es). Some jobs passed through without filtering.`
    );
  }

  return { removalSet: combinedRemovalSet, reasons: combinedReasons };
}

export async function evaluateJobDetail(
  payload: DetailPayload,
  siteConfig?: SiteConfig
): Promise<{ accepted: boolean; reasoning: string }> {
  const config = loadConfig();
  const prompts =
    siteConfig?.ai?.prompts?.detailEvaluation ||
    config.ai?.prompts?.detailEvaluation;

  if (!prompts || prompts.length === 0) {
    throw new Error(
      "Detail evaluation prompts not found in config.json. Please add 'ai.prompts.detailEvaluation' to your config file."
    );
  }

  console.log("[AI] Loaded detail evaluation prompt from config.");

  const systemPrompt = normalizePrompt(prompts);

  const modelName = requireEnv("aiDetailEvalModel");

  const userContent = `Title: ${payload.title}\nCompany: ${payload.company}\nLocation: ${payload.location}\nURL: ${payload.url}\nDescription:\n${payload.description}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const useFallback = attempt >= 2;

      let responseText: string;
      if (useFallback) {
        const fallbackModel = requireEnv("fallbackAiDetailEvalModel");
        console.log(
          `[AI] Attempt ${attempt}: Using fallback model ${fallbackModel}...`
        );
        responseText = await callOpenAi(fallbackModel, systemPrompt, userContent);
      } else {
        console.log(
          `[AI] Attempt ${attempt}: Using primary model ${modelName}...`
        );
        responseText = await callAi(modelName, systemPrompt, userContent);
      }

      const parsed = JSON.parse(responseText);
      return {
        accepted: Boolean(parsed.accepted),
        reasoning:
          typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      };
    } catch (error) {
      console.warn(`[AI] Attempt ${attempt} failed:`, error);
      lastError = error;
      if (attempt < 3) {
        await sleepBackoff(attempt);
      }
    }
  }

  throw lastError ?? new Error("Detail AI evaluation failed after retries.");
}

function processTitleResponse(
  parsed: AiIrrelevantResponse,
  combinedRemovalSet: Set<string>,
  combinedReasons: Map<string, string>
) {
  if (Array.isArray(parsed.remove)) {
    for (const entry of parsed.remove) {
      const id = (entry?.job_id ?? "").trim();
      if (!id) continue;
      combinedRemovalSet.add(id);
      const reason =
        typeof entry?.reason === "string" && entry.reason.trim().length > 0
          ? entry.reason.trim()
          : "Marked irrelevant.";
      combinedReasons.set(id, reason);
    }
  }

  if (Array.isArray(parsed.removeJobIds)) {
    for (const id of parsed.removeJobIds) {
      if (typeof id === "string" && id.trim()) {
        combinedRemovalSet.add(id.trim());
      }
    }
  }
}

function sleepBackoff(attempt: number): Promise<void> {
  const baseDelay = requireNumericEnv("aiRetryDelayMs");
  return sleep((attempt * baseDelay) / 1000);
}
