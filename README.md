# Personal Job Scraper

A powerful, AI-powered CLI tool to scrape job listings from multiple sites, filter them intelligently, and save only the best matches.

## 🚀 Quick Start

```bash
# Clone the repository
git clone https://github.com/rohithgoud30/personal_job_scrapper.git
cd personal_job_scrapper

# Install dependencies
npm install
npx playwright install chromium

# Configure environment
cp .env.example .env
# Edit .env and add your ZAI_API_KEY

# Run a scraper
npm start -- --site=corptocorp
```

## 📋 Prerequisites

- **Node.js** v18 or higher
- **Git**
- **Zhipu AI API Key** ([Get one here](https://open.bigmodel.cn/))

## ⚙️ Configuration

### 1. Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
AI_API_KEY=your-api-key-here
AI_BASE_URL=https://api.openai.com/v1/
AI_MODEL=gpt-3.5-turbo
AI_TITLE_FILTER_MODEL=gpt-3.5-turbo
AI_DETAIL_EVAL_MODEL=gpt-4
KEYWORD_BATCH_SIZE=5
TEST_RUN_DATE=
```

| Variable                | Description                                           | Required | Example Values                                                                         |
| ----------------------- | ----------------------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `AI_API_KEY`            | API key for your AI provider                          | ✅ Yes   | OpenAI key, Zhipu AI key, etc.                                                         |
| `AI_BASE_URL`           | API endpoint URL                                      | ✅ Yes   | `https://api.openai.com/v1/` (OpenAI)<br>`https://api.z.ai/api/coding/paas/v4` (Zhipu) |
| `AI_TITLE_FILTER_MODEL` | Model for Stage 1 (title filtering)                   | ✅ Yes   | `gpt-3.5-turbo`, `glm-4.6`                                                             |
| `AI_DETAIL_EVAL_MODEL`  | Model for Stage 2 (detail evaluation)                 | ✅ Yes   | `gpt-4`, `glm-4.5-Air`                                                                 |
| `KEYWORD_BATCH_SIZE`    | Number of parallel keyword searches                   | ❌ No    | Default: `5`                                                                           |
| `TEST_RUN_DATE`         | Backfill date (YYYY-MM-DD, leave empty for live runs) | ❌ No    | `2025-11-14` or empty                                                                  |

#### 🔌 Supported AI Providers

This tool works with **any OpenAI-compatible API**, including:

- **OpenAI** (GPT-3.5, GPT-4, etc.)

  ```env
  AI_BASE_URL=https://api.openai.com/v1/
  AI_TITLE_FILTER_MODEL=gpt-3.5-turbo
  AI_DETAIL_EVAL_MODEL=gpt-4
  ```

- **Zhipu AI** (GLM models) - Current default

  ```env
  AI_BASE_URL=https://api.z.ai/api/coding/paas/v4
  AI_TITLE_FILTER_MODEL=glm-4.6
  AI_DETAIL_EVAL_MODEL=glm-4.5-Air
  ```

- **Azure OpenAI**, **Anthropic Claude** (via compatibility layers), or any other OpenAI-compatible endpoint

### 2. Site Configuration

All site-specific settings are in `config.json`:

- Search keywords
- CSS selectors
- Crawl delays
- AI filtering rules

> [!IMPORTANT]
> You must create a `config.json` file in the root directory.

**Example `config.json` structure for AI prompts:**

```json
{
  "ai": {
    "prompts": {
      "titleFilter": [
        "Your custom title filtering prompt here...",
        "Another line of instructions..."
      ],
      "detailEvaluation": [
        "Your custom detail evaluation prompt here...",
        "Rules for visa, experience, etc..."
      ]
    }
  }
  // ... other site configs
}
```

## 🎯 Usage

### Run Individual Sites

```bash
# Dice (Tech jobs, "Today" + "Contract" filters)
npm start -- --site=dice

# CorpToCorp (C2C jobs, OPT/STEM OPT friendly)
npm start -- --site=corptocorp

# Kforce (Contract roles)
npm start -- --site=kforce

# Randstad USA (Contract jobs)
npm start -- --site=randstadusa

# Vanguard (Financial services jobs)
npm start -- --site=vanguard
```

### Data Cleanup

The tool automatically checks for old data folders (from previous days) when you run it.

- It lists any found folders.
- Prompts you to delete them: `[cleanup] Do you want to delete these old folders? (y/N)`
- Type `y` to clean up disk space, or `n` to keep them.

### Run All Sites

```bash
npm start
```

### Advanced Options

```bash
# Re-run AI evaluation on existing session
npm start -- --site=corptocorp --session=session-2025-11-19T03-23-05-227Z

# Skip delays between keyword batches (use sparingly)
npm start -- --site=corptocorp --fast

# Override keywords for specific search
npm start -- --site=vanguard --keywords "java,python,react"

# Backfill a specific date
TEST_RUN_DATE=2025-11-14 npm start -- --site=kforce
```

## 📊 Supported Sites

| Site           | Speed          | Visa Filter  | Notes                                                  |
| -------------- | -------------- | ------------ | ------------------------------------------------------ |
| **Dice**       | ⚡⚡⚡ Fastest | OPT/STEM OPT | Bulk extraction, "Today" (robust parsing) + "Contract" |
| **CorpToCorp** | ⚡⚡⚡ Fastest | OPT/STEM OPT | C2C listings, auto-sorts by date                       |
| **Kforce**     | ⚡ Slower      | OPT/STEM OPT | Contract roles, 30s crawl-delay required               |
| **Randstad**   | ⚡⚡ Fast      | OPT/STEM OPT | Contract/Temp jobs                                     |
| **Vanguard**   | ⚡⚡ Fast      | OPT/STEM OPT | Financial services, auto-sorts newest                  |

## 🧠 How It Works

```
┌─────────────┐
│  Scraping   │ → Launch browser, search keywords, extract listings
└─────────────┘
       ↓
┌─────────────┐
│ AI Filter 1 │ → Remove irrelevant titles (Data/BI/Legacy/QA)
└─────────────┘
       ↓
┌─────────────┐
│ AI Filter 2 │ → Evaluate full job descriptions
└─────────────┘   ✓ Tech stack match (React/Node/Java/Python)
       ↓          ✓ Experience: 5 to <6 years
┌─────────────┐   ✓ Visa requirements (OPT/STEM for every site)
│   Output    │
└─────────────┘   → data/<site>/<date>/new_jobs_<date>.csv
```

### AI Filtering Rules

**Stage 1: Title Filter** (Model: `glm-4.6`)

- Removes: Data Engineer, BI/Analytics, QA/SDET, .NET, C#, Go, Legacy Tech
- Keeps: Modern web/full-stack roles

**Stage 2: Detail Evaluation** (Model: `glm-4.5-Air`)

- ✅ **Tech Stack**: React, Angular, Next.js, Node.js, Java/Spring Boot, Python/FastAPI
- ✅ **Experience**: Min <= 5 years (e.g., "3-5 years", "5+", "5 years"). Accepts parallel experience.
- ✅ **Visa**: Explicitly accepts OPT/STEM OPT, or if not mentioned.
- ❌ **Rejects**: Min > 5 years (e.g. "6+ years"), H1B/H4/USC/GC-only restrictions, non-web stacks.
- 🕒 **Posted Date**: Rejects jobs posted > 15 days ago. Requires recent update if posted > 1 day ago.

## 📂 Output Structure

```
data/
└── corptocorp.org/
    └── 11_18_2025/
        ├── new_jobs_11_18_2025.csv          # Final approved jobs
        ├── seen.json                         # Deduplication store
        └── sessions/
            └── session-2025-11-19T.../
                └── roles/
                    └── new_roles.csv         # Staged jobs (pre-AI)
```

### CSV Format

```csv
site,title,company,location,posted,url,job_id,scraped_at
corptocorp,Java Full Stack Engineer,CorpToCorp,,2025-11-18 19:12:00,https://...,10:23 PM ET
```

## 🔧 Troubleshooting

### "No sites matched the provided --site filter"

- Check that the site key is correct: `corptocorp`, `kforce`, or `randstadusa`
- Ensure `config.json` is valid JSON

### "ProcessSingleton" error

- Close any existing browser windows using the same profile
- Wait 30 seconds and try again

### No jobs found

- Check `config.json` → `search.criteria.searchKeywords`
- Verify `postedTodayOnly` setting (set to `false` for testing)
- Check if site structure changed (inspect selectors)

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/new-site`)
3. Commit your changes (`git commit -m 'feat: add new site scraper'`)
4. Push to the branch (`git push origin feature/new-site`)
5. Open a Pull Request

## 📄 License

MIT License - see LICENSE file for details

## 🙏 Acknowledgments

- [Playwright](https://playwright.dev/) for browser automation
- [TypeScript](https://www.typescriptlang.org/) for type safety
