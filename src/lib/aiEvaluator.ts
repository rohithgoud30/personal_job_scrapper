import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { ConfigError, env, requireEnv, requireNumericEnv } from "./env";
import { loadConfig, SiteConfig } from "./config";
import { sleep } from "./throttle";
import { getCodexCredentials } from "./codexAuth";

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

export interface TitleFilterResult {
  removalSet: Set<string>;
  reasons: Map<string, string>;
}

/* ── Second-opinion models ── */

// Jev judges every title and listing. AI_PROVIDER picks the model that settles the cases
// Jev is unsure about: codex (gpt-6-luna via ChatGPT OAuth, `pnpm auth:login`), deepinfra,
// gemini, or none (Jev decides alone).
const CODEX_MODEL = "gpt-6-luna";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const JSON_ONLY_SUFFIX =
  "\n\nIMPORTANT: Respond with valid JSON only. No markdown, no code fences, no extra text.";

const PROVIDER_NAMES = ["none", "codex", "deepinfra", "gemini"] as const;
type Provider = (typeof PROVIDER_NAMES)[number];

function getProvider(): Provider {
  const p = env.aiProvider as Provider;
  if (PROVIDER_NAMES.includes(p)) return p;
  throw new ConfigError(`AI_PROVIDER must be ${PROVIDER_NAMES.join(", ")}. Got '${p}'.`);
}

async function callCodex(systemPrompt: string, userContent: string): Promise<string> {
  const { accessToken, accountId } = await getCodexCredentials();
  // Token may rotate between calls, so build a client per call.
  const client = new OpenAI({
    apiKey: accessToken,
    baseURL: CODEX_BASE_URL,
    defaultHeaders: { "chatgpt-account-id": accountId, originator: "codex_cli_rs" },
  });
  // The ChatGPT backend only supports streamed, unstored Responses calls.
  const stream = await client.responses.create({
    model: CODEX_MODEL,
    instructions: systemPrompt + JSON_ONLY_SUFFIX,
    input: [{ role: "user", content: userContent }],
    store: false,
    stream: true,
  });
  let message = "";
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") message += event.delta;
  }
  return message;
}

let deepinfraClient: OpenAI | null = null;

async function callDeepinfra(systemPrompt: string, userContent: string): Promise<string> {
  deepinfraClient ??= new OpenAI({
    apiKey: requireEnv("aiApiKey"),
    baseURL: requireEnv("aiBaseUrl"),
  });
  const completion = await deepinfraClient.chat.completions.create({
    model: requireEnv("aiModel"),
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt + JSON_ONLY_SUFFIX },
      { role: "user", content: userContent },
    ],
  });
  return completion.choices[0]?.message?.content ?? "";
}

let geminiClient: GoogleGenAI | null = null;

async function callGemini(systemPrompt: string, userContent: string): Promise<string> {
  geminiClient ??= new GoogleGenAI({ apiKey: requireEnv("geminiApiKey") });
  const result = await geminiClient.models.generateContent({
    model: requireEnv("geminiModel"),
    contents: userContent,
    config: {
      systemInstruction: systemPrompt,
      temperature: 0,
      responseMimeType: "application/json",
    },
  });
  return result.text ?? "";
}

const MODELS = { codex: callCodex, deepinfra: callDeepinfra, gemini: callGemini };

async function callModel(systemPrompt: string, userContent: string): Promise<string> {
  const provider = getProvider();
  if (provider === "none") throw new ConfigError("No second-opinion model configured.");
  const text = await MODELS[provider](systemPrompt, userContent);
  if (/^\s*<(!DOCTYPE|html)/i.test(text)) {
    throw new Error(`API returned HTML instead of JSON (likely rate-limited or blocked): ${text.slice(0, 100)}...`);
  }
  return extractJson(text || "{}");
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  // Extract from markdown code fence
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  // Skip any leading prose before the first { or [
  const jsonStart = trimmed.search(/[{[]/);
  return jsonStart > 0 ? trimmed.slice(jsonStart) : trimmed;
}

/* ── Retry helper ── */

async function callWithRetry<T>(
  attempts: number,
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  const retryDelay = requireNumericEnv("aiRetryDelayMs");
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      // Don't retry setup errors or malformed responses
      if (error instanceof ConfigError) throw error;
      if (error instanceof SyntaxError) {
        console.warn(`[AI] ${label} attempt ${attempt}/${attempts} failed with parse error:`, error.message);
        throw error;
      }
      console.warn(
        `[AI] ${label} attempt ${attempt}/${attempts} failed:`,
        error instanceof Error ? error.message : error
      );
      lastError = error;
      if (attempt < attempts) {
        await sleep((attempt * retryDelay) / 1000);
      }
    }
  }

  throw lastError ?? new Error(`${label} failed after ${attempts} attempts.`);
}

