# Adding New Sites

How to add a new job board scraper to the system.

## Overview

Adding a new site involves 4 files:

1. `config.json` — Site configuration (selectors, keywords, throttling)
2. `src/sites/<key>/index.ts` — Scraper implementation
3. `src/lib/scrapeOrchestrator.ts` — Register in the `runSite()` switch
4. `docs/architecture/<key>.md` — Architecture documentation

## Step 1: Add Config Entry

Add a new object to `config.json` → `sites[]`:

```json
{
  "key": "newsite",
  "host": "newsite.com",
  "userDataDir": ".playwright/newsite",
  "login": {},
  "search": {
    "url": "https://newsite.com/jobs",
    "criteria": {
      "searchKeywords": [],
      "location": ""
    },
    "selectors": {
      "keywords": "input#search",
      "submit": "button[type='submit']",
      "card": ".job-card",
      "title": ".job-card a.title",
      "company": ".job-card .company",
      "locationText": ".job-card .location",
      "posted": ".job-card .date",
      "next": "a.next-page"
    },
    "postedTodayOnly": true,
    "jobTypeFilter": []
  },
  "run": {
    "maxPages": 5,
    "throttleSeconds": 2,
    "pageDelaySeconds": 2,
    "keywordDelaySeconds": 30
  },
  "disallowPatterns": [],
  "cookieConsent": {
    "buttonSelectors": [],
    "textMatches": ["Accept"]
  },
  "ai": {}
}
```

**Key fields:**
- `key` — Unique identifier used in CLI (`--site=newsite`) and API
- `host` — Domain name (used for data folder path)
- `userDataDir` — Persistent Chromium profile path
- `search.selectors` — CSS selectors for the site's DOM
- `postedTodayOnly` — Only scrape jobs posted today
- `run.maxPages` — Maximum pagination depth
- `disallowPatterns` — URL patterns to skip (e.g., `/apply/`)

## Step 2: Create the Scraper

Create `src/sites/newsite/index.ts`:

```typescript
import path from "path";
import { BrowserContext, Page, chromium } from "playwright";
import { OutputConfig, SiteConfig } from "../../lib/config";
import { acceptCookieConsent } from "../../lib/cookies";
import { appendJobRows, JobRow } from "../../lib/csv";
import { computeJobKey, loadSeenStore, saveSeenStore } from "../../lib/dedupe";
import { buildOutputPaths, buildSessionPaths, ensureDirectoryExists } from "../../lib/paths";
import { findSessionById, parseDateFolderLabel, readSessionCsv } from "../../lib/session";
import { getEasternDateLabel, getEasternTimeLabel } from "../../lib/time";
import { env, getRunDateOverride } from "../../lib/env";
import { sleep } from "../../lib/throttle";
import { evaluateJobDetail, findIrrelevantJobIds, TitleEntry } from "../../lib/aiEvaluator";
import { rejectedLogger } from "../../lib/rejectedLogger";
import { RunOptions } from "../types";

export async function runNewSiteSite(
  site: SiteConfig,
  output: OutputConfig,
  options: RunOptions = {}
): Promise<JobRow[]> {
  // 1. Setup (paths, session, browser)
  // 2. Scrape or resume
  // 3. AI title filter
  // 4. AI detail evaluation (pass options.onJobAccepted)
  // 5. Write CSV, save seen store
  // 6. Return accepted rows
}
```

Follow the patterns in existing scrapers. See `docs/CONTRIBUTING.md` → "Site Scraper Patterns".

**Critical requirements:**
- Return `Promise<JobRow[]>`
- Thread `options.onJobAccepted` to `evaluateDetailedJobs()`
- Call `onJobAccepted?.(role)` after `accepted.push(role)`
- Close browser context in `finally` block
- Support `options.resumeSessionId` for session resume

## Step 3: Register the Scraper

In `src/lib/scrapeOrchestrator.ts`, add to the imports and switch:

```typescript
import { runNewSiteSite } from "../sites/newsite";

// In runSite():
case "newsite":
  return runNewSiteSite(site, output, options);
```

## Step 4: Test

```bash
# Type check
pnpm typecheck

# Test CLI
pnpm cli -- --site=newsite --fast

# Test server
pnpm start
curl -X POST http://localhost:3333/scrape \
  -H 'Content-Type: application/json' \
  -d '{"sites":"newsite"}'

# Verify it appears in available sites
curl http://localhost:3333/status
```

## Step 5: Document

Create `docs/architecture/newsite.md` following the template in `docs/CONTRIBUTING.md`.

## Tips

- **Start simple**: Get basic scraping working before adding date filters or sort logic
- **Use `page.evaluate()`** for bulk DOM extraction (faster than locator iteration)
- **Handle popups/modals**: Many sites have cookie consent, notification prompts, or login overlays
- **Respect rate limits**: Use appropriate `throttleSeconds` and `keywordDelaySeconds`
- **Test `postedTodayOnly`**: Date formats vary wildly between sites
- **Check `disallowPatterns`**: Filter out `/apply/`, `/login/`, or tracking URLs
