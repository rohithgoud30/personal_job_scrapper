# CorpToCorp Scraper Architecture

This document explains the workflow for the `corptocorp.org` scraper, designed to aggregate C2C job listings. It follows the same architectural principles as the other site scrapers but is tailored to the specific structure and behavior of the CorpToCorp website.

## 1. Configuration & Environment

- **Config**: Defined in `config.json` under the `corptocorp` key.
  - **Search URL**: `https://corptocorp.org/c2c-jobs/`
  - **Selectors**: Custom selectors for the DataTables-based job list (`table#ipt-posts-table`), search input, and pagination.
  - **Delays**: Configured with `keywordDelaySeconds` (default 1s) for fast batch processing.
- **Environment** (`.env`):
  - `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` — DeepInfra primary provider (NVIDIA Nemotron model).
  - `GEMINI_API_KEY` / `GEMINI_MODEL` — Gemini fallback provider.
  - `AI_DEFAULT_PROVIDER` — Provider routing mode. Set to `"both"` for the dual-provider system (DeepInfra primary, Gemini fallback). Other values: `"deepinfra"` or `"gemini"` for single-provider mode.
  - `KEYWORD_BATCH_SIZE` — Number of keywords scraped concurrently per batch.
  - `TITLE_BATCH_SIZE` — Number of titles sent per AI title-filter request.
  - `AI_RETRY_DELAY_MS` — Back-off between retry attempts.
  - `SCRAPER_PORT` — Express server port (default `3333`).

## 2. Hybrid Architecture

The system runs as a three-layer stack:

```
┌─────────────────────────────────────────────────────┐
│  n8n  (Docker, port 5678)                           │
│  ┌───────────┐   ┌──────────┐   ┌───────────────┐  │
│  │ Cron node │──▶│ HTTP Req │──▶│ Telegram node │  │
│  │ (schedule)│   │POST /scrape│  │ (send message)│  │
│  └───────────┘   └──────────┘   └───────────────┘  │
│        polls GET /scrape/:id/status                 │
│        fetches GET /scrape/:id/results              │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP
┌──────────────────────▼──────────────────────────────┐
│  Express API  (host macOS, port 3333)               │
│  POST /scrape  → starts scrape session              │
│  GET  /scrape/:id/status  → poll state              │
│  GET  /scrape/:id/results → fetch accepted jobs     │
│  GET  /scrape/:id/stream  → SSE live stream         │
│  GET  /results/:site/:date → historical CSV lookup  │
│  GET  /status → health & available sites            │
└──────────────────────┬──────────────────────────────┘
                       │
              Playwright browser
              (headful Chromium)
```

- **Express HTTP API** (`pnpm start`, `src/server.ts`) — Runs on the host macOS machine on port 3333. Exposes REST endpoints to trigger scrapes, poll status, fetch results, and stream live updates via SSE.
- **n8n** (Docker, port 5678) — Handles all scheduling (replaces `node-cron`). Workflows trigger scrapes by sending `POST /scrape` to the Express API, poll `GET /scrape/:id/status` until completion, fetch results from `GET /scrape/:id/results`, and deliver formatted messages to Telegram.
- **Telegram bot** — Final delivery layer. n8n formats accepted job listings and sends them via the Telegram Bot API.

### Live SSE Streaming

The `onJobAccepted` callback is wired into every site runner (including `runCorpToCorpSite`). When a job passes detail evaluation:

1. The callback pushes the `JobRow` into the in-memory session.
2. All connected SSE listeners on `GET /scrape/:id/stream` receive the job in real time.

This allows n8n (or any client) to stream results as they arrive rather than waiting for the full run to complete.

## 3. Execution Modes

### CLI Mode

```bash
pnpm cli -- --site=corptocorp
```

Runs the scraper directly from the terminal via `src/cli.ts`. Supports flags:

| Flag | Description |
|---|---|
| `--site=corptocorp` | Run only the corptocorp scraper |
| `--session=<ID>` | Resume AI evaluation on a previous session (skip scraping) |
| `--skip-batch-wait` / `--fast` | Skip polite delays between keyword batches |
| `--keywords=react,angular` | Override configured keywords |

### Server Mode

```bash
pnpm start
```

Starts the Express API on port 3333 (`src/server.ts`). Scrapes are triggered via HTTP:

```bash
curl -X POST http://localhost:3333/scrape \
  -H "Content-Type: application/json" \
  -d '{"sites": "corptocorp"}'
```

The response includes a `sessionId` which can be used to poll status, fetch results, or open an SSE stream.

## 4. Scraping Workflow

### A. Navigation & Popup Handling

1. **Navigate**: Opens the main jobs page with a 60-second timeout. On timeout, retries up to 3 times with exponential back-off (5s, 10s, 15s).
2. **Popup Dismissal** (multi-layer):
   - **`#ipt-popup-modal`**: Attempts to click the close button, then force-hides the modal and removes the backdrop via `page.evaluate()` to prevent click interception.
   - **"NOT YET" Notification**: Clicks the notification subscription popup away.
   - **"Important Notice"**: Clicks the "Okay" disclaimer popup.
   - Dismissal is re-invoked before each sort-header click to handle popups that reappear.

### B. Search & Sorting

1. **Keyword Search**: Enters keywords into the DataTables search box (`input[type="search"]`). Waits 2 seconds for the table to update via DataTables' live-filter behavior.
2. **Automatic Sorting**:
   - Clicks the 3rd column header ("Posted Date") until the class indicates descending sort (`sorting_desc`).
   - If clicking produces ascending (`sorting_asc`), clicks again to flip to descending.
   - Each click attempt retries up to 3 times, re-dismissing popups before each try.

