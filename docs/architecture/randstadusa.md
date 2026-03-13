# Randstad USA Scraper Architecture

This mirrors the Kforce flow: headful Playwright, config-only selectors, posted-today filtering, AI title + detail checks, per-day CSV output, and a persistent browser profile. The notes below highlight Randstad-specific details so you can understand or adjust behavior without reading code.

## 1) Config & Env

- `config.json`: site block `randstadusa` plus `sharedSearchKeywords` (if the site's keyword list is empty, the shared list is used). Uses the same output settings as other sites.
- `.env`: dual-provider AI keys and settings:
  - `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` — DeepInfra primary provider (NVIDIA Nemotron model).
  - `GEMINI_API_KEY`, `GEMINI_MODEL` — Google Gemini fallback provider.
  - `AI_DEFAULT_PROVIDER="both"` — routes the first attempt through DeepInfra and retries through Gemini on failure.
  - `KEYWORD_BATCH_SIZE`, `TITLE_BATCH_SIZE`, `AI_RETRY_DELAY_MS` — tuning knobs.
  - `SCRAPER_PORT` (default 3333) — Express HTTP API port.
  - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — Telegram notification bot.
  - Optional `TEST_RUN_DATE=YYYY-MM-DD` for backfill (treated as "today" in Eastern time).

## 2) Hybrid Architecture

The system runs as a three-layer stack:

| Layer | Runtime | Port | Role |
|---|---|---|---|
| **Express HTTP API** | Host macOS (ts-node) | 3333 | Scraper engine, session management, SSE streaming |
| **n8n** | Docker | 5678 | Workflow orchestration, scheduling, webhook triggers |
| **Telegram bot** | Via n8n | — | Notifications, on-demand scrape triggers |

- **Server mode**: `pnpm start` launches the Express API on port 3333. Endpoints: `POST /scrape`, `GET /scrape/:id/status`, `GET /scrape/:id/results`, `GET /scrape/:id/stream` (SSE), `GET /results/:site/:date`, `GET /status`.
- **CLI mode**: `pnpm cli -- --site=randstadusa` runs a one-shot scrape from the terminal (headful, persistent profile `.playwright/randstadusa`).
- n8n (Docker) calls `POST /scrape` on the host API to trigger runs and consumes the SSE stream for real-time job events, forwarding accepted jobs to Telegram.

## 3) Launch & Navigation

- CLI command: `pnpm cli -- --site=randstadusa` (headful, persistent profile `.playwright/randstadusa`).
- Each keyword opens in its own tab (batch size from `KEYWORD_BATCH_SIZE`), waits for the `q-<slug>/` search page, accepts OneTrust cookies, applies the contract filter via the job-type popover, sets "date" sort, and respects `maxPages`/polite delays.
- URL slug construction: keywords are lowercased, non-alphanumeric runs are replaced with hyphens, and leading/trailing hyphens are stripped (e.g., `"Data Engineer"` becomes `/jobs/q-data-engineer/`).

## 4) Page Scrape

Three-tier hit extraction (in priority order):

1. **`window.__ROUTE_DATA__`**: the page's hydration object. `extractHits()` reads `__ROUTE_DATA__.searchResults.hits` via `page.waitForFunction`. Each hit carries `id`, `title`, `shortLocation`, `postedDate`/`createdDate`/`startDate`/`launchDate`, `jobType`/`employmentType`/`employmentTypes`, and `url`/`detailsUrl`.
2. **Script tag fallback**: if `__ROUTE_DATA__` is not populated, `extractHits()` scans all `<script>` elements for a JSON array keyed by `"hits"`, bracket-parses the first valid array, and returns it.
3. **DOM card fallback**: `extractDomRows()` queries `ul.cards__list li.cards__item` (with broad backup selectors like `main article:has(a[href*="/jobs/"])`, `section article`, etc.). Parsed fields per card: title (`h3.cards__title a.cards__link`), location (`.cards__meta-item` with location icon), posted (`.cards__date`), url (relative to absolute), job_id extracted from URL, `scraped_at` in ET. A final last-resort path scrapes raw `<a href*="/jobs/">` anchors directly.

- **Posted-today enforcement**: dates normalized to Eastern `MM/DD/YYYY`; relative strings ("today", "just now", "X hours ago") resolve to the run date. Pagination stops if the last item on the page is not today.
- **Job type filter**: keeps only rows matching `jobTypeFilter` (Contract/Temporary/Temp to Perm). Filters are applied both on `__ROUTE_DATA__` hits (via `jobType`/`employmentType`/`employmentTypes` fields) and at the config level.
- **Contract filter popover**: `applyContractFilter()` clicks the `data-rs-popover-trigger="jobType"` button, checks the "contract" checkbox inside the `data-rs-popover="jobType"` panel, and clicks "show jobs" to apply.
- **Date sort**: `ensureDateSort()` prefers a native `select#sortBy` element (sets value to "date"), falling back to toggle-button + dropdown-option click paths.

## 5) Dedupe & Session

- Session ID: `session-<timestamp>`, with `roles/new_roles.csv` in `data/randstadusa/<date>/sessions/<sessionId>/`.
- `seen.json` stores **both accepted AND rejected** job IDs per date. Previously rejected jobs are skipped immediately in future runs, saving AI API costs.
- Resume mode: pass `resumeSessionId` to bypass scraping and re-run AI filtering against an existing session's staged CSV.

## 6) Two-Stage AI (DeepInfra + Gemini Dual-Provider)

AI evaluation uses a shared `callWithRetry` helper that routes requests through a provider sequence determined by `AI_DEFAULT_PROVIDER`:

- **`"both"` (default)**: first attempt goes to DeepInfra (NVIDIA Nemotron via OpenAI-compatible API), retries fall back to Gemini (Google `@google/genai` SDK with `responseMimeType: "application/json"`).
- **`"deepinfra"`**: all attempts use DeepInfra only.
- **`"gemini"`**: all attempts use Gemini only.

### Title filter
Sends batched staged arrays (title/company/location/url/job_id) through the provider sequence (2 attempts, concurrency 3). Prompts are loaded from `config.json` at `ai.prompts.titleFilter`. Removals are logged; rejected jobs are added to `seen.json` so they never reach detail evaluation.

### Detail evaluator
Opens each remaining job page in a new tab, re-scrapes description with retries on short content (waits 10s then 30s if under 500 chars), then sends the full JD through the provider sequence (3 attempts). Returns `{ accepted, reasoning }`. Non-matches log a reason; matches are appended to the day CSV.

## 7) `onJobAccepted` Callback & SSE Streaming

`runRandstadSite` accepts `RunOptions.onJobAccepted`, a callback invoked each time a job passes detail evaluation. In server mode, the Express API registers this callback to:

1. Push the accepted `JobRow` into the in-memory session.
2. Broadcast the job as an SSE `data:` event to all clients connected to `GET /scrape/:id/stream`.

This enables n8n (or any SSE consumer) to receive jobs in real time rather than polling for completion.

## 8) Return Type

`runRandstadSite` returns `Promise<JobRow[]>` — the list of jobs that passed both AI stages. The orchestrator (`scrapeOrchestrator.ts`) aggregates results across all sites and returns an `OrchestratorResult` with total `jobs`, `durationMs`, and `sitesRun`.

## 9) Output

- Accepted roles append to `data/randstadusa/{MM_DD_YYYY}/{H}.csv` with columns `site,title,company,location,posted,url,job_id,scraped_at`.
- Session CSVs in `sessions/<sessionId>/roles` capture staged sets before AI and after title filter.

## 10) Auto-Cleanup

The orchestrator runs `cleanupOldData()` at the start of every run. It silently deletes date folders older than **3 days** (`RETENTION_DAYS = 3`) with no interactive prompt, so the system runs fully unattended.

## 11) Observability & Safety

- Console logs: keyword starts, sort/post filters found, pagination stops, AI provider used per attempt, rejections/acceptances with reasons, and elapsed timer. Headful tabs stay visible for manual inspection.
- Rejected jobs are tracked via `rejectedLogger` and persisted at the end of each orchestrator run.
- Robots compliance: throttle between pages/keywords (polite 25s batch delays unless `skipBatchPause` is set), limit page depth via `maxPages`, and disallow-pattern URL skipping.

## 12) Extending or Tweaking

- Change keywords in `sharedSearchKeywords` or give Randstad its own list in `search.criteria.searchKeywords`.
- Adjust selectors in `config.json` if the UI shifts (card/title/location/posted/sort/job types).
- Update `maxPages`, delays, or `jobTypeFilter` as needed — no code changes required for common tweaks.
- Switch AI providers by changing `AI_DEFAULT_PROVIDER` in `.env` (`"deepinfra"`, `"gemini"`, or `"both"`).
- AI prompts are stored in `config.json` under `ai.prompts.titleFilter` and `ai.prompts.detailEvaluation` — editable without code changes.
