# Personal Job Scraper Architecture (Kforce implementation today, reusable for future portals)

This document explains the entire workflow in plain language so anyone can understand how the scraper operates without diving into the code. When you add new sites, follow the same building blocks: config-only selectors, headful Playwright automation, polite crawling, and per-day CSV output.

## 1. Configuration-Driven Workflow
- `config.json` is the single source of truth. It stores everything: cron schedule, output paths, keyword lists, selectors, throttling rules, disallow patterns, cookie-consent buttons, job-type filters, etc.
- Each site entry includes a unique `key`, `host`, persistent profile path, search selectors, and pacing instructions. To add a new site, copy the block, adjust selectors/keywords, and create a corresponding runner file if the flow differs (Kforce uses `src/sites/kforce/index.ts`).
- No `.env` files or hidden secrets—everything lives in config for transparency and auditability.

## 2. Execution Modes
- Default run (`npm run start:once -- --site <key>`) executes headfully once, using the persistent profile in `.playwright/<key>`. You get a visible Chromium window to watch the scraper operate, see cookie banners, and spot DOM changes quickly.
- Optional scheduling (`--schedule`) wraps `node-cron`: the same code path fires at the configured minute/hour. Because cron is opt-in, there’s no risk of background jobs until you explicitly enable them.
- The CLI accepts comma-separated `--site` values, so in the future you can run multiple portals sequentially without changing any code.

## 3. Browser Session & Compliance
- Playwright launches via `launchPersistentContext` to keep cookies and login state between runs. If a window is already open with that profile, the run stops to avoid corrupting the profile (close older windows before relaunching).
- Cookie consent is handled immediately using config-driven selectors (e.g., OneTrust “Accept” button). This ensures behavior matches real users and prevents pop-ups from blocking the main flow.
- Robots considerations: the scraper never clicks disallowed URLs (matching `disallowPatterns`), throttles actions/pagination per config, and respects the intent behind crawl delays even if they’re advisory.

## 4. Search & Filtering Logic
- Every interaction uses selectors from config: keyword field, location input, search button, job cards, title, posting date, job type, pagination, sort dropdown, etc. If the site’s DOM changes, edit config—no code rebuild needed.
- Before searching, the runner applies site-specific filters that align with your goals. For Kforce, we enable the “Contract” facet and only keep cards whose job-type text confirms “Contract”.
- The script enforces “posted today” using US Eastern time. If page 1 of results doesn’t contain any current-day jobs, pagination stops immediately and the scraper moves on to the next keyword. This minimizes traffic and honors the “today only” requirement.

## 5. Sorting & Data Ordering
- After results load, the runner confirms the dropdown reads “Newest Jobs First”. If not, it opens the dropdown and selects that option, then waits for the refreshed list. This ensures every keyword sees the same newest-first view without manual intervention.
- The scraper buffers new rows per keyword and prepends them to the day’s CSV, so you always see the latest discoveries at the top. Every row includes `scraped_at` (12-hour ET) for auditing.

## 6. Storage & Dedupe
- Output path pattern: `data/<host>/<MM_DD_YYYY>/new_jobs.csv` plus a `seen.json` in the same folder. Each day gets exactly one CSV per site, making it simple to archive or share.
- `seen.json` stores stable identifiers (prefer actual job IDs, fallback to title/company/location/url hash). Before writing, rows are filtered against `seen.json` so duplicates never re-enter the CSV in the same day.
- CSV columns are fixed (`site,title,company,location,posted,url,job_id,scraped_at`) to keep files compact and consistent across sites.

## 7. Observability & Recovery
- Real-time logging tracks each keyword (`scraped X, new Y`), pagination decisions, and skip reasons (“no today postings”). When adding new portals, reuse the same logging semantics so you can compare sites easily.
- A live elapsed timer shows progress like npm installs. Once the run ends, the CLI prints a summary with total runtime and number of sites processed.
- Headful mode leaves the browser visible if an error occurs, allowing you to inspect selectors, login prompts, or network issues on the spot. Persistent profiles mean you usually log in once; if a session expires, the next run pauses with the login form for manual action.

## 8. Future Expansion
- To onboard another job board, duplicate the Kforce config block, pick new selectors/keywords, and add a corresponding runner if the workflow deviates. Shared utilities in `src/lib` (config loader, CSV helper, dedupe store, throttle, cookie handler, time formatting) already support multiple sites without change.
- You can run new sites individually (`--site newSite`) or alongside existing ones (`--site kforce,newSite`). Each site will write into its own `data/<host>/...` tree.
- Because the entire setup is config-driven, scaling to multiple portals is mostly about creating reliable selectors and respecting each site’s robots guidance—no need to recompile or redeploy code for every tweak.

## 8. Extensibility Considerations
- To add more sites, duplicate the config block and create a sibling runner module; the shared libraries (paths, CSV, dedupe, throttle, cookies) already support multiple sites.
- Keyword lists live entirely in JSON, so you can tailor them per site without code deployments.
- Output files and dedupe stores are per-host/per-date, making it easy to sync or archive results without affecting other runs.
