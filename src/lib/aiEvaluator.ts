import OpenAI from "openai";
import { VertexAI, GenerativeModel } from "@google-cloud/vertexai";
import { env, requireEnv, requireNumericEnv } from "./env";
import { loadConfig, SiteConfig } from "./config";

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
let vertexAiClient: VertexAI | null = null;

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

function getVertexClient(): VertexAI {
  if (!vertexAiClient) {
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    if (!project) {
      throw new Error(
        "GOOGLE_CLOUD_PROJECT environment variable is required but not set. Please add it to your .env file."
      );
    }

    const location = requireEnv("googleCloudLocation");

    vertexAiClient = new VertexAI({
      project,
      location,
    });
  }
  return vertexAiClient;
}

function getVertexModel(
  modelName: string,
  systemInstruction?: string
): GenerativeModel {
  const client = getVertexClient();
  return client.getGenerativeModel({
    model: modelName,
    systemInstruction: systemInstruction
      ? { role: "system", parts: [{ text: systemInstruction }] }
      : undefined,
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0,
    },
  });
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

  const config = await loadConfig();
  const prompts = config.ai?.prompts?.titleFilter;

  if (!prompts || prompts.length === 0) {
    throw new Error(
      "Title filter prompts not found in config.json. Please add 'ai.prompts.titleFilter' to your config file."
    );
  }

  console.log("[AI] Loaded title filter prompt from config.");

  const systemPrompt = Array.isArray(prompts) ? prompts.join(" ") : prompts;

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

    // 2 attempts: first with primary model, then fallback to GLM
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        let modelToUse: string;
        let isVertex = false;

        if (attempt === 1) {
          modelToUse = requireEnv("aiTitleFilterModel");
        } else {
          modelToUse = requireEnv("fallbackAiDetailEvalModel");
        }

        if (modelToUse.startsWith("gemini-")) {
          isVertex = true;
        }

        console.log(`[AI] Attempt ${attempt}/2: Using model ${modelToUse}...`);

        if (isVertex) {
          const vertexModel = getVertexModel(modelToUse, systemPrompt);
          const result = await vertexModel.generateContent({
            contents: [{ role: "user", parts: [{ text: userContent }] }],
          });
          const responseText =
            result.response.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

          // Detect HTML error pages (rate-limit/block responses)
          if (responseText.trim().startsWith("<!DOCTYPE") || responseText.trim().startsWith("<html")) {
            throw new Error(
              `API returned HTML instead of JSON (likely rate-limited or blocked). Response preview: ${responseText.slice(0, 100)}...`
            );
          }

          const parsed: AiIrrelevantResponse = JSON.parse(responseText);
          processTitleResponse(parsed, combinedRemovalSet, combinedReasons);
        } else {
          const client = getOpenAiClient();
          const completion = await client.chat.completions.create({
            model: modelToUse,
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userContent },
            ],
          });

          const message = completion.choices[0]?.message?.content ?? "{}";

          // Detect HTML error pages
          if (message.trim().startsWith("<!DOCTYPE") || message.trim().startsWith("<html")) {
            throw new Error(
              `API returned HTML instead of JSON (likely rate-limited or blocked). Response preview: ${message.slice(0, 100)}...`
            );
          }

          const parsed: AiIrrelevantResponse = JSON.parse(message);
          processTitleResponse(parsed, combinedRemovalSet, combinedReasons);
        }

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
      // Always continue to next batch - never throw
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
  const config = await loadConfig();
  const prompts =
    siteConfig?.ai?.prompts?.detailEvaluation ||
    config.ai?.prompts?.detailEvaluation;

  if (!prompts || prompts.length === 0) {
    throw new Error(
      "Detail evaluation prompts not found in config.json. Please add 'ai.prompts.detailEvaluation' to your config file."
    );
  }

  console.log("[AI] Loaded detail evaluation prompt from config.");

  const systemPrompt = Array.isArray(prompts) ? prompts.join(" ") : prompts;

  const modelName = requireEnv("aiDetailEvalModel");
  // We don't instantiate the model here anymore because we might switch models/clients in the loop.

  const userContent = `Title: ${payload.title}\nCompany: ${payload.company}\nLocation: ${payload.location}\nURL: ${payload.url}\nDescription:\n${payload.description}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Fallback to OpenAI on any retry (attempt 2+)
      // This handles token limits, timeouts, or any other Vertex AI errors.
      const useFallback = attempt >= 2;
      const fallbackModel = requireEnv("fallbackAiDetailEvalModel");

      if (useFallback) {
        console.log(
          `[AI] Attempt ${attempt}: Using fallback model ${fallbackModel}...`
        );
        const client = getOpenAiClient();
        const completion = await client.chat.completions.create({
          model: fallbackModel,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
        });

        const message = completion.choices[0]?.message?.content ?? "{}";
        const parsed = JSON.parse(message);
        return {
          accepted: Boolean(parsed.accepted),
          reasoning:
            typeof parsed.reasoning === "string" ? parsed.reasoning : "",
        };
      } else {
        // Use Primary Vertex Model
        console.log(
          `[AI] Attempt ${attempt}: Using primary model ${modelName}...`
        );
        const model = getVertexModel(modelName, systemPrompt);
        const result = await model.generateContent({
          contents: [{ role: "user", parts: [{ text: userContent }] }],
        });

        const responseText =
          result.response.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        const parsed = JSON.parse(responseText);
        return {
          accepted: Boolean(parsed.accepted),
          reasoning:
            typeof parsed.reasoning === "string" ? parsed.reasoning : "",
        };
      }
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
  const delayMs = attempt * baseDelay;
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
