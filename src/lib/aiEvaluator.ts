import OpenAI from 'openai';
import { env, requireEnv } from './env';

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
  removeJobIds: string[];
}

let openAiClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openAiClient) {
    const apiKey = requireEnv('zAiApiKey');
    openAiClient = new OpenAI({
      apiKey,
      baseURL: env.zAiBaseUrl
    });
  }
  return openAiClient;
}

export async function findIrrelevantJobIds(entries: TitleEntry[]): Promise<Set<string>> {
  if (!entries.length) {
    return new Set();
  }

  const client = getClient();
  const systemPrompt = [
    'You filter job listings for roles that fit these stacks: frontend (React, Angular, Next.js, TypeScript), backend (Java/Spring Boot, Python/FastAPI, Node.js/Express), mobile (React Native), and cloud microservices when paired with those stacks.',
    'Return JSON { "removeJobIds": [ ...job_id... ] } listing only the postings that are clearly NOT related to these stacks/tools.',
    'Use only the provided title/company/location/url fields. If every listing is relevant, return an empty array.'
  ].join(' ');

  const userContent = JSON.stringify(entries, null, 2);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const completion = await client.chat.completions.create({
        model: 'glm-4.6',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ]
      });

      const message = completion.choices[0]?.message?.content ?? '{}';
      const parsed: AiIrrelevantResponse = JSON.parse(message);
      return new Set(parsed.removeJobIds ?? []);
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleepBackoff(attempt);
      }
    }
  }

  throw lastError ?? new Error('Title AI filter failed after retries.');
}

export async function evaluateJobDetail(payload: DetailPayload): Promise<{ accepted: boolean; reasoning: string }> {
  const client = getClient();
  const systemPrompt = [
    'You read a job description and decide if it fits these web/backend/full-stack stacks: frontend (React or Angular, TypeScript/JavaScript), backend (Java/Spring Boot, Python FastAPI/Django/Flask, or Node.js/Express), or full stack combining those. Cloud is fine only as a complement to these stacks.',
    'Reject roles that are primarily: data engineering/ETL (Snowflake, Informatica, ETL), mobile (React Native), business analyst/PM, infrastructure/ops/observability-only, non-software roles, legacy tech (COBOL, Perl, C/C++, mainframe), or generic cloud-only without the web stacks.',
    'Return JSON { "accepted": boolean, "reasoning": string } and set accepted=true only if the stack aligns with the above AND the experience requirement is five years or less. Phrases like "1-5 years", "up to 5 years", or "5+ years" are acceptable. Reject only roles that explicitly demand more than five years (e.g., "6+ years", "7-10 years", "at least six years"). The reasoning should be a concise one-liner explaining accept/reject.'
  ].join(' ');

  const userContent = `Title: ${payload.title}\nCompany: ${payload.company}\nLocation: ${payload.location}\nURL: ${payload.url}\nDescription:\n${payload.description}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const completion = await client.chat.completions.create({
        model: 'glm-4.5-Air',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ]
      });

      const message = completion.choices[0]?.message?.content ?? '{}';
      const parsed = JSON.parse(message);
      return {
        accepted: Boolean(parsed.accepted),
        reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : ''
      };
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleepBackoff(attempt);
      }
    }
  }

  throw lastError ?? new Error('Detail AI evaluation failed after retries.');
}

function sleepBackoff(attempt: number): Promise<void> {
  const delayMs = attempt * 5000;
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
