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
  const systemPrompt = Array.isArray(prompts)
    ? prompts.join(" ")
    : [
        "You filter job titles and remove only the roles that are clearly NOT about modern web/full-stack engineering.",
        "Keep only roles that match: frontend (React, Angular, Next.js, TypeScript/JavaScript), backend (Java/Spring Boot, Python/FastAPI/Django/Flask, Node.js/Express), or full-stack across those. Cloud/microservices are fine only when paired with these stacks.",
        "Remove roles that are obviously outside this scope: data/ETL (Snowflake, Informatica, Data Engineer), BI/analytics, QA/SDET, security, SRE/DevOps-only, mobile native (iOS/Android), IT support, PM/BA/ Scrum Master, ERP/CRM (Salesforce, SAP, ServiceNow, Oracle), mainframe/COBOL/Perl/C/C++, hardware/embedded/firmware, design-only (UX/UI without coding), helpdesk. Also remove Go/Golang, .NET, C#, and Staff, Senior, Lead, Principal, Manager, Director, VP, Head of, or Architect roles.",
        "Explicitly REJECT any role with 'Staff', 'Senior', 'Sr', 'Lead', 'Principal', 'Manager', 'Director', 'VP', 'Head of', or 'Architect' in the title (e.g., 'Senior Developer', 'Staff Engineer', 'Team Lead', 'Principal Engineer'), even if the technical stack matches. ALSO REJECT irrelevant stacks even if they mention web terms (e.g., '.NET/C#', 'Golang', 'Data Engineer', 'Salesforce', 'ServiceNow', 'Embedded', 'C++').",
        "If a title is ambiguous or might fit the target stacks, KEEP it. Only remove when it is clearly irrelevant to those stacks.",
        'Return JSON { "remove": [ { "job_id": string, "reason": string } ] }. reason must be one concise clause (e.g., "Data engineer / ETL role"). If every listing is relevant, return an empty array.',
        "Use only the provided title/company/location/url fields.",
      ].join(" ");

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

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const completion = await client.chat.completions.create({
          model: env.aiTitleFilterModel || "glm-4.5-air",
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
        });

        const message = completion.choices[0]?.message?.content ?? "{}";
        const parsed: AiIrrelevantResponse = JSON.parse(message);

        if (Array.isArray(parsed.remove)) {
          for (const entry of parsed.remove) {
            const id = (entry?.job_id ?? "").trim();
            if (!id) continue;
            combinedRemovalSet.add(id);
            const reason =
              typeof entry?.reason === "string" &&
              entry.reason.trim().length > 0
                ? entry.reason.trim()
                : "Marked irrelevant.";
            combinedReasons.set(id, reason);
          }
        }

        if (!combinedRemovalSet.size && Array.isArray(parsed.removeJobIds)) {
          for (const id of parsed.removeJobIds) {
            if (typeof id === "string" && id.trim()) {
              combinedRemovalSet.add(id.trim());
            }
          }
        }

        batchSuccess = true;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
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

  const systemPrompt = Array.isArray(prompts)
    ? prompts.join(" ")
    : [
        "You read a job description and decide if it fits these web/backend/full-stack stacks: frontend (React or Angular, React Native, TypeScript/JavaScript), backend (Java/Spring Boot, Python FastAPI/Django/Flask, or Node.js/Express), or full stack combining those. React Native can be standalone or paired with those backends. Cloud is fine only as a complement to these stacks.",
        "Reject roles that are primarily: data engineering/ETL (Snowflake, Informatica, Data Engineer), business analyst/PM, infrastructure/ops/observability-only, non-software roles, legacy tech (COBOL, Perl, C/C++, mainframe), Go/Golang, .NET/C#, generic cloud-only without the web stacks, or Staff, Senior, Lead, Principal, Manager, Director, VP, Head of, or Architect roles.",
        "REJECT all 'Staff', 'Senior', 'Sr', 'Lead', 'Principal', 'Manager', 'Director', 'VP', 'Head of', or 'Architect' roles regardless of the stack.",
        'Visa Requirements: You MUST ACCEPT roles that explicitly allow "OPT" or "STEM OPT", or have no specific visa restrictions mentioned. If visa status is NOT mentioned, ACCEPT the role. You MUST REJECT roles that are restricted to "H1B", "H4", "GC", or "US Citizen" ONLY (e.g., "USC/GC/H1B only", "Only H1B", "H4/H1B only", "No OPT"). If the description explicitly lists "OPT" or "STEM OPT" as acceptable, ACCEPT it even if other visas are listed.',
        'Return JSON { "accepted": boolean, "reasoning": string } and set accepted=true only if the stack aligns with the above, the visa requirements are met (or not mentioned), AND the experience requirement is suitable. EXPERIENCE RULES: 1. If experience is NOT mentioned, ACCEPT IT. 2. If a range is given (e.g., "3-5 years", "5-8 years", "4-9 years"), ACCEPT IT if the MINIMUM is 5 years or less. 3. ACCEPT "5+ years", "5 years", "3+ years". 4. ACCEPT parallel experience (e.g., 4y React + 3y Java). 5. ONLY REJECT if the MINIMUM required experience is STRICTLY GREATER than 5 years (e.g., "6+ years", "minimum 6 years", "7-10 years", "at least 6 years"). The reasoning should be a concise one-liner.',
      ].join(" ");

  const modelName = env.aiDetailEvalModel || "gemini-2.0-flash-exp";
  const model = getVertexModel(modelName, systemPrompt);

  const userContent = `Title: ${payload.title}\nCompany: ${payload.company}\nLocation: ${payload.location}\nURL: ${payload.url}\nDescription:\n${payload.description}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: userContent }] }],
      });

      const responseText =
        result.response.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      const parsed = JSON.parse(responseText);
      return {
        accepted: Boolean(parsed.accepted),
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      };
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleepBackoff(attempt);
      }
    }
  }

  throw lastError ?? new Error("Detail AI evaluation failed after retries.");
}

function sleepBackoff(attempt: number): Promise<void> {
  const delayMs = attempt * 5000;
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
