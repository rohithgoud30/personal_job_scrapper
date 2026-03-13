# Dice Scraper Architecture

This document explains the workflow for the `dice` scraper, designed to aggregate tech job listings from Dice.com. It features optimized bulk data extraction, specific filtering for "Today" and "Contract" roles, and integrates with a hybrid architecture comprising an Express HTTP API, n8n automation, and Telegram notifications.

## 1. Configuration & Environment

- **Config**: Defined in `config.json` under the `dice` key.
  - **Search URL**: `https://www.dice.com/jobs`
  - **Selectors**:
    - **Search**: `input[placeholder='Job title, skill, company, keyword']`
    - **Filters**: "Today" (`input[type='radio'][value='ONE']`) and "Contract" (`input[type='checkbox'][value='CONTRACT']`).
    - **Job Card**: `div[data-cy='search-result-card'], div:has(a[href*='/job-detail/'])`
    - **Title**: `a[href*='/job-detail/'][aria-label]` (specific selector to avoid "Easy Apply" buttons).
    - **Description**: `#jobDescription`
  - **Delays**: Includes specific waits (`waitForTimeout`) to handle the filter drawer animation and SPA transitions.

- **Environment Variables** (`.env`):

  | Variable | Purpose |
  |---|---|
  | `AI_API_KEY` | DeepInfra API key (OpenAI-compatible) |
  | `AI_BASE_URL` | DeepInfra endpoint (`https://api.deepinfra.com/v1/openai`) |
  | `AI_MODEL` | DeepInfra model (`nvidia/NVIDIA-Nemotron-3-Super-120B-A12B`) |
  | `GEMINI_API_KEY` | Google Gemini API key (fallback provider) |
  | `GEMINI_MODEL` | Gemini model (`gemini-2.5-flash`) |
  | `AI_DEFAULT_PROVIDER` | Provider mode: `"deepinfra"`, `"gemini"`, or `"both"` (dual-provider with retry). Default: `"both"` |
  | `TITLE_BATCH_SIZE` | Number of titles per AI batch (default 50) |
  | `KEYWORD_BATCH_SIZE` | Number of keywords scraped concurrently (default 5) |
  | `AI_RETRY_DELAY_MS` | Delay between AI retry attempts in milliseconds |
  | `SCRAPER_PORT` | Express API port (default 3333) |
  | `TELEGRAM_BOT_TOKEN` | Telegram bot token for notifications |
  | `TELEGRAM_CHAT_ID` | Telegram chat ID for notifications |

## 2. Dual-Provider AI System

The scraper uses a dual-provider AI architecture with automatic failover:

- **Primary**: DeepInfra (NVIDIA Nemotron) via OpenAI-compatible API. Prompts are appended with a JSON-only instruction suffix since `response_format: json_object` is unsupported by the NVIDIA model on DeepInfra.
- **Fallback**: Google Gemini via `@google/genai`, using native `responseMimeType: "application/json"` for structured output.
- **Provider routing**: When `AI_DEFAULT_PROVIDER=both`, the first attempt uses DeepInfra and subsequent retries fall back to Gemini. When set to `"deepinfra"` or `"gemini"`, all attempts use that single provider.
- **Retry logic**: `callWithRetry` manages the provider sequence, backing off with configurable delays (`AI_RETRY_DELAY_MS`). Parse/schema errors (malformed JSON) are not retried; only network, rate-limit, and HTML-response errors trigger fallback.

## 3. Execution Modes

### CLI Mode

The scraper runs directly from the command line:

```bash
pnpm cli -- --site=dice
```

This launches the scraper for the `dice` site, executes scraping and AI evaluation, and writes results to CSV.

### Server Mode (Express HTTP API)

```bash
pnpm start
```

Starts an Express API on port 3333 (`SCRAPER_PORT`). The server exposes REST endpoints for programmatic control:

| Endpoint | Method | Description |
|---|---|---|
| `/scrape` | POST | Start a scrape session (body: `{ sites, date }`) |
| `/scrape/:id/status` | GET | Poll session state (`running`, `completed`, `failed`) |
| `/scrape/:id/results` | GET | Fetch accepted jobs for a session |
| `/scrape/:id/stream` | GET | SSE live stream of accepted jobs |
| `/results/:site/:date` | GET | Historical results from CSV files on disk |
| `/status` | GET | Server health, running sessions, available sites |

## 4. Hybrid Architecture: Express + n8n + Telegram

The system runs as a hybrid architecture across the host macOS and Docker:

```
Host macOS (port 3333)          Docker (port 5678)
┌──────────────────────┐       ┌──────────────────────┐
│   Express HTTP API   │◄──────│        n8n           │
│   (Scraper Engine)   │       │  (Workflow Automation)│
└──────────────────────┘       └──────────┬───────────┘
                                          │
                                          ▼
                                   Telegram Bot
```

**Flow**:

1. **n8n** triggers a scrape by sending `POST /scrape` to the Express API with the desired site(s).
2. **n8n** polls `GET /scrape/:id/status` until the session state transitions to `completed` or `failed`.
3. **n8n** fetches `GET /scrape/:id/results` to retrieve all accepted jobs.
4. **n8n** formats and sends the results as Telegram messages via the Telegram bot.

### Live SSE Streaming via `onJobAccepted`

When the Express server starts a scrape session, it passes an `onJobAccepted` callback in `RunOptions`. Each time a job passes detail evaluation and is accepted, `runDiceSite` invokes `onJobAccepted(job)`, which:

- Pushes the job to the in-memory session store.
- Notifies all connected SSE listeners on `GET /scrape/:id/stream`.

