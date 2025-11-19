import OpenAI from "openai";
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

function getClient(): OpenAI {
  if (!openAiClient) {
    const apiKey = requireEnv("aiApiKey");
    openAiClient = new OpenAI({
      apiKey,
      baseURL: env.aiBaseUrl,
    });
  }
  return openAiClient;
}

export async function findIrrelevantJobIds(
  entries: TitleEntry[]
): Promise<TitleFilterResult> {
  if (!entries.length) {
    return { removalSet: new Set(), reasons: new Map() };
  }

  const config = await loadConfig();
  const prompts = config.ai?.prompts?.titleFilter;
  const systemPrompt = Array.isArray(prompts)
    ? prompts.join(" ")
    : [
        "You filter job titles and remove only the roles that are clearly NOT about modern web/full-stack engineering.",
        "Keep only roles that match: frontend (React, Angular, Next.js, TypeScript/JavaScript), backend (Java/Spring Boot, Python/FastAPI/Django/Flask, Node.js/Express), or full-stack across those. Cloud/microservices are fine only when paired with these stacks.",
        "Remove roles that are obviously outside this scope: data/ETL (Snowflake, Informatica, Data Engineer), BI/analytics, QA/SDET, security, SRE/DevOps-only, mobile native (iOS/Android), IT support, PM/BA/ Scrum Master, ERP/CRM (Salesforce, SAP, ServiceNow, Oracle), mainframe/COBOL/Perl/C/C++, hardware/embedded/firmware, design-only (UX/UI without coding), helpdesk. Also remove Go/Golang, .NET, and C# roles.",
        "If a title is ambiguous or might fit the target stacks, KEEP it. Only remove when it is clearly irrelevant to those stacks.",
        'Return JSON { "remove": [ { "job_id": string, "reason": string } ] }. reason must be one concise clause (e.g., "Data engineer / ETL role"). If every listing is relevant, return an empty array.',
        "Use only the provided title/company/location/url fields.",
      ].join(" ");

  const client = getClient();
  const userContent = JSON.stringify(entries, null, 2);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const completion = await client.chat.completions.create({
        model: env.aiTitleFilterModel || "gpt-3.5-turbo",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      });

      const message = completion.choices[0]?.message?.content ?? "{}";
      const parsed: AiIrrelevantResponse = JSON.parse(message);
      const removalSet = new Set<string>();
      const reasons = new Map<string, string>();

      if (Array.isArray(parsed.remove)) {
        for (const entry of parsed.remove) {
          const id = (entry?.job_id ?? "").trim();
          if (!id) continue;
          removalSet.add(id);
          const reason =
            typeof entry?.reason === "string" && entry.reason.trim().length > 0
              ? entry.reason.trim()
              : "Marked irrelevant.";
          reasons.set(id, reason);
        }
      }

      if (!removalSet.size && Array.isArray(parsed.removeJobIds)) {
        for (const id of parsed.removeJobIds) {
          if (typeof id === "string" && id.trim()) {
            removalSet.add(id.trim());
          }
        }
      }

      return { removalSet, reasons };
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleepBackoff(attempt);
      }
    }
  }

  throw lastError ?? new Error("Title AI filter failed after retries.");
}

export async function evaluateJobDetail(
  payload: DetailPayload,
  siteConfig?: SiteConfig
): Promise<{ accepted: boolean; reasoning: string }> {
  const config = await loadConfig();
  // Prioritize site-specific prompts if available, otherwise fall back to global
  const prompts =
    siteConfig?.ai?.prompts?.detailEvaluation ||
    config.ai?.prompts?.detailEvaluation;

  const systemPrompt = Array.isArray(prompts)
    ? prompts.join(" ")
    : [
        "You read a job description and decide if it fits these web/backend/full-stack stacks: frontend (React or Angular, React Native, TypeScript/JavaScript), backend (Java/Spring Boot, Python FastAPI/Django/Flask, or Node.js/Express), or full stack combining those. React Native can be standalone or paired with those backends. Cloud is fine only as a complement to these stacks.",
        "Reject roles that are primarily: data engineering/ETL (Snowflake, Informatica, Data Engineer), business analyst/PM, infrastructure/ops/observability-only, non-software roles, legacy tech (COBOL, Perl, C/C++, mainframe), Go/Golang, .NET/C#, or generic cloud-only without the web stacks.",
        'Visa Requirements: You MUST ACCEPT roles that explicitly allow "OPT" or "STEM OPT", or have no specific visa restrictions mentioned. You MUST REJECT roles that are restricted to "H1B", "H4", "GC", or "US Citizen" ONLY (e.g., "USC/GC/H1B only", "Only H1B", "H4/H1B only", "No OPT"). If the description explicitly lists "OPT" or "STEM OPT" as acceptable, ACCEPT it even if other visas are listed.',
        'Return JSON { "accepted": boolean, "reasoning": string } and set accepted=true only if the stack aligns with the above, the visa requirements are met (or not mentioned), AND the experience requirement is at least five years but below six years. Accept phrases like "5 years", "5+ years", "up to 5 years", "1-5 years". Reject anything that explicitly includes six or more years (e.g., "6 years", "6+ years", "5-7 years", "6-8 years", "7-10 years", "at least six years"). The reasoning should be a concise one-liner explaining accept/reject.',
      ].join(" ");

  const client = getClient();
  const userContent = `Title: ${payload.title}\nCompany: ${payload.company}\nLocation: ${payload.location}\nURL: ${payload.url}\nDescription:\n${payload.description}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const completion = await client.chat.completions.create({
        model: env.aiDetailEvalModel || "gpt-4",
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
