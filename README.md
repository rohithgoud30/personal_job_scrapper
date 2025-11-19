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
ZAI_API_KEY=your-z-ai-key
ZAI_BASE_URL=https://api.z.ai/api/coding/paas/v4
KEYWORD_BATCH_SIZE=5
TEST_RUN_DATE=
```

| Variable             | Description                                                  | Required           |
| -------------------- | ------------------------------------------------------------ | ------------------ |
| `ZAI_API_KEY`        | Your Zhipu AI API key for job filtering                      | ✅ Yes             |
| `ZAI_BASE_URL`       | API endpoint (default shown above)                           | ❌ No              |
| `KEYWORD_BATCH_SIZE` | Number of parallel keyword searches                          | ❌ No (default: 5) |
| `TEST_RUN_DATE`      | Backfill date (YYYY-MM-DD format, leave empty for live runs) | ❌ No              |

### 2. Site Configuration

All site-specific settings are in `config.json`:

- Search keywords
- CSS selectors
- Crawl delays
- AI filtering rules

## 🎯 Usage

### Run Individual Sites

```bash
# CorpToCorp (C2C jobs, OPT/STEM OPT friendly)
npm start -- --site=corptocorp

# Kforce (Contract roles)
npm start -- --site=kforce

# Randstad USA (Contract jobs)
npm start -- --site=randstadusa
```

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

# Backfill a specific date
TEST_RUN_DATE=2025-11-14 npm start -- --site=kforce
```

## 📊 Supported Sites

| Site           | Speed          | Visa Filter  | Notes                                    |
| -------------- | -------------- | ------------ | ---------------------------------------- |
| **CorpToCorp** | ⚡⚡⚡ Fastest | OPT/STEM OPT | C2C listings, auto-sorts by date         |
| **Kforce**     | ⚡ Slower      | Standard     | Contract roles, 30s crawl-delay required |
| **Randstad**   | ⚡⚡ Fast      | Standard     | Contract/Temp jobs                       |

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
┌─────────────┐   ✓ Visa requirements (OPT/STEM for CorpToCorp)
│   Output    │
└─────────────┘   → data/<site>/<date>/new_jobs_<date>.csv
```

### AI Filtering Rules

**Stage 1: Title Filter** (Model: `glm-4.6`)

- Removes: Data Engineer, BI/Analytics, QA/SDET, .NET, C#, Go, Legacy Tech
- Keeps: Modern web/full-stack roles

**Stage 2: Detail Evaluation** (Model: `glm-4.5-Air`)

- ✅ **Tech Stack**: React, Angular, Next.js, Node.js, Java/Spring Boot, Python/FastAPI
- ✅ **Experience**: 5 to <6 years (e.g., "5 years", "1-5 years", "5+")
- ✅ **Visa** (CorpToCorp): OPT, STEM OPT, or no restrictions
- ❌ **Rejects**: 6+ years, H1B/USC-only, non-web stacks

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

## 📖 Documentation

Detailed architecture and logic for each scraper:

- 📘 [CorpToCorp Architecture](docs/architecture/corptocorp.md)
- 📗 [Kforce Architecture](docs/architecture/kforce.md)
- 📙 [Randstad Architecture](docs/architecture/randstadusa.md)

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
- [Zhipu AI](https://open.bigmodel.cn/) for intelligent job filtering
- [TypeScript](https://www.typescriptlang.org/) for type safety
