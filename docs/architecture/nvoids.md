# Nvoids Scraper

## Overview

The `nvoids` scraper targets **Nvoids**, a job aggregator site. It is designed to find recent job postings, specifically filtering for those posted "Today". It runs within a hybrid architecture that combines an Express HTTP API, an n8n workflow engine, and a Telegram bot for end-to-end automation.

## Hybrid Architecture

The system is composed of three cooperating services:

| Component | Runtime | Port | Role |
|-----------|---------|------|------|
| **Express HTTP API** | Host macOS (Node/ts-node) | 3333 | Scraping engine, AI evaluation, SSE streaming |
| **n8n** | Docker | 5678 | Workflow orchestration, scheduling, webhook triggers |
| **Telegram bot** | Via n8n | — | Notifications, on-demand trigger |

**Flow:** n8n (or a direct HTTP call) sends `POST /scrape` with `{ "sites": "nvoids" }` to the Express API. The API launches Playwright, scrapes, runs AI filtering, and streams accepted jobs back via SSE (`GET /scrape/:id/stream`). n8n or the Telegram bot can poll status or consume the SSE stream to push results to the user.

## AI Provider System

AI filtering uses a **dual-provider** setup powered by the DeepInfra (NVIDIA Nemotron) primary provider with Gemini as the fallback:

- **Primary:** DeepInfra hosting the NVIDIA Nemotron model family, accessed via the OpenAI-compatible API (`AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`).
- **Fallback:** Google Gemini API (`GEMINI_API_KEY`, `GEMINI_MODEL`).
- **Provider mode** is controlled by the `AI_DEFAULT_PROVIDER` env var:
  - `deepinfra` (default) — all calls go to DeepInfra.
  - `gemini` — all calls go to Gemini.
  - `both` — first attempt uses DeepInfra, retries fall back to Gemini.

If a provider returns an error (rate limit, HTML response, network failure), the retry logic automatically switches to the fallback provider when running in `both` mode.

## Key Features

- **"Today" Filtering (IST/EST dual timezone)**:
  - Checks if the job was posted "Today" in either **IST (India Standard Time)** or **EST (Eastern Standard Time)**.
  - Handles date formats like `HH:MM AM/PM DD-Mon-YY` (e.g., `03:18 AM 02-Dec-25`).
  - Supports legacy `MM/DD/YYYY` format.
  - Uses `Intl.DateTimeFormat` with `formatToParts` to compare date components in each timezone independently.
- **Two-stage AI Filtering**:
  - **Stage 1 (Title)**: Batch-filters job titles using AI to remove irrelevant postings (non-tech, senior management, etc.). Runs with concurrency of 3, configurable batch size via `TITLE_BATCH_SIZE`.
  - **Stage 2 (Detail)**: Opens each surviving job page, extracts the full description, and sends it to AI to evaluate tech stack, experience level, and visa requirements. Each accepted job fires the `onJobAccepted` callback.
- **Personal Email Filter (with PA exemption)**:
  - Before sending a job to Stage 2 AI (saving API costs), checks whether the description contains only personal/free email addresses (Gmail, Yahoo, Outlook, etc.) with no corporate email.
  - Jobs in **Pennsylvania (PA)** are exempt from this filter — detected via location text, description body, or common PA city names.
- **Ad Blocking via `page.route`**:
  - Intercepts all network requests with `page.route("**/*", ...)` and aborts requests to known ad domains (googleads, doubleclick, googlesyndication, criteo, etc.).
  - Also filters out ad-redirect URLs in the extracted job rows.
- **Table-based Extraction**:
  - Job listings are scraped from `<table>` elements (`table tbody tr`) with columns: title/link (col 1), location (col 2), posted date (col 3).
  - Job IDs are extracted from URL query parameter `?id=`.
- **Pagination**: Automatically navigates through search results pages until no more "Today" jobs are found or `maxPages` is reached.
- **Session & Resume Support**:
  - Each scrape run creates a session with a unique ID (`session-<ISO timestamp>`).
  - Staged roles are written to a session CSV before AI filtering begins.
  - A previous session can be resumed with `--resume-session=<id>` to re-run AI filtering without re-scraping.
- **`onJobAccepted` Callback for Live SSE Streaming**:
  - The `RunOptions.onJobAccepted` callback is invoked every time a job passes detail evaluation.
  - In server mode, this callback pushes each accepted job to all connected SSE clients in real time via `GET /scrape/:id/stream`.
- **Deduplication**:
  - `seen.json` stores both accepted AND rejected job IDs (keyed by `computeJobKey`).
  - Previously seen jobs are skipped entirely in future runs, saving both scraping time and AI API costs.

## Return Type

`runNvoidsSite` returns `Promise<JobRow[]>` — an array of all accepted job rows for the run. The orchestrator aggregates these across all sites into the `OrchestratorResult`.

## Auto-Cleanup

The orchestrator performs **automatic cleanup** with a **3-day retention** policy. Before each run, it silently deletes data folders (format `MM_DD_YYYY`) older than 3 days. There is no interactive prompt — cleanup runs unattended, suitable for scheduled/automated execution.

## Configuration

Ensure your `config.json` includes the `nvoids` configuration block:

```json
"nvoids": {
  "host": "nvoids.com",
  "search": {
    "url": "https://jobs.nvoids.com/jobs_search.jsp",
    "postedTodayOnly": true,
    "selectors": {
      "keywords": "input[name='keywords']",
      "submit": "input[type='submit']",
      "next": "a:has-text('Next')"
    },
    "criteria": {
      "searchKeywords": [
        "Java Developer",
        "React Developer",
        "Python Developer"
      ]
    }
  },
  "run": {
    "maxPages": 10,
    "keywordDelaySeconds": 2
  },
  "disallowPatterns": []
}
```

## Usage

### CLI Mode

Run the scraper for Nvoids from the command line:

```bash
pnpm cli -- --site=nvoids
```

Optional flags:

```bash
pnpm cli -- --site=nvoids --skip-batch-wait      # Skip delay between keyword batches
pnpm cli -- --site=nvoids --resume-session=<id>   # Resume AI filtering for an existing session
pnpm cli -- --site=nvoids --keywords=React,Java   # Override configured keywords
```

### Server Mode

Start the Express API (port 3333 by default):

```bash
pnpm start
```

Then trigger a scrape via HTTP:

```bash
# Start scrape
curl -X POST http://localhost:3333/scrape \
  -H "Content-Type: application/json" \
  -d '{"sites": "nvoids"}'

# Stream results via SSE
curl http://localhost:3333/scrape/<sessionId>/stream
```

## Output

Results are saved in:
`data/nvoids/<date>/new_jobs_<date>.csv`

Rejected jobs are logged in:
`data/nvoids/<date>/rejected_jobs_<date>.xlsx`

Session-level staged roles (pre-AI filtering) are stored in:
`data/nvoids/<date>/sessions/<session-id>/roles.csv`

> [!NOTE]
> **Cost Optimization**: `seen.json` stores both accepted AND rejected job IDs. Previously rejected jobs are skipped in future runs, saving AI API costs. The personal email pre-filter further reduces unnecessary AI calls by rejecting jobs with only free-provider email addresses before they reach Stage 2.