/* ── Helpers ── */

function normalizePrompt(prompts: string | string[]): string {
  return Array.isArray(prompts) ? prompts.join(" ") : prompts;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0;
  // Safe: index++ is synchronous before each await, so no race in Node's single-threaded loop
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
}

/* ── Jev (TypeSafe System One) ── */

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
// Jev's state budget is 32k tokens; ~4 chars per token leaves room for the policy.
const MAX_DESCRIPTION_CHARS = 80_000;
// ponytail: untuned cut-offs on P(reject). Jev decides outside the band; inside it the
// second-opinion model decides (or Jev at 0.5 when there is none). Tune on real rejections.
const UNSURE_LOW = 0.3;
const UNSURE_HIGH = 0.7;

export interface JevChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
}

export interface JevJudgment {
  pReject: number;
  reason: string;
}

async function askJev(
  state: unknown,
  questions: Record<string, object>
): Promise<Record<string, JevChoiceAnswer>> {
  const res = await fetch(JEV_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("typesafeApiKey")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "jev-latest", state, questions }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    if (res.status === 401 || res.status === 403 || res.status === 422) {
      throw new ConfigError(`Jev rejected the request (${res.status}): ${body}`);
    }
    throw new Error(`Jev request failed (${res.status}): ${body}`);
  }
  const { answers } = (await res.json()) as { answers: Record<string, JevChoiceAnswer> };
  return answers;
}

// P(any rejection reason) and the likeliest reason.
export function jevJudgment(answer: JevChoiceAnswer, passOption: string): JevJudgment {
  const pReject = 1 - (answer.probabilities[passOption] ?? 0);
  const [option] = Object.entries(answer.probabilities)
    .filter(([o]) => o !== passOption)
    .sort((x, y) => y[1] - x[1])[0] ?? ["rejected"];
  return { pReject, reason: `Jev: ${option.replace(/_/g, " ")} (p=${pReject.toFixed(2)})` };
}

export type Route = "pass" | "reject" | "unsure";

export function route(pReject: number, hasModel: boolean): Route {
  if (hasModel && pReject >= UNSURE_LOW && pReject < UNSURE_HIGH) return "unsure";
  return pReject >= 0.5 ? "reject" : "pass";
}

/* ── Title filter: Jev per batch, unsure titles to the model in one call ── */

// Reject reasons stay generic: the actual rules (stacks, ranks, places, visas) live in config.json.
const TITLE_CRITERIA = {
  keep: "Fits the target roles in `policy`, or is ambiguous and might fit",
  off_stack: "Tech stack or role type that `policy` removes",
  seniority: "Seniority rank in the title that `policy` removes",
  non_us: "Location that `policy` removes",
  local_only: "Local-candidates-only restriction that `policy` removes",
  visa_restricted: "Visa or citizenship terms in the title that `policy` removes",
};

async function jevTitleJudgments(batch: TitleEntry[], policy: string[]): Promise<JevJudgment[]> {
  const state = { policy, jobs: batch.map(({ job_id, ...job }) => job) };
  const questions = Object.fromEntries(
    batch.map((_, i) => [
      String(i),
      {
        type: "choice",
        instructions: `Apply \`policy\` to the job listing \`jobs[${i}]\`: keep it, or pick the reason it must be removed.`,
        criteria: TITLE_CRITERIA,
      },
    ])
  );
  const answers = await askJev(state, questions);
  return batch.map((_, i) => jevJudgment(answers[String(i)], "keep"));
}

function parseTitleRemovals(parsed: any): Map<string, string> {
  const removed = new Map<string, string>();
  for (const entry of Array.isArray(parsed?.remove) ? parsed.remove : []) {
    const id = String(entry?.job_id ?? "").trim();
    if (id) removed.set(id, String(entry?.reason ?? "").trim() || "Marked irrelevant.");
  }
  return removed;
}

