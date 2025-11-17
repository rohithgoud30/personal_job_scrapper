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
    const apiKey = requireEnv('openRouterApiKey');
    openAiClient = new OpenAI({
      apiKey,
      baseURL: env.openRouterBaseUrl
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
    'You receive an array of job listings that should fit a modern software engineer who can work across frontend (React, Angular, Next.js, TypeScript), backend (Java/Spring Boot, Python/FastAPI, Node.js/Express), and mobile (React Native) stacks, plus cloud microservices.',
    'Return JSON { "removeJobIds": [ ...job_id... ] } listing any postings that are clearly NOT related to those kinds of roles.',
    'Only use the provided title/company/location/url fields.',
    'If every listing is relevant, return an empty array.'
  ].join(' ');

  const userContent = JSON.stringify(entries, null, 2);
  const completion = await client.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ]
  });

  const message = completion.choices[0]?.message?.content ?? '{}';
  const parsed: AiIrrelevantResponse = JSON.parse(message);
  return new Set(parsed.removeJobIds ?? []);
}

export async function evaluateJobDetail(payload: DetailPayload): Promise<boolean> {
  const client = getClient();
  const systemPrompt = [
    'You read a full job description and decide if it matches a senior engineer who can work across frontend (React, Angular, Next.js, TypeScript), backend (Java/Spring Boot, Python/FastAPI, Node.js/Express), mobile (React Native), and cloud microservices.',
    'Return JSON { "accepted": boolean } where accepted is true only if these skills are clearly required.'
  ].join(' ');

  const userContent = `Title: ${payload.title}\nCompany: ${payload.company}\nLocation: ${payload.location}\nURL: ${payload.url}\nDescription:\n${payload.description}`;

  const completion = await client.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ]
  });

  const message = completion.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(message);
  return Boolean(parsed.accepted);
}
