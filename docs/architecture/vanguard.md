# Vanguard Jobs Architecture

## Overview

The Vanguard Jobs scraper (`src/sites/vanguard/index.ts`) automates job data extraction from `vanguardjobs.com`. It follows the standardized architecture pattern used across all scrapers in this project and integrates into a hybrid system comprising an Express HTTP API, n8n workflow automation, and a Telegram bot.

## Hybrid Architecture

The scraper operates within a three-component system:

| Component        | Runtime           | Port  | Role                                              |
| ---------------- | ----------------- | ----- | ------------------------------------------------- |
| Express HTTP API | Host macOS        | 3333  | Scraper orchestration, SSE streaming, REST results |
| n8n              | Docker container  | 5678  | Workflow automation, scheduling, webhooks          |
| Telegram bot     | Via n8n / Express | —     | Notifications, on-demand triggers                  |

- **Server mode** (`pnpm start`): Starts the Express API on port 3333. n8n (or any HTTP client) triggers scrapes via `POST /scrape` and receives live results through SSE streaming.
- **CLI mode** (`pnpm cli -- --site=vanguard`): Runs the scraper directly from the terminal without the HTTP server.

## AI Provider System

AI-powered filtering uses a **dual-provider** architecture configured via environment variables:

| Provider   | Model                                    | Role              |
| ---------- | ---------------------------------------- | ----------------- |
| DeepInfra  | NVIDIA Nemotron (`nvidia/NVIDIA-Nemotron-3-Super-120B-A12B`) | Primary provider  |
| Gemini     | `gemini-2.5-flash`                       | Fallback provider |

The `AI_DEFAULT_PROVIDER` env var controls routing:
- `"deepinfra"` — DeepInfra only.
- `"gemini"` — Gemini only.
- `"both"` (default) — DeepInfra primary with automatic Gemini fallback on failure.

Both providers are accessed through lazy-initialized singleton clients (`OpenAI`-compatible SDK for DeepInfra, `@google/genai` for Gemini).

## Key Features

- **Keyword-based search**: Searches for jobs using configurable keywords (shared or per-site override)
- **Pagination support**: Processes multiple pages of results with page-counter reset on each new page
- **Sort by date**: Automatically sorts results by "Newest" via `<select>` option
- **AI-powered filtering**: Two-stage AI evaluation (title filter + detail evaluation) using DeepInfra/Gemini
- **Session management**: Supports resuming AI evaluation from saved sessions
- **Deduplication**: Stores **both accepted AND rejected** job IDs in `seen.json`. Previously rejected jobs are skipped in future runs, saving AI API costs
- **Return value**: `runVanguardSite` returns `Promise<JobRow[]>` — the list of accepted jobs — enabling the HTTP server and CLI to consume results programmatically
- **`onJobAccepted` callback**: Each time a job passes detail evaluation, the optional callback fires, enabling live SSE streaming to connected clients in server mode
- **Auto-cleanup**: 3-day retention policy (`RETENTION_DAYS = 3`). Old date folders are silently deleted at the start of each run with no interactive prompt, suitable for unattended/headless operation

## Configuration (`config.json`)

### Site Configuration

```json
{
  "key": "vanguard",
  "host": "vanguardjobs.com",
  "userDataDir": ".playwright/vanguard",
  "search": {
    "url": "https://www.vanguardjobs.com/job-search-results/",
    "criteria": {
      "searchKeywords": []
    },
    "postedTodayOnly": false
  }
}
```

### CSS Selectors

| Element        | Selector                                          |
| -------------- | ------------------------------------------------- |
| Keywords Input | `input#cws_quickjobsearch_keywords`               |
| Submit Button  | `input.quicksearch-submit`                        |
| Job Card       | `div.job`                                         |
| Title          | `a[id^='job-result']`                             |
| Location       | `div.job-innerwrap > div.joblist-location`        |
| Posted Date    | `div.job-innerwrap > div.joblist-posdate`         |
| Next Page      | `a[aria-label='Go to the next page of results.']` |
| Sort Dropdown  | `select#sort-by`                                  |
| Description    | `div.fusion-tabs div.fusion-tab-content`          |