export async function findIrrelevantJobIds(
  entries: TitleEntry[]
): Promise<TitleFilterResult> {
  const removalSet = new Set<string>();
  const reasons = new Map<string, string>();
  if (!entries.length) {
    return { removalSet, reasons };
  }

  const prompts = loadConfig().ai?.prompts?.titleFilter;
  if (!prompts || prompts.length === 0) {
    throw new Error(
      "Title filter prompts not found in config.json. Please add 'ai.prompts.titleFilter' to your config file."
    );
  }
  const policy = Array.isArray(prompts) ? prompts : [prompts];

  const BATCH_SIZE = requireNumericEnv("titleBatchSize");
  const batches: TitleEntry[][] = [];
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    batches.push(entries.slice(i, i + BATCH_SIZE));
  }

  const provider = getProvider();
  const hasModel = provider !== "none";
  let failedBatches = 0;
  await runWithConcurrency(batches, 3, async (batch, batchIdx) => {
    const label = `Title batch ${batchIdx + 1}/${batches.length}`;
    try {
      const judgments = await callWithRetry(2, label, () => jevTitleJudgments(batch, policy));
      const unsure: TitleEntry[] = [];
      batch.forEach((job, i) => {
        const decision = route(judgments[i].pReject, hasModel);
        if (decision === "reject") {
          removalSet.add(job.job_id);
          reasons.set(job.job_id, judgments[i].reason);
        } else if (decision === "unsure") {
          unsure.push(job);
        }
      });
      console.log(`[AI] ${label}: Jev judged ${batch.length} titles, ${unsure.length} unsure.`);
      if (!unsure.length) return;

      try {
        const removed = await callWithRetry(2, `${label} second opinion`, async () =>
          parseTitleRemovals(JSON.parse(await callModel(normalizePrompt(prompts), JSON.stringify(unsure))))
        );
        for (const [id, reason] of removed) {
          removalSet.add(id);
          reasons.set(id, `${provider}: ${reason}`);
        }
      } catch (error) {
        // Model unavailable: Jev's own call decides the unsure titles.
        console.warn(`[AI] ${label}: ${provider} second opinion failed; using Jev.`, error instanceof Error ? error.message : error);
        batch.forEach((job, i) => {
          if (unsure.includes(job) && judgments[i].pReject >= 0.5) {
            removalSet.add(job.job_id);
            reasons.set(job.job_id, judgments[i].reason);
          }
        });
      }
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      failedBatches++;
      console.warn(`[AI] Failed ${label}. (${batch.length} jobs will pass through without AI filtering)`);
    }
  });

  if (failedBatches > 0) {
    console.warn(
      `[AI] Title filtering completed with ${failedBatches} failed batch(es). Some jobs passed through without filtering.`
    );
  }
  return { removalSet, reasons };
}

/* ── Final decision: one Jev call per listing, unsure ones to the model ── */

const DETAIL_CRITERIA = {
  accept: "Meets every rule in `policy`",
  off_stack: "Tech stack or role type that `policy` rejects",
  seniority: "Seniority rank that `policy` rejects",
  non_us: "Location that `policy` rejects",
  local_only: "Local-candidates-only restriction that `policy` rejects",
  visa_restricted: "Visa, citizenship, or sponsorship terms that `policy` rejects",
  experience: "Minimum required experience that `policy` rejects",
  employment_type: "Employment type that `policy` rejects",
};

export async function evaluateJobDetail(
  payload: DetailPayload,
  siteConfig?: SiteConfig
): Promise<{ accepted: boolean; reasoning: string }> {
  const prompts =
    siteConfig?.ai?.prompts?.detailEvaluation || loadConfig().ai?.prompts?.detailEvaluation;
  if (!prompts || prompts.length === 0) {
    throw new Error(
      "Detail evaluation prompts not found in config.json. Please add 'ai.prompts.detailEvaluation' to your config file."
    );
  }

  const job = { ...payload, description: payload.description.slice(0, MAX_DESCRIPTION_CHARS) };
  const { decision } = await callWithRetry(3, `Jev final "${payload.title}"`, () =>
    askJev(
      { policy: Array.isArray(prompts) ? prompts : [prompts], job },
      {
        decision: {
          type: "choice",
          instructions:
            "Apply `policy` to `job` (read the full `job.description`): accept it, or pick the main reason it must be rejected.",
          criteria: DETAIL_CRITERIA,
        },
      }
    )
  );
  const judgment = jevJudgment(decision, "accept");
  const provider = getProvider();
  const verdict = route(judgment.pReject, provider !== "none");
  const acceptReason = `Jev: accept (p=${(1 - judgment.pReject).toFixed(2)})`;
  if (verdict !== "unsure") {
    return verdict === "pass"
      ? { accepted: true, reasoning: acceptReason }
      : { accepted: false, reasoning: judgment.reason };
  }

  console.log(`[AI] Jev unsure on "${payload.title}" (p=${judgment.pReject.toFixed(2)}); asking ${provider}.`);
  try {
    const userContent = `Title: ${job.title}\nCompany: ${job.company}\nLocation: ${job.location}\nURL: ${job.url}\nDescription:\n${job.description}`;
    const parsed = await callWithRetry(2, "Final second opinion", async () =>
      JSON.parse(await callModel(normalizePrompt(prompts), userContent))
    );
    const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";
    return { accepted: Boolean(parsed.accepted), reasoning: `${provider}: ${reasoning}` };
  } catch (error) {
    console.warn(`[AI] ${provider} second opinion failed; using Jev.`, error instanceof Error ? error.message : error);
    return judgment.pReject < 0.5
      ? { accepted: true, reasoning: acceptReason }
      : { accepted: false, reasoning: judgment.reason };
  }
}
