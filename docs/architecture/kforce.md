# Kforce Scraper Architecture

This document explains the entire workflow in plain language so anyone can understand how the scraper operates without diving into the code. When you add new sites, follow the same building blocks: config-only selectors, headful Playwright automation, polite crawling, per-day CSV output, and the Express server API.

## 1. Configuration & Environment

- `config.json` remains the single source of truth for selectors, throttling, job-type filters, AI prompts (`ai.prompts.titleFilter` and `ai.prompts.detailEvaluation`), and the keyword list (`searchKeywords`). Each site entry includes its own persistent profile path so Playwright can keep cookies/login between runs.
- `.env` (copied from `.env.example`) supplies the dual-provider AI credentials and runtime settings:

| Variable | Purpose |
|---|---|
| `AI_API_KEY` | DeepInfra API key (OpenAI-compatible) |
| `AI_BASE_URL` | DeepInfra endpoint (`https://api.deepinfra.com/v1/openai`) |
| `AI_MODEL` | DeepInfra model, e.g. `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` |
| `GEMINI_API_KEY` | Google Gemini API key (fallback provider) |
| `GEMINI_MODEL` | Gemini model, e.g. `gemini-2.5-flash` |
| `AI_DEFAULT_PROVIDER` | `"deepinfra"`, `"gemini"`, or `"both"` (DeepInfra primary, Gemini fallback) |
| `TITLE_BATCH_SIZE` | Number of titles sent per AI title-filter batch |
| `KEYWORD_BATCH_SIZE` | Parallel keyword tabs per batch |
| `AI_RETRY_DELAY_MS` | Base delay between AI retry attempts (milliseconds) |
| `TEST_RUN_DATE` | Optional `YYYY-MM-DD` override for backfilling a specific day |
| `SCRAPER_PORT` | HTTP server port (default `3333`) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (used by n8n for delivery) |
| `TELEGRAM_CHAT_ID` | Telegram chat ID (used by n8n for delivery) |

## 2. System Architecture Overview

The scraper runs as two distinct modes, both backed by the same core logic:

```
                  ┌──────────────┐
                  │   n8n        │  (Docker, port 5678)
                  │  Workflows   │
                  └──────┬───────┘
                         │ HTTP calls + SSE streaming
                         ▼
              ┌─────────────────────┐
              │  Express HTTP API   │  (src/server.ts, port 3333)
              │  POST /scrape       │
              │  GET  /scrape/:id/* │
              │  GET  /results/...  │
              │  GET  /status       │
              └─────────┬──────────┘
                        │
          ┌─────────────┴─────────────┐
          ▼                           ▼
   ┌──────────────┐          ┌──────────────────┐
   │  Playwright   │          │  AI Evaluator     │
   │  (headful)    │          │  DeepInfra +      │
   │  Scraping     │          │  Gemini fallback  │
   └──────────────┘          └──────────────────┘
          │                           │
          └─────────────┬─────────────┘
                        ▼
              ┌──────────────────┐
              │  CSV / data/     │
              │  Per-host/date   │
              └──────────────────┘
```

- **Server mode** (`pnpm start`) runs the Express HTTP API on port 3333. This is the default and the mode used by n8n workflows.
- **CLI mode** (`pnpm cli -- --site kforce`) runs a one-shot scrape directly in the terminal with an elapsed-time display.
- **n8n** (running in Docker on port 5678) orchestrates scheduling, triggers scrapes via `POST /scrape`, streams accepted jobs in real time via the SSE endpoint, and delivers results to Telegram.
- Scheduling is handled entirely by n8n workflows. There is no `node-cron` in the codebase.

## 3. Execution Modes & Options

### Server mode (default)

```bash
pnpm start
```

