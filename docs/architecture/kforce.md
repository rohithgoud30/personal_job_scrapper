# Personal Job Scraper Architecture (Kforce implementation today, reusable for future portals)

This document explains the entire workflow in plain language so anyone can understand how the scraper operates without diving into the code. When you add new sites, follow the same building blocks: config-only selectors, headful Playwright automation, polite crawling, and per-day CSV output.

## 1. Configuration & Environment
- `config.json` remains the single source of truth for scheduling, selectors, throttling, job-type filters, and the keyword list (`searchKeywords`). Each site entry includes its own persistent profile path so Playwright can keep cookies/login between runs.
- `.env` (copied from `.env.example`) supplies OpenRouter/OpenAI credentials and `KEYWORD_BATCH_SIZE`. No other secrets are needed.

## 2. Execution Modes & Parallelism
- The default command (`npm run start:once -- --site <key>`) launches a headful persistent browser once. Keywords are processed in parallel batches (size drawn from `KEYWORD_BATCH_SIZE`), each batch using separate Playwright tabs so five keywords can run simultaneously (then the next five, etc.).
- Optional scheduling (`--schedule`) still uses `node-cron`, but only when you explicitly pass the flag. Multiple sites can be specified via comma-separated `--site` values.

## 3. Browser Session & Compliance
- Playwright uses `launchPersistentContext` against `.playwright/<key>`. Close any older windows using that profile before starting a new run; the browser enforces a singleton lock to prevent corruption.
- Cookie consent (OneTrust) is automatically accepted every time a new tab opens. Contract filters and “Newest Jobs First” sorting are re-applied on each tab as well.
- Robots guidelines are honored by skipping disallowed URLs, throttling pagination, and limiting page depth. The script still abandons pagination when page 1 contains no “posted today” listings.

## 4. Staging, Sessions, and Dedupe
- Every run receives a `session-<timestamp>` folder under `data/<host>/<date>/sessions/<sessionId>`. Raw results (after deduping against `seen.json`) land in `roles/new_roles.csv` with columns `session_id, keyword, ... job details`.
- `seen.json` continues to store stable job IDs per date, so `new_roles.csv` only contains brand-new rows. After a job is approved later in the pipeline, its ID is added to `seen.json` to prevent reprocessing.

## 5. Two-Stage AI Filtering
1. **Title array filtering** – After all keywords finish, the scraper sends an array of `{ title, company, location, url, job_id }` objects to the OpenRouter model. The model returns the job IDs that should be removed. Those rows are deleted from the session file so only promising roles remain.
2. **Full-page evaluation** – Each remaining role is opened individually. The full job description is captured and sent to the model. Only roles that receive `accepted: true` are promoted to the daily `new_jobs.csv`.

## 6. Final Output
- Approved jobs are appended (newest first) to `data/<host>/<MM_DD_YYYY>/new_jobs.csv` with columns `site,title,company,location,posted,url,job_id,scraped_at`. The day-level CSV is rewritten so new entries stay on top.
- Each run prints how many roles were accepted and where they were written.

## 7. Observability & Recovery
- Console logs cover keyword batches, parallel tab activity, AI removals, and detail evaluations. When another site is added, reuse the same logging style so output stays consistent.
- A live `[runner] Elapsed` timer stays pinned to the terminal while the run executes, and a completion summary prints the total duration once everything finishes.
- Headful tabs remain visible during scraping and evaluation, so if a DOM change or login prompt occurs you can intervene immediately.

## 8. Extending to New Sites
- Duplicate the Kforce block in `config.json`, adjust selectors/filters/keywords, and add a new `src/sites/<site>/index.ts` runner if the site needs custom interactions. Otherwise, the shared libs (config loader, AI wrapper, session writer, etc.) already handle multi-site execution.
- Each site writes into its own `data/<host>/...` tree and uses a dedicated persistent profile (`.playwright/<site>`), so there’s no cross-talk between portals.

## 8. Extensibility Considerations
- To add more sites, duplicate the config block and create a sibling runner module; the shared libraries (paths, CSV, dedupe, throttle, cookies) already support multiple sites.
- Keyword lists live entirely in JSON, so you can tailor them per site without code deployments.
- Output files and dedupe stores are per-host/per-date, making it easy to sync or archive results without affecting other runs.
