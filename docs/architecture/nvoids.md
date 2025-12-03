# Nvoids Scraper

## Overview

The `nvoids` scraper targets **Nvoids**, a job aggregator site. It is designed to find recent job postings, specifically filtering for those posted "Today".

## Key Features

- **"Today" Filtering**:
  - Checks if the job was posted "Today" in either **IST (India Standard Time)** or **EST (Eastern Standard Time)**.
  - Handles date formats like `HH:MM AM/PM DD-Mon-YY` (e.g., `03:18 AM 02-Dec-25`).
  - Supports legacy `MM/DD/YYYY` format.
- **AI Filtering**:
  - **Stage 1 (Title)**: Filters out irrelevant titles (e.g., non-tech, senior management if not targeted).
  - **Stage 2 (Detail)**: Extracts the full job description and uses AI to evaluate tech stack, experience, and visa requirements.
- **Pagination**: Automatically navigates through search results pages until no more "Today" jobs are found or the maximum page limit is reached.

## Configuration

Ensure your `config.json` includes the `nvoids` configuration block:

```json
"nvoids": {
  "host": "nvoids.com",
  "search": {
    "url": "https://jobs.nvoids.com/jobs_search.jsp",
    "postedTodayOnly": true,
    "selectors": {
      "keywords": "input[name='keywords']",
      "submit": "input[type='submit']",
      "next": "a:has-text('Next')"
    },
    "criteria": {
      "searchKeywords": [
        "Java Developer",
        "React Developer",
        "Python Developer"
      ]
    }
  },
  "run": {
    "maxPages": 10,
    "keywordDelaySeconds": 2
  },
  "disallowPatterns": []
}
```

## Usage

Run the scraper specifically for Nvoids:

```bash
npm start -- --site=nvoids
```

## Output

Results are saved in:
`data/nvoids/<date>/new_jobs_<date>.csv`

Rejected jobs are logged in:
`data/nvoids/<date>/rejected_jobs_<date>.xlsx`