Starts the Express API (`src/server.ts`) on port 3333 with the following endpoints:

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/scrape` | Start a scrape session. Body: `{ sites?: "kforce,dice", date?: "2025-12-01" }` |
| `GET` | `/scrape/:id/status` | Poll session state (`running`, `completed`, `failed`) |
| `GET` | `/scrape/:id/results` | Retrieve all accepted jobs for a session |
| `GET` | `/scrape/:id/stream` | SSE live stream of accepted jobs as they pass detail evaluation |
| `GET` | `/results/:site/:date` | Historical results from CSV files on disk |
| `GET` | `/status` | Server health, running sessions, available sites |

The `POST /scrape` handler creates a `RunOptions` object with an `onJobAccepted` callback. Each time a job passes detail evaluation, this callback pushes the job to the session's in-memory array and notifies all connected SSE listeners. This enables n8n to stream accepted jobs in real time and forward them to Telegram immediately, rather than waiting for the entire run to finish.

### CLI mode

```bash
pnpm cli -- --site kforce
```

Runs a one-shot scrape from `src/cli.ts`. Supports the following flags:

- `--site <key>` — filter to one or more comma-separated site keys
- `--skip-batch-wait` / `--fast` — removes the 25-30s pause between keyword batches
- `--resume-session <sessionId>` / `--session <sessionId>` — re-run AI filtering/detail evaluation using an existing session's `new_roles.csv`
- `--keywords <list>` — override config keywords with a comma-separated list

A live `[runner] Elapsed` timer stays pinned to the terminal while the run executes, and a completion summary prints the total duration and accepted job count.

### Session resume (AI-only rerun)

1. Locate the session folder created by the scrape you want to reuse (example: `data/kforce.com/11_18_2025/sessions/session-2025-11-18T18-15-03-000Z/roles/new_roles.csv`).
2. Run `pnpm cli -- --site kforce --session session-2025-11-18T18-15-03-000Z`.
3. The scraper skips keyword scraping, re-applies the title filter, and re-runs detail AI scoring into the same date folder.

## 4. Browser Session & Compliance

- Playwright uses `launchPersistentContext` against `.playwright/<key>`. Close any older windows using that profile before starting a new run; the browser enforces a singleton lock to prevent corruption.
- Cookie consent (OneTrust) is automatically accepted every time a new tab opens. Contract filters and "Newest Jobs First" sorting are re-applied on each tab as well.
- Robots guidelines are honored by skipping disallowed URLs, throttling pagination, and limiting page depth. The script still abandons pagination when page 1 contains no "posted today" listings.

## 5. Keyword Scraping & Parallelism

Keywords are processed in parallel batches (size drawn from `KEYWORD_BATCH_SIZE`), each batch using separate Playwright tabs so multiple keywords can run simultaneously (then the next batch, etc.).

For each keyword:
1. A new page opens, navigates to the search URL, and accepts cookie consent.
2. The job-type facet filter is applied (e.g., "Contract") and the sort order is set to "Newest Jobs First."
3. The keyword is typed into the search input and submitted.
4. Listing cards are scraped page by page. Pagination stops when a page has no "posted today" listings (in live mode) or when `maxPages` is reached.
5. Each extracted job is deduped against `seen.json` and the in-memory staged map before being added.

Between keyword batches (in live mode), a 30-second polite crawl delay is applied unless `--skip-batch-wait` / `--fast` is passed.

## 6. Staging, Sessions, and Dedupe

- Every run receives a `session-<timestamp>` folder under `data/<host>/<date>/sessions/<sessionId>`. Raw results (after deduping against `seen.json`) land in `roles/new_roles.csv` with columns `session_id, keyword, ... job details`.
- `seen.json` stores both accepted AND rejected job IDs per date. This means previously rejected jobs are skipped immediately in future runs, saving AI API costs on title filtering and detail evaluation.

## 7. Two-Stage AI Filtering (Dual-Provider)

The AI evaluator (`src/lib/aiEvaluator.ts`) supports a dual-provider system controlled by `AI_DEFAULT_PROVIDER`:

- **`"deepinfra"`** — all calls go to DeepInfra (NVIDIA Nemotron) via the OpenAI-compatible API.
- **`"gemini"`** — all calls go to the Google Gemini API with `responseMimeType: "application/json"`.
- **`"both"`** (recommended) — the first attempt uses DeepInfra as primary; if it fails, subsequent retries fall back to Gemini.

Both providers are initialized as lazy singletons. DeepInfra responses get a JSON-only suffix appended to the system prompt and go through an `extractJson` helper that strips markdown code fences. Gemini uses native JSON response mode.

A shared `callWithRetry` helper handles retries with exponential backoff (`AI_RETRY_DELAY_MS` base). Parse/schema errors (SyntaxError) are not retried. Rate-limit and HTML-instead-of-JSON errors trigger fallback to the next provider in sequence.

### Stage 1: Title array filtering

After all keywords finish, the scraper batches the staged roles (batch size from `TITLE_BATCH_SIZE`, up to 3 batches concurrently) and sends each batch as a JSON array of `{ title, company, location, url, job_id }` objects to the AI. The model returns the job IDs that should be removed (non-web-stack roles, Go/Golang, .NET/C#, etc.). Those rows are deleted from the session file so only promising roles remain. The title filter system prompt is loaded from `config.json` at `ai.prompts.titleFilter`.

### Stage 2: Full-page detail evaluation

Each remaining role is opened individually. If the description is short (under 500 characters), the scraper waits 10s (then 30s) and re-extracts. The full text is sent to the AI with the system prompt from `ai.prompts.detailEvaluation` (or the site-specific override at `sites[].ai.prompts.detailEvaluation`). The model returns `{ accepted: boolean, reasoning: string }`. Reasons are logged per rejection.

For detail evaluation, the provider sequence uses 3 attempts (first DeepInfra, then two Gemini retries in `"both"` mode).

## 8. Return Value & Callback

The function `runKforceSite` returns `Promise<JobRow[]>` — the array of jobs that passed both AI stages and were written to the day-level CSV. This return value is used by the orchestrator to aggregate results across sites.

The `onJobAccepted` callback in `RunOptions` is invoked immediately each time a job passes detail evaluation, before the full run completes. In server mode, this callback pushes the job to the session's in-memory array and notifies SSE listeners, enabling real-time streaming to n8n for immediate Telegram delivery.

## 9. Final Output

- Approved jobs are appended (newest first) to `data/<host>/<MM_DD_YYYY>/new_jobs_<MM_DD_YYYY>.csv` with columns `site,title,company,location,posted,url,job_id,scraped_at`. The day-level CSV is rewritten so new entries stay on top.
- Each run prints how many roles were accepted and where they were written.

## 10. Auto-Cleanup

On every run, the orchestrator (`src/lib/scrapeOrchestrator.ts`) silently deletes data folders older than 3 days. There is no interactive prompt — cleanup runs unattended before scraping begins. The retention period is controlled by the `RETENTION_DAYS` constant (currently 3). Only date-formatted folders (`MM_DD_YYYY`) under each site's data directory are considered.

## 11. Observability & Recovery

- Console logs cover keyword batches, parallel tab activity, AI provider selection, removals, and detail evaluations. When another site is added, reuse the same logging style so output stays consistent.
- In CLI mode, a live `[runner] Elapsed` timer stays pinned to the terminal while the run executes, and a completion summary prints the total duration once everything finishes.
- Headful tabs remain visible during scraping and evaluation, so if a DOM change or login prompt occurs you can intervene immediately.

## 12. Extending to New Sites

- Duplicate the Kforce block in `config.json`, adjust selectors/filters/keywords/AI prompts, and add a new `src/sites/<site>/index.ts` runner. The runner function should accept `(site: SiteConfig, output: OutputConfig, options: RunOptions)` and return `Promise<JobRow[]>`.
- Register the new site key in the `runSite` switch statement in `src/lib/scrapeOrchestrator.ts`.
- Each site writes into its own `data/<host>/...` tree and uses a dedicated persistent profile (`.playwright/<site>`), so there is no cross-talk between portals.
- Keyword lists live entirely in JSON, so you can tailor them per site without code changes.
- The Express server API automatically picks up new sites — `POST /scrape` accepts a comma-separated `sites` filter, and `GET /status` reports all available site keys. n8n workflows can target the new site immediately without server changes.