This enables n8n (or any client) to receive accepted jobs in real time rather than waiting for the entire scrape to complete.

## 5. Scraping Workflow

### A. Navigation & Filtering

1. **Navigate**: Opens the Dice jobs page.
2. **Search**: Enters the keyword (e.g., "software engineer").
3. **Apply Filters**:
   - Opens the "All filters" drawer.
   - Selects **"Today"** (Posted Date) to ensure only fresh jobs are scraped.
   - Selects **"Contract"** (Employment Type).
   - Clicks "Apply filters" and verifies via URL parameter detection (`filters.postedDate=ONE`, `filters.employmentType`).
   - **Robustness**: Includes logic to scroll the drawer, fallback to clicking labels if checkboxes are intercepted, re-open the drawer if the Apply button is not visible, and retry clicking if URL does not update within 30 seconds.
   - **Zero-results detection**: If the "Today" or "Contract" label shows `(0)`, the keyword is skipped immediately.

### B. Optimized Bulk Extraction

1. **Bulk DOM Extraction**:
   - Instead of iterating through job cards one-by-one with Playwright locators (which is slow for 200+ items), the scraper uses `page.evaluate()` to extract **all** job data from the DOM in a single JavaScript execution.
   - Smart card detection filters nested DOM elements to find the correct "innermost candidate" cards, avoiding both the parent list container and leaf fragment elements.
   - This reduces scraping time for a full page of results from minutes to seconds.

2. **Pagination**:
   - Checks for a "Next" button (`li.pagination-next a`).
   - **Smart Stop**: If the last job on the page was not posted "today" (e.g., "1 day ago"), pagination stops immediately for that keyword.
   - Respects `maxPages` from site config.

### C. Data Extraction Details

- **Title**: Extracted from the `aria-label` of the title link, filtering out elements whose text contains "apply" to avoid "Easy Apply" buttons.
- **Company**: Extracted from the company profile link.
- **Location**: Extracted from `.search-result-location`, with a regex fallback (`City, ST` pattern) from card text.
- **Posted Date**: Extracted from `.search-result-posted-date`, with text-based fallbacks for "Today", "Just now", and `X time ago` patterns.
- **Job ID**: Parsed from the URL (UUID from `/job-detail/<slug>/<uuid>`).

## 6. AI Evaluation & Filtering

The scraper uses a two-stage AI process with the dual-provider system.

### Stage 1: Title Filtering

- **Provider sequence**: DeepInfra primary, Gemini fallback (when `AI_DEFAULT_PROVIDER=both`).
- **Logic**: Removes roles clearly irrelevant to modern web/full-stack engineering. Titles are processed in configurable batch sizes (`TITLE_BATCH_SIZE`, default 50) with up to 3 concurrent batches.
- **Input**: Batch of job titles/metadata as JSON.
- **Output**: `{ remove: [{ job_id, reason }] }` identifying irrelevant jobs.
- **Graceful degradation**: If all AI attempts fail for a batch, those jobs pass through without filtering rather than being dropped.

### Stage 2: Detail Evaluation

Before AI evaluation, each job detail page undergoes deterministic validation:

1. **Job Unavailable Detection**: Checks for Dice's `[data-cy="jobUnavailable"]`, expired job selectors, and text patterns like "Sorry this job is no longer available". Unavailable jobs are added to `seen.json` and skipped.

2. **C2C Validation**: Reads all employment type elements from the detail page:
   - **Rejects** if W2, Full Time, or Part Time is found in title, description, or type fields.
   - **Requires** "Corp-to-Corp", "Corp To Corp", or "C2C" in the employment type. Jobs without C2C are rejected.

3. **Posted Date Validation**: Parses "Posted X days ago" and "Updated X days/hours ago" text:
   - **Rejects** if posted more than 15 days ago.
   - **Rejects** if posted more than 1 day ago unless updated within the last day.
   - Accepts jobs posted within the last day unconditionally.

4. **AI Detail Evaluation**:
   - **Provider sequence**: DeepInfra primary, Gemini fallback (up to 3 attempts).
   - **Input**: Full job description extracted from `#jobDescription`.
   - **Criteria**:
     1. **Tech Stack**: Focus on Modern Web (React, Angular, Node.js, etc.).
     2. **Experience**: Accepts **5 to <6 years**.
     3. **Visa Requirements**: Checks for OPT/STEM OPT friendliness.
   - **Output**: `{ accepted: boolean, reasoning: string }`.

## 7. Return Value

`runDiceSite` returns `Promise<JobRow[]>` -- the list of accepted jobs for the session. This enables the Express server (and the orchestrator) to collect results programmatically rather than relying solely on CSV output.

## 8. Output

- **Session Storage**: Raw scraped data is saved in `data/dice.com/<DATE>/sessions/<SESSION_ID>/roles/new_roles.csv`.
- **Final CSV**: Approved jobs are appended to `data/dice.com/<DATE>/new_jobs_<DATE>.csv`.
- **Deduplication**: `seen.json` stores **both accepted AND rejected** job IDs. Previously rejected jobs are skipped in future runs, saving AI API costs.

## 9. Resuming Sessions

You can re-run the AI evaluation on already scraped data without re-scraping:

```bash
pnpm cli -- --site=dice --session=<SESSION_ID>
```

This locates the existing session folder, loads the staged roles CSV, and re-runs title filtering and detail evaluation against the stored data.

## 10. Auto-Cleanup

Data folders older than 3 days are automatically deleted at the start of each run. This runs silently with no interactive prompt, ensuring the system operates unattended (suitable for n8n-triggered and scheduled runs). Cleanup targets date-stamped folders matching the `MM_DD_YYYY` pattern under each site's data directory.
