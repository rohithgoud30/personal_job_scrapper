# Personal Job Scraper Architecture (Randstad USA implementation)

This mirrors the Kforce flow: headful Playwright, config‑only selectors, posted‑today filtering, AI title + detail checks, per‑day CSV output, and a persistent browser profile. The notes below highlight Randstad‑specific details so you can understand or adjust behavior without reading code.

## 1) Config & Env
- `config.json`: site block `randstadusa` plus `sharedSearchKeywords` (if the site’s keyword list is empty, the shared list is used). Uses the same cron/output settings as other sites.
- `.env`: Z.AI keys, `KEYWORD_BATCH_SIZE`, optional `TEST_RUN_DATE=YYYY-MM-DD` for backfill (treated as “today” in Eastern time), and the usual dotenv values.

## 2) Launch & Navigation
- Command: `npm start -- --site=randstadusa` (headful, persistent profile `.playwright/randstadusa`). Scheduling only happens when you pass `--schedule`.
- Each keyword opens in its own tab (batch size from `KEYWORD_BATCH_SIZE`), waits for `q-<slug>/` search page, accepts OneTrust cookies, sets “date” sort, applies posted‑today filter, and respects `maxPages`/polite delays.

## 3) Page Scrape
- Results: primary selector `ul.cards__list li.cards__item` (with backup DOM/anchor scraping if cards break).
- Parsed fields per card: title (`h3.cards__title a.cards__link`), location (`.cards__meta-item` with location icon), posted (`.cards__date`), url (relative -> absolute), job_id extracted from URL, `scraped_at` in ET.
- Posted‑today enforcement: dates normalized to Eastern `MM/DD/YYYY`; pagination stops if page 1 has no today rows and max page depth is capped.
- Job type filter: keeps only rows matching `jobTypeFilter` (Contract/Temporary/Temp to Perm).

## 4) Dedupe & Session
- Session ID: `session-<timestamp>`, with `roles/new_roles.csv` in `data/randstadusa/<date>/sessions/<sessionId>/`.
- `seen.json` per site/date prevents reprocessing. Each new role gets a stable key and is deduped against seen + staged.

## 5) Two-Stage AI (shared logic with Kforce)
- Title filter: sends the staged array (title/company/location/url/job_id) to Z.AI `glm-4.6`; removals are logged, and anything rejected never reaches detail.
- Detail evaluator: opens each remaining job page, re-scrapes description (with retries on short content), then sends full JD to `glm-4.5-Air`. Non‑matches log a reason; matches are appended to the day CSV.

## 6) Output
- Accepted roles append to `data/randstadusa/{MM_DD_YYYY}/{H}.csv` with columns `site,title,company,location,posted,url,job_id,scraped_at`.
- Session CSVs in `sessions/<sessionId>/roles` capture staged sets before AI and after title filter.

## 7) Observability & Safety
- Console logs: keyword starts, sort/post filters found, pagination stops, AI rejections/acceptances, and elapsed timer. Headful tabs stay visible for manual inspection.
- Robots compliance: throttle between pages/keywords, limit page depth, and allow polite pauses; disallow list skips apply URLs.

## 8) Extending or Tweaking
- Change keywords in `sharedSearchKeywords` or give Randstad its own list in `search.criteria.searchKeywords`.
- Adjust selectors in `config.json` if the UI shifts (card/title/location/posted/sort/job types).
- Update `maxPages`, delays, or jobTypeFilter as needed—no code changes required for common tweaks.