### C. Pagination & Extraction

1. **Loop**: Iterates through pages using the "Next" button (`#ipt-posts-table_next`).
2. **Stop Conditions**:
   - Stops if no jobs on the current page are dated "today" (when `postedTodayOnly` is true in config).
   - Stops if `maxPages` limit is reached.
   - Stops if the "Next" button is disabled or not visible.
3. **Data Extraction**:
   - **Title/Link**: Extracted from the first column (`td:nth-child(1) a`).
   - **Date**: Uses the `data-order` attribute on the 3rd column for precise timestamp (`YYYY-MM-DD HH:mm:ss`), falling back to visible text (e.g., "November 18, 2025").
   - **Company**: Hardcoded to `"CorpToCorp"` (aggregator site).
   - **Location**: Left empty (typically embedded in the title text).
   - **job_id**: Returns `null` (CorpToCorp URLs lack explicit IDs; the URL itself serves as the dedup key).

### D. Keyword Batching

Keywords are processed in batches controlled by `KEYWORD_BATCH_SIZE`. Each keyword opens a new browser page within the shared persistent context, enabling concurrent scraping. A configurable `keywordDelaySeconds` pause separates batches (skippable via `--fast` flag).

## 5. AI Evaluation & Filtering

The scraper uses a two-stage AI process powered by a dual-provider system: **DeepInfra (NVIDIA Nemotron)** as the primary provider with **Gemini** as the automatic fallback.

### Provider Routing

- When `AI_DEFAULT_PROVIDER="both"` (default), the first attempt goes to DeepInfra. On failure (rate limit, timeout, HTML response), subsequent retries fall back to Gemini.
- DeepInfra calls append a JSON-only instruction suffix to the system prompt (no `response_format` parameter, as the NVIDIA model does not support it). A `extractJson()` helper strips markdown fences or leading prose.
- Gemini calls use `responseMimeType: "application/json"` for native JSON output.
- HTML-response detection (`assertNotHtml`) catches rate-limit pages that return `<!DOCTYPE` or `<html>` instead of JSON.

### Stage 1: Title Filtering

- **Purpose**: Batch-reject roles clearly irrelevant to modern web/full-stack engineering (e.g., Data Engineering, BI, Legacy Tech, .NET, C#).
- **Input**: Batches of job titles/metadata (batch size controlled by `TITLE_BATCH_SIZE`), processed with concurrency of 3.
- **Prompt**: Loaded from `config.json` at `ai.prompts.titleFilter`.
- **Output**: A `{ remove: [{ job_id, reason }] }` JSON response. Rejected jobs are added to the seen store and logged via `rejectedLogger`.

### Stage 2: Detail Evaluation

- **Input**: Full job description extracted from the detail page (selectors tried in order: `.entry-content`, `.job-content`, `article`, `main`, `body`).
- **Prompt**: Loaded from `config.json` at `ai.prompts.detailEvaluation` (site-level override supported via `siteConfig.ai.prompts.detailEvaluation`).
- **Criteria** (encoded in the prompt):
  1. **Tech Stack**: Focus on Modern Web (React, Angular, Node.js, Python/FastAPI, Java/Spring Boot).
  2. **Experience**: Accepts 5 to <6 years (e.g., "5 years", "1-5 years"). Rejects 6+ years.
  3. **Visa Requirements (STRICT)**:
     - **MUST ACCEPT**: Roles allowing OPT, STEM OPT, or having no visa restrictions.
     - **MUST REJECT**: Roles restricted to H1B, H4, GC, or US Citizen ONLY (e.g., "USC Only", "No OPT").
     - **Logic**: If a role lists multiple visas including OPT (e.g., "USC, GC, OPT"), it is ACCEPTED.
- **Output**: `{ accepted: boolean, reasoning: string }`. Rejected jobs are logged and added to the seen store.

Each accepted job triggers the `onJobAccepted` callback (if provided), enabling live SSE streaming to connected clients.

## 6. Return Value

`runCorpToCorpSite` returns `Promise<JobRow[]>` — the list of jobs that passed both AI evaluation stages. This allows the orchestrator and the Express server to collect results programmatically (e.g., for the `/scrape/:id/results` endpoint or for n8n to fetch and forward to Telegram).

## 7. Output & Storage

- **Session Storage**: Raw scraped data is saved in `data/corptocorp.org/<DATE>/sessions/<SESSION_ID>/roles/new_roles.csv`.
- **Final CSV**: Approved jobs are appended to `data/corptocorp.org/<DATE>/new_jobs_<DATE>.csv`.
- **Deduplication**: `seen.json` stores both accepted AND rejected job IDs (keyed by `computeJobKey`). Previously rejected jobs are skipped in future sessions, saving AI API costs.
- **Rejected Log**: All rejected jobs (both title-level and detail-level) are recorded via `rejectedLogger` with type, reason, and timestamp.

## 8. Auto-Cleanup

Data folders older than **3 days** are automatically deleted at the start of each run. The cleanup is silent (no interactive prompt) and runs unattended, making it safe for automated n8n-triggered runs. The retention period is set by the `RETENTION_DAYS` constant in `scrapeOrchestrator.ts`.

## 9. Resuming Sessions

You can re-run the AI evaluation on already-scraped data (e.g., to test new visa rules or updated prompts) without re-scraping:

```bash
pnpm cli -- --site=corptocorp --session=<SESSION_ID>
```

This skips browser scraping and immediately processes the staged roles in the specified session folder. The session's date folder is detected automatically, so results are appended to the correct daily CSV.
