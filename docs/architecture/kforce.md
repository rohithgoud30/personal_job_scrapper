# Kforce Scraper Architecture Overview

## 1. High-Level Flow
- A single JSON config (`config.json`) defines scheduling, output paths, and all site-specific settings. Nothing relies on `.env` files.
- The entrypoint (`npm run start:once -- --site kforce`) launches Playwright in persistent, headful mode so you can observe the browser. The same profile keeps cookies, login, and cookie-consent state between runs.
- Each run (triggered manually or via the optional scheduler) iterates through your curated keyword list. For every keyword, the scraper fills the search form, enforces "Newest Jobs First" sorting, harvests the listing cards, and stops pagination as soon as no “posted today” records appear on the current page.
- New jobs are deduped per day using `seen.json`. Any new rows are written to `data/kforce.com/{MM_DD_YYYY}/new_jobs.csv` with the latest results prepended so you always see the freshest jobs first.

## 2. Scheduling & Execution
- `node-cron` support is built in but only activates when you launch the script with `--schedule`; otherwise the runner executes once and exits. You can still target only Kforce via `--site kforce`.
- Manual and scheduled modes share the same path: load `config.json`, filter selected sites, and execute the site runner sequentially.
- Headful mode (`headless: false`) is intentional to provide visual feedback; the persistent profile directory is configurable per site.

## 3. Browser Session & Compliance
- Playwright uses `launchPersistentContext`, pointing at `.playwright/kforce`, so cookies and login persist. If Chromium is already open on that profile, the run aborts to prevent corruption.
- On first load, `acceptCookieConsent` clicks the site’s OneTrust “Accept” button based on selectors defined in config, keeping behavior aligned with real users.
- Every keyword search respects robots intent by skipping links containing disallowed substrings (e.g., `apply-online`) and by pacing actions (per-keyword delay, per-page delay) as set in config.
- Before each run, close any leftover Playwright/Chromium windows tied to `.playwright/kforce`; the profile uses a singleton lock to avoid corruption.

## 4. Search & Filtering Logic
- Keyword input, location select, submit button, pagination triggers, and sort controls are all driven by selectors sourced from the config. No selectors are hardcoded in the runner, so adjustments require only JSON edits.
- The runner enforces “posted today” by comparing the listing’s date against the current day in US Eastern time. If the first page lacks any “today” postings, pagination stops immediately and the scraper moves on to the next keyword.
- Only “Contract” roles are retained: the job type text is read from each card and compared (case-insensitively) against the `jobTypeFilter` list.

## 5. Sorting & Data Ordering
- After the initial search results load, the runner checks the sort dropdown. If it isn’t already on “Newest Jobs First”, it opens the React-select menu and clicks that option, then waits for the refreshed list before continuing.
- Scraped rows are buffered per keyword and stacked so that the newest entries appear first. When the run finishes, all new rows for that collection cycle are written to `new_jobs.csv` in descending order (newest on top), with `scraped_at` timestamps showing when each record was captured.
- CSV schema is fixed: `site,title,company,location,posted,url,job_id,scraped_at`. No summary/description text is persisted, keeping files concise.

## 6. Storage & Dedupe Strategy
- `data/{host}/{MM_DD_YYYY}/new_jobs.csv` is the canonical output structure (one CSV per Eastern day). A matching `seen.json` sits alongside each date folder.
- `seen.json` stores stable job IDs (URL-derived if available, otherwise a hash of title/company/location/url). Before writing, every candidate row is deduped, ensuring only fresh jobs reach the CSV.
- CSV writing is append-but-rewrite: new rows are generated first, then existing content is read and re-saved with the new block at the top. Headers remain intact.

## 7. Observability & Recovery
- Console logs announce each keyword’s progress (`scraped`, `new`, cumulative totals) along with pagination skips when no “today” results are found.
- If Playwright selectors fail due to DOM changes, the headful window stays open so you can inspect and update the JSON selectors quickly.
- Persistent profiles mean login is typically one-time; if the session expires, the next run surfaces a visible login screen for manual intervention.
- A live elapsed timer (similar to npm installs) shows progress while the run is active, and the CLI prints a completion summary with the total runtime once it finishes.

## 8. Extensibility Considerations
- To add more sites, duplicate the config block and create a sibling runner module; the shared libraries (paths, CSV, dedupe, throttle, cookies) already support multiple sites.
- Keyword lists live entirely in JSON, so you can tailor them per site without code deployments.
- Output files and dedupe stores are per-host/per-date, making it easy to sync or archive results without affecting other runs.
