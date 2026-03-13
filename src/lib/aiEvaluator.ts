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

/* ── Clients (lazy singletons) ── */

let deepinfraClient: OpenAI | null = null;
let geminiClient: GoogleGenAI | null = null;

function getDeepinfraClient(): OpenAI {
  if (!deepinfraClient) {
    deepinfraClient = new OpenAI({
      apiKey: requireEnv("aiApiKey"),
      baseURL: requireEnv("aiBaseUrl"),
    });
  }
  return deepinfraClient;
}

function getGeminiClient(): GoogleGenAI {
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey: requireEnv("geminiApiKey") });
  }
  return geminiClient;
}

/* ── Provider calls ── */

function assertNotHtml(text: string): void {
  const trimmed = text.trim();
  if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html")) {
    throw new Error(
      `API returned HTML instead of JSON (likely rate-limited or blocked). Response preview: ${text.slice(0, 100)}...`
    );
  }
}

async function callDeepinfra(
  model: string,
  systemPrompt: string,
  userContent: string
): Promise<string> {
  const client = getDeepinfraClient();
  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt + "\n\nIMPORTANT: Respond with valid JSON only. No markdown, no code fences, no extra text." },
      { role: "user", content: userContent },
    ],
  });
  const message = completion.choices[0]?.message?.content ?? "{}";
  assertNotHtml(message);
  return extractJson(message);
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  // If it's already valid JSON, return as-is
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }
  // Extract from markdown code fence
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return trimmed;
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

/* ── Provider routing ── */

type Provider = "deepinfra" | "gemini";

function getProvider(): "deepinfra" | "gemini" | "both" {
  const p = env.aiDefaultProvider;
  if (p === "gemini" || p === "both") return p;
  return "deepinfra";
}

// Cached model names — resolved once on first use
let cachedModels: { deepinfra: string; gemini: string } | null = null;

function getModels(): { deepinfra: string; gemini: string } {
  if (!cachedModels) {
    const mode = getProvider();
    cachedModels = {
      deepinfra:
        mode !== "gemini" ? requireEnv("aiModel") : "",
      gemini:
        mode !== "deepinfra" ? requireEnv("geminiModel") : "",
    };
  }
  return cachedModels;
}

function callByProvider(
  provider: Provider,
  systemPrompt: string,
  userContent: string
): Promise<string> {
  const models = getModels();
  if (provider === "deepinfra") {
    return callDeepinfra(models.deepinfra, systemPrompt, userContent);
  }
  return callGemini(models.gemini, systemPrompt, userContent);
}

function getProviderSequence(retries: number): Provider[] {
  const mode = getProvider();
  if (mode === "both") {
    return ["deepinfra", ...Array<Provider>(retries - 1).fill("gemini")];
  }
  return Array<Provider>(retries).fill(mode);
}

/* ── Shared retry helper ── */

async function callWithRetry<T>(
  providers: Provider[],
  systemPrompt: string,
  userContent: string,
  parseResponse: (raw: string) => T,
  label: string
): Promise<T> {
  const retryDelay = requireNumericEnv("aiRetryDelayMs");
  let lastError: unknown;

  for (let attempt = 1; attempt <= providers.length; attempt++) {
    try {
      const provider = providers[attempt - 1];
      console.log(`[AI] ${label} attempt ${attempt}/${providers.length}: Using ${provider}...`);

      const responseText = await callByProvider(provider, systemPrompt, userContent);
      return parseResponse(responseText);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isRateLimitOrHtml =
        errorMsg.includes("HTML instead of JSON") ||
        errorMsg.includes("rate") ||
        errorMsg.includes("429") ||
        errorMsg.includes("<!DOCTYPE");

      console.warn(
        `[AI] ${label} attempt ${attempt}/${providers.length} failed:`,
        isRateLimitOrHtml ? errorMsg : error
      );
      lastError = error;

      if (attempt < providers.length) {
        await sleep((attempt * retryDelay) / 1000);
      }
    }
  }

  throw lastError ?? new Error(`${label} failed after ${providers.length} attempts.`);
}

/* ── Helpers ── */

function normalizePrompt(prompts: string | string[]): string {
  return Array.isArray(prompts) ? prompts.join(" ") : prompts;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      await fn(items[i]);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
}

/* ── Title filter ── */

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
  const providers = getProviderSequence(2);

  // Build batches
  const batches: TitleEntry[][] = [];
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    batches.push(entries.slice(i, i + BATCH_SIZE));
  }

  let failedBatches = 0;
  const totalBatches = batches.length;

  const CONCURRENCY = 3;

  await runWithConcurrency(batches, CONCURRENCY, async (batch) => {
    const batchIndex = batches.indexOf(batch) + 1;
    const userContent = JSON.stringify(batch, null, 2);
    const label = `Title batch ${batchIndex}/${totalBatches}`;

    console.log(`[AI] Processing ${label} (${batch.length} items)...`);

    try {
      const parsed = await callWithRetry<AiIrrelevantResponse>(
        providers,
        systemPrompt,
        userContent,
        (raw) => JSON.parse(raw),
        label
      );
      processTitleResponse(parsed, combinedRemovalSet, combinedReasons);
    } catch {
      failedBatches++;
      console.warn(
        `[AI] Failed ${label} after ${providers.length} attempts. (${batch.length} jobs will pass through without AI filtering)`
      );
    }
  });

  if (failedBatches > 0) {
    console.warn(
      `[AI] Title filtering completed with ${failedBatches} failed batch(es). Some jobs passed through without filtering.`
    );
  }

  return { removalSet: combinedRemovalSet, reasons: combinedReasons };
}

/* ── Detail evaluation ── */

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
  const userContent = `Title: ${payload.title}\nCompany: ${payload.company}\nLocation: ${payload.location}\nURL: ${payload.url}\nDescription:\n${payload.description}`;

  return callWithRetry(
    getProviderSequence(3),
    systemPrompt,
    userContent,
    (raw) => {
      const parsed = JSON.parse(raw);
      return {
        accepted: Boolean(parsed.accepted),
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      };
    },
    "Detail eval"
  );
}

/* ── Internal helpers ── */

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
