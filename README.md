# Personal Job Scraper

A powerful, customizable CLI tool to scrape job listings from various sites, filter them using AI, and save the best matches.

## 🚀 Getting Started

### 1. Prerequisites

- **Node.js** (v18 or higher)
- **Git**

### 2. Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/rohithgoud30/personal_job_scrapper.git
cd personal_job_scrapper
npm install
npx playwright install chromium
```

### 3. Configuration

1.  Copy the example environment file:
    ```bash
    cp .env.example .env
    ```
2.  Edit `.env` and add your **Zhipu AI API Key** (required for AI filtering):
    ```env
    ZAI_API_KEY=your-z-ai-key
    ZAI_BASE_URL=https://api.z.ai/api/coding/paas/v4
    KEYWORD_BATCH_SIZE=5
    TEST_RUN_DATE=2025-11-14
    ```
    - `ZAI_API_KEY`: Your Zhipu AI API key (required).
    - `ZAI_BASE_URL`: API endpoint (optional, defaults shown).
    - `KEYWORD_BATCH_SIZE`: Number of parallel keyword searches (optional, default 5).
    - `TEST_RUN_DATE`: Backfill date in YYYY-MM-DD format (optional, leave empty for live runs).

## 🏃‍♂️ Running the Scrapers

You can run scrapers for individual sites using the following commands.

### **CorpToCorp** (`corptocorp.org`)

Scrapes C2C job listings, handles popups, sorts by date, and applies strict visa filtering (Accepts OPT/STEM OPT, Rejects H1B/USC-only).

```bash
npm start -- --site=corptocorp
```

### **Kforce** (`kforce.com`)

Scrapes contract roles, filters for "Contract" type, and sorts by newest.

```bash
npm start -- --site=kforce
```

### **Randstad** (`randstadusa.com`)

Scrapes contract jobs from Randstad.

```bash
npm start -- --site=randstadusa
```

### **Run All Sites**

To run all configured sites sequentially:

```bash
npm start
```

## 🧠 How It Works

1.  **Scraping**: The tool launches a browser (Playwright), navigates to the site, searches for keywords defined in `config.json`, and extracts job listings.
2.  **AI Filtering (Stage 1)**: It uses an AI model to filter out irrelevant job titles (e.g., Data Engineer, .NET, Legacy Tech).
3.  **AI Evaluation (Stage 2)**: It visits each remaining job page, extracts the full description, and uses a more powerful AI model to evaluate:
    - **Tech Stack**: Modern Web (React, Node, Python, Java).
    - **Experience**: 5 to <6 years.
    - **Visa**: Strict checks (e.g., for CorpToCorp, it ensures OPT/STEM OPT compatibility).
4.  **Output**: Approved jobs are saved to `data/<site>/<date>/new_jobs_<date>.csv`.

## 📂 Documentation

For detailed architecture and logic of each scraper, see the documentation:

- [**CorpToCorp Architecture**](docs/architecture/corptocorp.md)
- [**Kforce Architecture**](docs/architecture/kforce.md)
- [**Randstad Architecture**](docs/architecture/randstadusa.md)
