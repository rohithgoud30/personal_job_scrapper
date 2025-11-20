# Vanguard Jobs Architecture

## Overview

The Vanguard Jobs scraper (`src/sites/vanguard/index.ts`) automates job data extraction from `vanguardjobs.com`. It follows the standardized architecture pattern used across all scrapers in this project.

## Key Features

- **Keyword-based search**: Searches for jobs using configurable keywords
- **Pagination support**: Processes multiple pages of results
- **Sort by date**: Automatically sorts results by "Newest"
- **AI-powered filtering**: Two-stage AI evaluation (title filter + detail evaluation)
- **Session management**: Supports resuming from saved sessions
- **Deduplication**: Prevents re-processing of previously seen jobs

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

- **`postedTodayOnly`: false** - Vanguard posts often show future dates, so date filtering is disabled
- **Keywords**: Inherits from `sharedSearchKeywords` in global config when not specified
- **Sort**: Automatically selects "Newest" option to get most recent jobs first

## Workflow

### 1. Session Initialization

```typescript
const sessionId = createSessionId();
const sessionPaths = buildSessionPaths(outputPaths, sessionId);
```

### 2. Keyword Processing

Keywords are processed in batches (default: 5 concurrent):

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

### 3. Search Flow

For each keyword:

1. Navigate to search page
2. Accept cookie consent (if present)
3. Fill keyword input
4. Submit search
5. Wait for results to load
6. Select "Newest" sort option
7. Collect job listings from all pages (up to `maxPages`)

### 4. Data Extraction

For each job card:

```typescript
const row = await extractJobRow(card, site);
// Extracts: title, company, location, posted date, URL, job_id
```

### 5. AI Filtering (Two-Stage)

#### Stage 1: Title Filter

Removes obviously irrelevant jobs based on title/company/location:

```typescript
const { removalSet, reasons } = await filterTitlesWithAi(stagedArray);
```

#### Stage 2: Detail Evaluation

For remaining jobs, fetches and analyzes full job descriptions:

```typescript
const acceptedRows = await evaluateDetailedJobs(context, filtered, seen, site);
```

Evaluates:

- Tech stack alignment (React, Angular, Java, Python, Node.js, etc.)
- Visa requirements (OPT/STEM OPT friendly)
- Experience requirements (5 years, not 6+)

### 6. Output

Accepted jobs are written to:

```
data/vanguardjobs.com/{MM_DD_YYYY}/jobs.csv
```

Session data is saved to:

```
data/vanguardjobs.com/{MM_DD_YYYY}/sessions/{session_id}/roles.csv
```

## CLI Usage

### Basic Usage

```bash
# Use shared keywords from config
npm run start -- --site vanguard

# Override with custom keywords
npm run start -- --site vanguard --keywords "java,python,react"

# Skip batch delay for faster execution
npm run start -- --site vanguard --skip-batch-wait
```

### Advanced Usage

```bash
# Resume AI evaluation for existing session
npm run start -- --site vanguard --resume-session session_1234567890

# Combination
npm run start -- --site vanguard --keywords "full stack" --skip-batch-wait
```

## Data Flow

```
User Input (Keywords)
  ↓
Search Page (vanguardjobs.com)
  ↓
Sort by Newest
  ↓
Job Card Extraction (Title, Location, Date, URL)
  ↓
Deduplication Check
  ↓
AI Title Filter (Remove Irrelevant)
  ↓
Navigate to Detail Pages
  ↓
Extract Full Description
  ↓
AI Detail Evaluation (Tech Stack, Visa, Experience)
  ↓
Save to CSV (jobs.csv)
```

## Implementation Details

### Sort by Newest

```typescript
async function ensureNewestSort(page, selectors) {
  const selectElement = page.locator(selectors.sortToggle).first();
  await selectElement.selectOption({ label: "Newest" });
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

### Pagination

```typescript
while (true) {
  // Process current page
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
  processedCount = 0; // Reset for new page
  pageIndex += 1;

  if (pageIndex >= site.run.maxPages) break;
}
```

## Error Handling

- Retries AI calls up to 3 times with exponential backoff
- Gracefully handles missing selectors
- Logs detailed error messages with context
- Continues processing other keywords if one fails

## Performance Considerations

- **Batch Processing**: 5 keywords processed concurrently
- **Rate Limiting**: 30s delay between batches (configurable)
- **Headless Browser**: Uses Playwright with persistent context
- **Network Optimization**: Waits for `networkidle` state
