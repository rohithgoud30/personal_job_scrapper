# Personal Job Scraper (Playwright + TypeScript)

Headful Playwright automation that you can run on-demand to capture contract listings from Kforce today—and easily extend to other job boards tomorrow. Each site is driven entirely by JSON config, so adding new portals is just a matter of duplicating the site block. Results are saved per-day to `data/<host>/{MM_DD_YYYY}/new_jobs.csv` in US Eastern time (one CSV per day).

## Getting Started
1. Install dependencies and browser: `npm install && npx playwright install chromium`.
2. Copy `.env.example` to `.env`, set `ZAI_API_KEY` (Zhipu AI / Z.AI API key). Optional knobs: `ZAI_BASE_URL` (defaults to `https://api.z.ai/api/paas/v4/`), `KEYWORD_BATCH_SIZE` (parallel keyword tabs) and `TEST_RUN_DATE=YYYY-MM-DD` if you want to backfill a previous day for testing.
3. Customize `config.json` (selectors, keyword list, throttle timings). All secrets live directly in this file.
4. Run once (default): `npm run start:once -- --site kforce`. The run stages roles per session, sends the combined titles to AI for pruning, then visits each approved job for a full-text AI check before writing to the daily CSV. Make sure no other Chromium window is using the site’s persistent profile (e.g., `.playwright/kforce`) before launching.
5. Optional scheduling later: `npm run start -- --site <key> --schedule` (honors `schedule.cron` only when you add `--schedule`; manual runs remain the default). When you add more sites, pass comma-separated keys (e.g., `--site kforce,newPortal`).

## Key Behaviors
- **Persistent profile**: `.playwright/<site>` stores cookies/login so subsequent runs reuse the session.
- **Cookie consent**: OneTrust banner is auto-accepted on load via selectors in config.
- **Contract-only filtering**: `jobTypeFilter` + `jobTypeFacet*` selectors ensure the Contract facet is selected before searching; each job card is double-checked for the same type.
- **Newest-first ordering**: The search dropdown is switched to “Newest Jobs First” before scraping, and each day’s `new_jobs.csv` is rewritten so the latest records appear at the top.
- **Per-day dedupe**: `seen.json` (per date folder) tracks stable job IDs; only unseen postings make it into the CSV.
- **Two-stage AI filtering**:
  1. After scraping completes, all staged titles/companies/locations/URLs are sent in one array to the Z.AI `glm-4.6` model so it can drop irrelevant roles before further processing.
  2. Each remaining role is visited individually; the full job description is scored by the `glm-4.5` model, and only “accepted” postings are written to `new_jobs.csv`.
- **Timestamps**: Every row includes `scraped_at` (e.g., `1:05 PM ET`) for quick auditing.
- **CSV columns**: `site,title,company,location,posted,url,job_id,scraped_at` (no summary/description text stored). Each site writes into `data/<host>/<date>/new_jobs.csv`.
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