### Important Notes

- **`postedTodayOnly`: false** — Vanguard posts often show future dates, so date filtering is disabled
- **Keywords**: Inherits from `sharedSearchKeywords` in global config when the site array is empty; can be overridden at runtime via `--keywords`
- **Sort**: Automatically selects the "Newest" option (`selectOption({ label: sortOptionText })`) to get most recent jobs first
- **Description selector**: The primary selector targets Avada/Fusion Builder tab content (`div.fusion-tabs div.fusion-tab-content`), with several fallback selectors tried in order

## Workflow

### 1. Auto-Cleanup

Before any scraping begins, the orchestrator silently deletes date folders older than 3 days. No interactive prompt is shown.

```typescript
// scrapeOrchestrator.ts
const RETENTION_DAYS = 3;
// Folders matching MM_DD_YYYY older than 3 days are removed via fs.promises.rm()
```

### 2. Session Initialization

```typescript
const sessionId = createSessionId();
const sessionPaths = buildSessionPaths(outputPaths, sessionId);
```

### 3. Keyword Processing

Keywords are processed in batches (default: 5 concurrent, configurable via `KEYWORD_BATCH_SIZE`):

```typescript
await scrapeKeywordsInBatches(
  context,
  site,
  keywords,
  seen,
  staged,
  sessionId,
  runDate,
  isBackfill,
  skipBatchDelay
);
```

Keyword override is supported at runtime:

```bash
pnpm cli -- --site vanguard --keywords "java,python,react"
```

### 4. Search Flow

For each keyword:

1. Navigate to search page
2. Accept cookie consent (if present)
3. Fill keyword input
4. Submit search
5. Wait for results to load
6. Select "Newest" sort option via `<select>` dropdown
7. Collect job listings from all pages (up to `maxPages`), resetting the card counter to 0 on each new page

### 5. Data Extraction

For each job card:

```typescript
const row = await extractJobRow(card, site);
// Extracts: title, company ("Vanguard"), location, posted date, URL, job_id
```

### 6. AI Filtering (Two-Stage)

#### Stage 1: Title Filter

Removes obviously irrelevant jobs based on title/company/location. Uses the DeepInfra (primary) or Gemini (fallback) provider:

```typescript
const { removalSet, reasons } = await filterTitlesWithAi(stagedArray);
```

Rejected jobs are added to `seen.json` so they are skipped in future sessions.

#### Stage 2: Detail Evaluation

For remaining jobs, navigates to each job page, extracts the full description (primary selector: `div.fusion-tabs div.fusion-tab-content`), and sends it to the AI for evaluation:

```typescript
const acceptedRows = await evaluateDetailedJobs(
  context,
  filtered,
  seen,
  site,
  options.onJobAccepted   // fires on each accepted job for SSE streaming
);
```

Evaluates:

- Tech stack alignment (React, Angular, Java, Python, Node.js, etc.)
- Visa requirements (OPT/STEM OPT friendly)
- Experience requirements (5 years, not 6+)

The `onJobAccepted` callback is invoked immediately when a job is accepted, enabling the Express server to push real-time SSE events to connected clients.

### 7. Output

Accepted jobs are written to:

```
data/vanguardjobs.com/{MM_DD_YYYY}/jobs.csv
```

Session data is saved to:

```
data/vanguardjobs.com/{MM_DD_YYYY}/sessions/{session_id}/roles.csv
```

The function returns `Promise<JobRow[]>` containing all accepted rows.

## CLI Usage

### Basic Usage

```bash
# Use shared keywords from config
pnpm cli -- --site vanguard

# Override with custom keywords
pnpm cli -- --site vanguard --keywords "java,python,react"

# Skip batch delay for faster execution
pnpm cli -- --site vanguard --skip-batch-wait
```

