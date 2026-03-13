# AI Provider Setup

How to configure the dual-provider AI system (DeepInfra + Gemini).

## Architecture

```
AI_DEFAULT_PROVIDER=both

Title Filter (2 attempts):
  1. DeepInfra (NVIDIA Nemotron) ──► success
  2. Gemini (gemini-2.5-flash)   ──► fallback

Detail Evaluation (3 attempts):
  1. DeepInfra ──► success
  2. Gemini    ──► fallback
  3. Gemini    ──► last chance
```

## Provider 1: DeepInfra

DeepInfra hosts NVIDIA models via an OpenAI-compatible API.

### Get API Key

1. Go to [deepinfra.com](https://deepinfra.com)
2. Sign up / log in
3. Go to **Dashboard** → **API Keys**
4. Create a new key, copy it

### Configure

```env
AI_API_KEY=<your-deepinfra-key>
AI_BASE_URL=https://api.deepinfra.com/v1/openai
AI_MODEL=nvidia/NVIDIA-Nemotron-3-Super-120B-A12B
```

### How It Works

- Uses the **OpenAI SDK** (`new OpenAI({ apiKey, baseURL })`)
- Sends JSON-formatted prompts to chat completions endpoint
- Appends `\n\nRespond ONLY with valid JSON.` to prompts (since this model doesn't support `response_format`)

## Provider 2: Gemini

Google's Gemini model as fallback.

### Get API Key

1. Go to [aistudio.google.com](https://aistudio.google.com)
2. Click **Get API Key** → **Create API key**
3. Copy the key

### Configure

```env
GEMINI_API_KEY=<your-gemini-key>
GEMINI_MODEL=gemini-2.5-flash
```

### How It Works

- Uses the **@google/genai SDK** (`new GoogleGenAI(apiKey)`)
- Sets `responseMimeType: "application/json"` for structured output
- Native JSON mode — no prompt suffix needed

## Provider Mode

```env
# Use DeepInfra only
AI_DEFAULT_PROVIDER=deepinfra

# Use Gemini only
AI_DEFAULT_PROVIDER=gemini

# DeepInfra primary, Gemini fallback (recommended)
AI_DEFAULT_PROVIDER=both
```

## Batch Configuration

```env
# Number of jobs per AI title filter batch
TITLE_BATCH_SIZE=50

# Number of keywords searched in parallel
KEYWORD_BATCH_SIZE=5

# Delay between retry attempts (ms)
AI_RETRY_DELAY_MS=5000
```

## Retry Behavior

| Trigger | Action |
|---------|--------|
| Rate limit (429) | Switch to next provider |
| HTML response (blocking) | Switch to next provider |
| Network error | Switch to next provider |
| JSON parse error | Fail immediately (bad model output) |
| All retries exhausted | Skip this job/batch, continue run |

Delay between retries: `attempt * AI_RETRY_DELAY_MS` (linear backoff).

## Cost Estimates

| Operation | Provider | Approximate Cost |
|-----------|----------|-----------------|
| Title filter (50 jobs) | DeepInfra | ~$0.001–0.005 |
| Detail evaluation (1 job) | DeepInfra | ~$0.001–0.003 |
| Title filter (50 jobs) | Gemini | Free tier / ~$0.001 |
| Detail evaluation (1 job) | Gemini | Free tier / ~$0.001 |
| Full 6-site run (~200 jobs) | Both | ~$0.05–0.15 |

DeepInfra charges per token. Gemini has a generous free tier.

## Customizing AI Prompts

Prompts are in `config.json` → `ai.prompts`:

- `titleFilter` — Array of strings joined as system prompt for batch title filtering
- `detailEvaluation` — Array of strings joined as system prompt for per-job detail evaluation

See `docs/CONTRIBUTING.md` → "AI Prompt Changes" for editing guidelines.

## Verification

```bash
# Test with a single site (fast)
pnpm cli -- --site=corptocorp --fast

# Check rejected jobs for AI reasoning quality
# Open data/rejected_jobs.xlsx after a run

# Re-run AI on existing session (no re-scraping)
pnpm cli -- --site=corptocorp --session=<session-id>
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Environment variable aiApiKey is required` | Set `AI_API_KEY` in `.env` |
| `401 Unauthorized` from DeepInfra | Check API key; verify account has credits |
| `HTML response detected` | Provider is rate-limiting; fallback will kick in |
| All jobs rejected | Review prompts in `config.json`; they may be too strict |
| JSON parse errors | Model returned prose instead of JSON; retries will use next provider |
