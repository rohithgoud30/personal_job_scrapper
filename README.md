# Personal Job Scraper (Playwright + TypeScript)

Headful Playwright automation that you can run on-demand to capture contract listings from Kforce today—and easily extend to other job boards tomorrow. Each site is driven entirely by JSON config, so adding new portals is just a matter of duplicating the site block. Results are saved per-day to `data/<host>/{MM_DD_YYYY}/new_jobs_{MM_DD_YYYY}.csv` in US Eastern time (one CSV per day).

## Getting Started
1. Install dependencies and browser: `npm install && npx playwright install chromium`.
2. Copy `.env.example` to `.env`, set `ZAI_API_KEY` (Zhipu AI / Z.AI API key). Optional knobs: `ZAI_BASE_URL` (defaults to `https://api.z.ai/api/paas/v4/`), `KEYWORD_BATCH_SIZE` (parallel keyword tabs) and `TEST_RUN_DATE=YYYY-MM-DD` if you want to backfill a previous day for testing.
3. Customize `config.json` (selectors, keyword list, throttle timings). All secrets live directly in this file.
4. Run once (default): `npm run start:once -- --site kforce`. The run stages roles per session, sends the combined titles to AI for pruning, then visits each approved job for a full-text AI check before writing to the daily CSV. Make sure no other Chromium window is using the site’s persistent profile (e.g., `.playwright/kforce`) before launching.
5. Optional scheduling later: `npm run start -- --site <key> --schedule` (honors `schedule.cron` only when you add `--schedule`; manual runs remain the default). When you add more sites, pass comma-separated keys (e.g., `--site kforce,newPortal`).

## Shortcuts
- Skip the 25–30s pauses between keyword batches when you need faster AI feedback: add `--skip-batch-wait` (use sparingly to stay polite to the host).
- Restart just the AI portion from a saved scrape: `npm run start:once -- --site kforce --resume-session <session-id>`. The session ID matches the folder under `data/<host>/<date>/sessions/<session-id>/roles/new_roles.csv`.

## Key Behaviors
- **Persistent profile**: `.playwright/<site>` stores cookies/login so subsequent runs reuse the session.
- **Cookie consent**: OneTrust banner is auto-accepted on load via selectors in config.
- **Contract-only filtering**: `jobTypeFilter` + `jobTypeFacet*` selectors ensure the Contract facet is selected before searching; each job card is double-checked for the same type.
- **Newest-first ordering**: The search dropdown is switched to “Newest Jobs First” before scraping, and each day’s `new_jobs_{date}.csv` is rewritten so the latest records appear at the top.
- **Per-day dedupe**: `seen.json` (per date folder) tracks stable job IDs; only unseen postings make it into the CSV.
- **Two-stage AI filtering with retries + reasoning**:
  1. After scraping completes, all staged titles/companies/locations/URLs are sent in one array to the Z.AI `glm-4.6` model; it removes anything not tied to the target web stacks (frontend React/Angular/Next.js/TS, React Native, backend Java/Spring Boot/Python/FastAPI/Node/Express, cloud microservices alongside those stacks).
  2. Each remaining role is visited individually; descriptions are re-fetched if short (10s, then 30s) before scoring with `glm-4.5-Air`. The model enforces the stack match (including React Native standalone or paired with backend), allows experience phrasing from 5 up to but under 6 years (e.g., `5` / `5+` / `1-5`), and rejects anything that explicitly includes 6+ (e.g., `6`, `6+`, `5-7`, `7-10`). It still rejects Go/Golang/.NET/C#. Accepted/rejected roles include a one-line reason in the logs. Both AI calls retry up to 3 times with backoff.
- **Timestamps**: Every row includes `scraped_at` (e.g., `1:05 PM ET`) for quick auditing.
- **CSV columns**: `site,title,company,location,posted,url,job_id,scraped_at` (no summary/description text stored). Each site writes into `data/<host>/<date>/new_jobs_{date}.csv`.
- **Run timer + summary**: While the scraper runs you’ll see a live elapsed timer (like a package install), and when it finishes the CLI logs the total duration.

## Config Highlights (`config.json`)
- `schedule.cron`: optional cron expression if/when you enable scheduling with `--schedule`.
- `output.pattern`: date/hour structure; uses Eastern time under the hood.
- `sites[].search.criteria.searchKeywords`: full library of keyword phrases for that site. Add as many as needed per portal.
- `sites[].search.postedTodayOnly`: skip anything not posted on the current Eastern day.
- `sites[].search.jobTypeFilter`: accepted job-type labels (e.g., `"Contract"`).
- `sites[].search.selectors.*`: selectors for search inputs, pagination, sort dropdown, job-type facet, listing fields, etc. Adjust here when DOM changes—no code edits required.

## Docs
See `docs/architecture/kforce.md` (current implementation) for a deeper explanation of the architecture, session folders, AI scoring, and extension points. Future sites will follow the same workflow.