### Advanced Usage

```bash
# Resume AI evaluation for existing session
pnpm cli -- --site vanguard --resume-session session_1234567890

# Combination
pnpm cli -- --site vanguard --keywords "full stack" --skip-batch-wait
```

### Server Mode

```bash
# Start Express API on port 3333
pnpm start

# Trigger a scrape via HTTP
curl -X POST http://localhost:3333/scrape \
  -H 'Content-Type: application/json' \
  -d '{"sites": "vanguard"}'

# Stream results via SSE
curl http://localhost:3333/scrape/{sessionId}/stream
```

## Data Flow

```
User Input (Keywords)
  |
Search Page (vanguardjobs.com)
  |
Sort by Newest (select option)
  |
Job Card Extraction (Title, Location, Date, URL)
  |
Deduplication Check (seen.json)
  |
AI Title Filter — DeepInfra (Nemotron) primary / Gemini fallback
  |
Navigate to Detail Pages
  |
Extract Full Description (fusion-tabs selector)
  |
AI Detail Evaluation (Tech Stack, Visa, Experience)
  |
onJobAccepted callback (SSE push to clients)
  |
Save to CSV (jobs.csv) + return JobRow[]
```

## Implementation Details

### Sort by Newest

```typescript
async function ensureNewestSort(page, selectors, keyword) {
  const selectElement = page.locator(selectors.sortToggle).first();
  await selectElement.selectOption({ label: sortOptionText });
  await page.waitForLoadState("networkidle");
}
```

### Job ID Extraction

```typescript
function extractJobId(href: string): string | null {
  // Example: /job/22438637/android-technical-lead-ii-charlotte-nc...
  const match = href.match(/job\/(\d+)\//i);
  return match ? match[1] : null;
}
```

### Pagination (with Page Reset)

```typescript
while (true) {
  const totalCards = await cards.count();
  for (let index = processedCount; index < totalCards; index += 1) {
    const row = await extractJobRow(cards.nth(index), site);
    if (row) rows.push(row);
  }

  // Check for next page
  const nextButton = page.locator(selectors.next).first();
  if (!(await nextButton.isVisible())) break;

  await nextButton.click();
  await page.waitForLoadState("networkidle");
  processedCount = 0; // Reset for new page (pagination, not infinite scroll)
  pageIndex += 1;

  if (pageIndex >= site.run.maxPages) break;
}
```

### onJobAccepted Callback (SSE Streaming)

In server mode, the Express API passes an `onJobAccepted` callback through `RunOptions`. Each time `evaluateDetailedJobs` accepts a job, the callback pushes the `JobRow` to all connected SSE listeners:

```typescript
// server.ts — POST /scrape handler
const options: RunOptions = {
  onJobAccepted: (job: JobRow) => {
    session.jobs.push(job);
    for (const listener of session.listeners) {
      listener(job);  // writes SSE data frame to response stream
    }
  },
};

// vanguard/index.ts — inside evaluateDetailedJobs
onJobAccepted?.(role);  // fires per accepted job
```

## Error Handling

- Retries AI calls up to 3 times with exponential backoff
- Gracefully handles missing selectors (tries multiple description selectors in order)
- Logs detailed error messages with context
- Continues processing other keywords if one fails
- HTML-response detection: throws if API returns HTML instead of JSON (rate-limit guard)

## Performance Considerations

- **Batch Processing**: Keywords processed concurrently (default batch size: 5, configurable via `KEYWORD_BATCH_SIZE`)
- **Rate Limiting**: 30s delay between batches (skippable with `--skip-batch-wait`)
- **Headless Browser**: Uses Playwright with persistent context (non-headless by default)
- **Network Optimization**: Waits for `networkidle` state after page transitions
- **Auto-cleanup**: 3-day retention keeps the `data/` directory lean without manual intervention
