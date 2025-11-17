# Kforce Job Scraper

Headful Playwright automation that you can run on-demand to capture contract listings from Kforce, saving all new postings per keyword to `data/kforce.com/{MM_DD_YYYY}/new_jobs.csv` in US Eastern time (one CSV per day).

## Getting Started
1. Install dependencies and browser: `npm install && npx playwright install chromium`.
2. Customize `config.json` (selectors, keyword list, throttle timings). All secrets live directly in this file.
3. Run once (default): `npm run start:once -- --site kforce` (headful session, contract facet + newest sort enforced automatically). Make sure no other Chromium window is using `.playwright/kforce` before launching (close prior runs if needed).
4. Optional scheduling later: `npm run start -- --site kforce --schedule` (honors `schedule.cron` only when you add `--schedule`; manual runs remain the default).

## Key Behaviors
- **Persistent profile**: `.playwright/kforce` stores cookies/login so subsequent runs reuse the session.
- **Cookie consent**: OneTrust banner is auto-accepted on load via selectors in config.
- **Contract-only filtering**: `jobTypeFilter` + `jobTypeFacet*` selectors ensure the Contract facet is selected before searching; each job card is double-checked for the same type.
- **Newest-first ordering**: The search dropdown is switched to “Newest Jobs First” before scraping, and each day’s `new_jobs.csv` is rewritten so the latest records appear at the top.
- **Per-day dedupe**: `seen.json` (per date folder) tracks stable job IDs; only unseen postings make it into the CSV.
- **Timestamps**: Every row includes `scraped_at` (e.g., `1:05 PM ET`) for quick auditing.
- **CSV columns**: `site,title,company,location,posted,url,job_id,scraped_at` (no summary/description text stored).
- **Run timer + summary**: While the scraper runs you’ll see a live elapsed timer (like a package install), and when it finishes the CLI logs the total duration.

## Config Highlights (`config.json`)
- `schedule.cron`: optional cron expression if/when you enable scheduling with `--schedule`.
- `output.pattern`: date/hour structure; uses Eastern time under the hood.
- `sites[].search.criteria.keywords`: full library of keyword/boolean strings.
- `sites[].search.postedTodayOnly`: skip anything not posted on the current Eastern day.
- `sites[].search.jobTypeFilter`: accepted job-type labels (e.g., `"Contract"`).
- `sites[].search.selectors.*`: selectors for search inputs, pagination, sort dropdown, job-type facet, listing fields, etc. Adjust here when DOM changes—no code edits required.

## Docs
See `docs/architecture/kforce.md` for a deeper explanation of the architecture, compliance strategy, and extension points.
