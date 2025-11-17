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
    'You receive an array of job listings for a senior full-stack engineer (Java, Spring Boot, Python, FastAPI, Node.js, React, React Native, Next.js, TypeScript, cloud).',
    'Return JSON { "removeJobIds": [ ...job_id... ] } listing the postings that are irrelevant.',
    'Only use the provided title/company/location/url fields.',
    'If everything is relevant, return an empty array.'
  ].join(' ');

  const userContent = JSON.stringify(entries, null, 2);
  const completion = await client.chat.completions.create({
    model: 'openai/gpt-4o',
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
    'You evaluate full job descriptions for a senior full-stack engineer (Java, Spring Boot, Python, FastAPI, Node.js, React, React Native, Next.js, TypeScript, cloud).',
    'Return JSON { "accepted": boolean } where accepted is true only if the detailed description is a strong match.'
  ].join(' ');

  const userContent = `Title: ${payload.title}\nCompany: ${payload.company}\nLocation: ${payload.location}\nURL: ${payload.url}\nDescription:\n${payload.description}`;

  const completion = await client.chat.completions.create({
    model: 'openai/gpt-4o',
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
