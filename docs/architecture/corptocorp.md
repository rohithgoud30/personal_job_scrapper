# CorpToCorp Scraper Architecture

This document explains the workflow for the `corptocorp.org` scraper, designed to aggregate C2C job listings. It follows the same architectural principles as the Kforce scraper but is tailored to the specific structure and behavior of the CorpToCorp website.

## 1. Configuration & Environment

- **Config**: Defined in `config.json` under the `corptocorp` key.
  - **Search URL**: `https://corptocorp.org/c2c-jobs/`
  - **Selectors**: Custom selectors for the DataTables-based job list (`table#ipt-posts-table`), search input, and pagination.
  - **Delays**: Configured with `keywordDelaySeconds` (default 1s) for fast batch processing.
- **Environment**: Uses `.env` for AI API keys (`zAiApiKey`) and batch sizing (`KEYWORD_BATCH_SIZE`).

## 2. Execution Workflow

The scraper is launched via `npm start -- --site=corptocorp`.

### A. Navigation & Popup Handling

1.  **Navigate**: Opens the main jobs page.
2.  **Popup Dismissal**:
    - **"NOT YET" Notification**: Checks for and clicks "NOT YET" if a notification subscription popup appears.
    - **"Important Notice"**: Checks for and clicks "Okay" on the site's disclaimer popup.
    - This ensures the UI is clear for interaction.

### B. Search & Sorting

1.  **Keyword Search**: Enters keywords into the DataTables search box (`input[type="search"]`).
2.  **Automatic Sorting**:
    - The scraper **automatically sorts by Date (Newest First)**.
    - It clicks the "Posted Date" header until the class indicates descending sort (`sorting_desc`).
    - This ensures the most recent jobs are prioritized.

### C. Pagination & Extraction

1.  **Loop**: Iterates through pages using the "Next" button (`#ipt-posts-table_next`).
2.  **Stop Conditions**:
    - Stops if no jobs on the current page are dated "today" (when `postedTodayOnly` is true).
    - Stops if `maxPages` limit is reached.
3.  **Data Extraction**:
    - **Title/Link**: Extracted from the first column.
    - **Date**: Uses `data-order` attribute for precise timestamp, falling back to visible text.
    - **Company**: Hardcoded to "CorpToCorp" (aggregator).

## 3. AI Evaluation & Filtering

The scraper uses a two-stage AI process to ensure high-quality results matching specific criteria.

### Stage 1: Title Filtering

- **Model**: `glm-4.6`
- **Logic**: Removes roles clearly irrelevant to modern web/full-stack engineering (e.g., Data Engineering, BI, Legacy Tech, .NET, C#).
- **Input**: Batch of job titles/metadata.

### Stage 2: Detail Evaluation

- **Model**: `glm-4.5-Air`
- **Input**: Full job description extracted from the `.entry-content` container.
- **Criteria**:
  1.  **Tech Stack**: Focus on Modern Web (React, Angular, Node.js, Python/FastAPI, Java/Spring Boot).
  2.  **Experience**: Accepts **5 to <6 years** (e.g., "5 years", "1-5 years"). Rejects 6+ years.
  3.  **Visa Requirements (STRICT)**:
      - **MUST ACCEPT**: Roles allowing **OPT**, **STEM OPT**, or having **no visa restrictions**.
      - **MUST REJECT**: Roles restricted to **H1B**, **H4**, **GC**, or **US Citizen** ONLY (e.g., "USC Only", "No OPT").
      - **Logic**: If a role lists multiple visas including OPT (e.g., "USC, GC, OPT"), it is **ACCEPTED**.

## 4. Output

- **Session Storage**: Raw scraped data is saved in `data/corptocorp.org/<DATE>/sessions/<SESSION_ID>/roles/new_roles.csv`.
- **Final CSV**: Approved jobs are appended to `data/corptocorp.org/<DATE>/new_jobs_<DATE>.csv`.

## 5. Resuming Sessions

You can re-run the AI evaluation on already scraped data (e.g., to test new visa rules) without re-scraping:

```bash
npm start -- --site=corptocorp --session=<SESSION_ID>
```

This skips the browser scraping and immediately processes the staged roles in the specified session folder.
