# Dice Scraper Architecture

This document explains the workflow for the `dice` scraper, designed to aggregate tech job listings from Dice.com. It features optimized bulk data extraction and specific filtering for "Today" and "Contract" roles.

## 1. Configuration & Environment

- **Config**: Defined in `config.json` under the `dice` key.
  - **Search URL**: `https://www.dice.com/jobs`
  - **Selectors**:
    - **Search**: `input[placeholder='Job title, skill, company, keyword']`
    - **Filters**: "Today" (`input[type='radio'][value='ONE']`) and "Contract" (`input[type='checkbox'][value='CONTRACT']`).
    - **Job Card**: `div[data-cy='search-result-card'], div:has(a[href*='/job-detail/'])`
    - **Title**: `a[href*='/job-detail/'][aria-label]` (Specific selector to avoid "Easy Apply" buttons).
    - **Description**: `#jobDescription`
  - **Delays**: Includes specific waits (`waitForTimeout`) to handle the filter drawer animation and SPA transitions.
- **Environment**: Uses `.env` for AI API keys and batch sizing.

## 2. Execution Workflow

The scraper is launched via `npm start -- --site=dice`.

### A. Navigation & Filtering

1.  **Navigate**: Opens the Dice jobs page.
2.  **Search**: Enters the keyword (e.g., "software engineer").
3.  **Apply Filters**:
    - Opens the "All filters" drawer.
    - Selects **"Today"** (Posted Date) to ensure only fresh jobs are scraped.
    - Selects **"Contract"** (Employment Type).
    - Clicks "Apply filters".
    - **Robustness**: Includes logic to scroll the drawer and fallback to clicking labels if checkboxes are intercepted.

### B. Optimized Extraction

1.  **Bulk Extraction**:
    - Instead of iterating through job cards one-by-one with Playwright locators (which is slow for 200+ items), the scraper uses `page.evaluate()` to extract **all** job data from the DOM in a single JavaScript execution.
    - This reduces scraping time for a full page of results from minutes to seconds.
2.  **Pagination**:
    - Checks for a "Next" button (`li.pagination-next a`).
    - **Smart Stop**: If the last job on the page was not posted "today" (e.g., "1 day ago"), pagination stops immediately for that keyword.

### C. Data Extraction Details

- **Title**: Extracted from the `aria-label` of the title link to ensure accuracy.
- **Company**: Extracted from the company profile link.
- **Location**: Extracted from `.search-result-location`.
- **Posted Date**: Extracted from `.search-result-posted-date`.
- **Job ID**: Parsed from the URL (UUID).

## 3. AI Evaluation & Filtering

The scraper uses the standard two-stage AI process shared across all sites.

### Stage 1: Title Filtering

- **Model**: `glm-4.6` (or configured model)
- **Logic**: Removes roles clearly irrelevant to modern web/full-stack engineering.
- **Input**: Batch of job titles/metadata.

### Stage 2: Detail Evaluation

- **Model**: `glm-4.5-Air` (or configured model)
- **Input**: Full job description extracted from `#jobDescription`.
- **Criteria**:
  1.  **Tech Stack**: Focus on Modern Web (React, Angular, Node.js, etc.).
  2.  **Experience**: Accepts **5 to <6 years**.
  3.  **Visa Requirements**: Checks for OPT/STEM OPT friendliness.

## 4. Output

- **Session Storage**: Raw scraped data is saved in `data/dice.com/<DATE>/sessions/<SESSION_ID>/roles/new_roles.csv`.
- **Final CSV**: Approved jobs are appended to `data/dice.com/<DATE>/new_jobs_<DATE>.csv`.

## 5. Resuming Sessions

You can re-run the AI evaluation on already scraped data without re-scraping:

```bash
npm start -- --site=dice --session=<SESSION_ID>
```
