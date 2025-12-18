import OpenAI from "openai";
import { VertexAI, GenerativeModel } from "@google-cloud/vertexai";
import { env, requireEnv } from "./env";
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
    const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";

    if (!project) {
      throw new Error("GOOGLE_CLOUD_PROJECT environment variable is missing.");
    }

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

  const BATCH_SIZE = 50;
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

  const client = getOpenAiClient();

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const userContent = JSON.stringify(batch, null, 2);
    let lastError: unknown;
    let batchSuccess = false;

    console.log(
      `[AI] Processing title batch ${
        Math.floor(i / BATCH_SIZE) + 1
      }/${Math.ceil(entries.length / BATCH_SIZE)} (${batch.length} items)...`
    );

    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        let completion;
        if (attempt === 3) {
          // 2nd Fallback: gemini-3-flash-preview (Vertex AI)
          console.log(
            `[AI] Attempt ${attempt}: Using 2nd fallback model gemini-3-flash-preview...`
          );
          const vertexModel = getVertexModel(
            "gemini-3-flash-preview",
            systemPrompt
          );
          const result = await vertexModel.generateContent({
            contents: [{ role: "user", parts: [{ text: userContent }] }],
          });
          const responseText =
            result.response.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
          const parsed: AiIrrelevantResponse = JSON.parse(responseText);
          processTitleResponse(parsed, combinedRemovalSet, combinedReasons);
        } else {
          const client = getOpenAiClient();
          let modelToUse: string;

          if (attempt === 1) {
            modelToUse = env.aiTitleFilterModel || "glm-4.5-air";
            console.log(
              `[AI] Attempt ${attempt}: Using primary model ${modelToUse}...`
            );
          } else if (attempt === 2) {
            modelToUse = env.fallbackAiDetailEvalModel || "glm-4.5-air"; // Reusing this for now as a generic fallback
            console.log(
              `[AI] Attempt ${attempt}: Using 1st fallback model ${modelToUse}...`
            );
          } else {
            // attempt 4
            modelToUse = "glm-4.5-air";
            console.log(
              `[AI] Attempt ${attempt}: Using final fallback model ${modelToUse}...`
            );
          }

          completion = await client.chat.completions.create({
            model: modelToUse,
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userContent },
            ],
          });

          const message = completion.choices[0]?.message?.content ?? "{}";
          const parsed: AiIrrelevantResponse = JSON.parse(message);
          processTitleResponse(parsed, combinedRemovalSet, combinedReasons);
        }

        batchSuccess = true;
        break;
      } catch (error) {
        lastError = error;
        console.warn(`[AI] Attempt ${attempt} for title batch failed:`, error);
        if (attempt < 4) {
          await sleepBackoff(attempt);
        }
      }
    }

    if (!batchSuccess) {
      console.error(
        `[AI] Failed to process title batch starting at index ${i}`,
        lastError
      );
      throw lastError ?? new Error("Title AI filter failed after retries.");
    }
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

  const modelName = env.aiDetailEvalModel || "gemini-2.0-flash-exp";
  // We don't instantiate the model here anymore because we might switch models/clients in the loop.

  const userContent = `Title: ${payload.title}\nCompany: ${payload.company}\nLocation: ${payload.location}\nURL: ${payload.url}\nDescription:\n${payload.description}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      if (attempt === 3) {
        // 2nd Fallback: gemini-3-flash-preview (Vertex AI)
        console.log(
          `[AI] Attempt ${attempt}: Using 2nd fallback model gemini-3-flash-preview...`
        );
        const model = getVertexModel("gemini-3-flash-preview", systemPrompt);
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

      // Attempts 1, 2, and 4 use specialized OpenAI or generic fallback logic
      let modelToUse: string;
      let isVertex = false;

      if (attempt === 1) {
        modelToUse = env.aiDetailEvalModel || "gemini-2.0-flash-exp";
        // Check if primary is intended for Vertex
        if (modelToUse.startsWith("gemini-")) {
          isVertex = true;
        }
      } else if (attempt === 2) {
        modelToUse = env.fallbackAiDetailEvalModel || "glm-4.5-air";
        if (modelToUse.startsWith("gemini-")) {
          isVertex = true;
        }
      } else {
        // attempt 4: Final fallback glm
        modelToUse = "glm-4.5-air";
      }

      console.log(`[AI] Attempt ${attempt}: Using model ${modelToUse}...`);

      if (isVertex) {
        const model = getVertexModel(modelToUse, systemPrompt);
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
        const parsed = JSON.parse(message);
        return {
          accepted: Boolean(parsed.accepted),
          reasoning:
            typeof parsed.reasoning === "string" ? parsed.reasoning : "",
        };
      }
    } catch (error) {
      console.warn(`[AI] Attempt ${attempt} failed:`, error);
      lastError = error;
      if (attempt < 4) {
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
  const delayMs = attempt * 5000;
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
