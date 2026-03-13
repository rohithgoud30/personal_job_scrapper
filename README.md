# Personal Job Scraper

A powerful, AI-powered CLI tool to scrape job listings from multiple sites, filter them intelligently, and save only the best matches.

## 🚀 Quick Start

```bash
# Clone the repository
git clone https://github.com/rohithgoud30/personal_job_scrapper.git
cd personal_job_scrapper

# Install dependencies
pnpm install
pnpm exec playwright install chromium

# Configure environment
cp .env.example .env
# Edit .env with your API keys and configuration (see Configuration section)

# Run a scraper
pnpm start -- --site=corptocorp
```

## 📋 Prerequisites

- **Node.js** v18 or higher
- **pnpm** (install via `corepack enable` or `npm i -g pnpm`)
- **Git**
- **DeepInfra API Key** (for NVIDIA models via DeepInfra)
- **Gemini API Key** (if using Gemini as provider or fallback)

## ⚙️ Configuration

All configuration is done through **environment variables** (`.env`) and the **config file** (`config.json`). No hardcoded values exist in the code.

### 1. Environment Variables (Required)

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` with **all required** settings:

```env
# DeepInfra provider (OpenAI-compatible)
AI_API_KEY=your-deepinfra-api-key
AI_BASE_URL=https://api.deepinfra.com/v1/openai
AI_MODEL=nvidia/NVIDIA-Nemotron-3-Super-120B-A12B

# Gemini provider
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-2.5-flash

# Provider mode: "deepinfra", "gemini", or "both" (deepinfra primary, gemini fallback)
AI_DEFAULT_PROVIDER=both

# Batch Size Configuration
TITLE_BATCH_SIZE=50
KEYWORD_BATCH_SIZE=5

# AI Retry Configuration (milliseconds)
AI_RETRY_DELAY_MS=5000

# Optional: Testing Override
TEST_RUN_DATE=
```

| Variable              | Description                                                     | Required |
| --------------------- | --------------------------------------------------------------- | -------- |
| `AI_API_KEY`          | DeepInfra API key                                               | ✅ Yes   |
| `AI_BASE_URL`         | DeepInfra endpoint URL                                          | ✅ Yes   |
| `AI_MODEL`            | NVIDIA model name                                               | ✅ Yes   |
| `GEMINI_API_KEY`      | Gemini API key                                                  | ✅ Yes   |
| `GEMINI_MODEL`        | Gemini model name                                               | ✅ Yes   |
| `AI_DEFAULT_PROVIDER` | `deepinfra`, `gemini`, or `both` (deepinfra primary + fallback) | ✅ Yes   |
| `TITLE_BATCH_SIZE`    | Jobs per AI title filter batch                                  | ✅ Yes   |
| `KEYWORD_BATCH_SIZE`  | Parallel keyword searches                                       | ✅ Yes   |
| `AI_RETRY_DELAY_MS`   | Retry delay in milliseconds                                     | ✅ Yes   |
| `TEST_RUN_DATE`       | Backfill date (YYYY-MM-DD)                                      | ❌ No    |

> [!IMPORTANT]
> If any required variable is missing, the app will throw a clear error:
>
> ```
> Error: Environment variable aiModel is required but not set. Please add it to your .env file.
> ```

---

### 2. Search Keywords (config.json)

Edit `config.json` → `sharedSearchKeywords` with your target job keywords:

```json
{
  "sharedSearchKeywords": [
    "full stack developer",
    "React developer",
    "Node.js engineer",
    "Java Spring Boot",
    "Python FastAPI"
    // Add your own keywords here
  ]
}
```

You can also set **per-site keywords** in each site's `search.criteria.searchKeywords` array.

---

### 3. AI Prompts (config.json)

The AI uses two prompts in `config.json` → `ai.prompts`:

| Prompt             | Purpose                                 |
| ------------------ | --------------------------------------- |
| `titleFilter`      | Stage 1: Quickly filter job titles      |
| `detailEvaluation` | Stage 2: Evaluate full job descriptions |

---

## 🎨 Personalizing AI Prompts

The default prompts are designed for a specific profile. **You should customize them for your background!**

### How to Create Your Own Prompts

1. **Copy the existing prompts** from `config.json` → `ai.prompts`
2. **Open ChatGPT** (or any AI assistant)
3. **Paste this template** along with your resume:

```
I'm using a job scraper that filters jobs using AI. I need to customize the system prompts for my profile.

Here are the current prompts being used:
---
TITLE FILTER PROMPT:
[Paste the titleFilter array content here]

DETAIL EVALUATION PROMPT:
[Paste the detailEvaluation array content here]
---

Here is my resume/background:
[Paste your resume or describe your skills, experience, and job preferences]

My requirements:
- Target roles: [e.g., "Frontend React developer", "Full stack with Node.js"]
- Experience level: [e.g., "2-4 years", "entry level"]
- Visa status: [e.g., "OPT/STEM OPT", "H1B", "US Citizen"]
- Location preferences: [e.g., "Remote only", "California or Texas"]
- Employment type: [e.g., "Contract only", "Full-time or Contract"]
- Technologies to ACCEPT: [e.g., "React, TypeScript, Node.js, Python"]
- Technologies to REJECT: [e.g., ".NET, C#, Java, legacy systems"]

Please generate customized titleFilter and detailEvaluation prompts that will filter jobs specifically for my profile. Keep the same JSON output format.
```

4. **Replace the prompts** in your `config.json` with the generated ones

### Example Customization

**For a Junior React Developer looking for remote contract roles:**

```json
{
  "ai": {
    "prompts": {
      "titleFilter": [
        "You filter job titles for a Junior/Mid-level React frontend developer.",
        "Keep: React, TypeScript, JavaScript, Next.js, frontend roles.",
        "Remove: Senior/Lead/Staff/Principal roles, backend-only, .NET, Java, Python, DevOps.",
        "Return JSON { \"remove\": [ { \"job_id\": string, \"reason\": string } ] }."
      ],
      "detailEvaluation": [
        "Evaluate if this job fits a React frontend developer with 1-3 years experience.",
        "ACCEPT: React, TypeScript, Next.js, remote/hybrid roles, 0-4 years experience.",
        "REJECT: 5+ years required, Senior titles, no React stack, on-site only outside CA.",
        "Return JSON { \"accepted\": boolean, \"reasoning\": string }."
      ]
    }
  }
}
```

> [!TIP]
> After updating prompts, run a test with one site to verify your filters work correctly:
>
> ```bash
> pnpm start -- --site=corptocorp
> ```

## 🎯 Usage

### Run Individual Sites

```bash
# Dice (Tech jobs, "Today" + "Contract" filters)
pnpm start -- --site=dice

# CorpToCorp (C2C jobs, OPT/STEM OPT friendly)
pnpm start -- --site=corptocorp

# Kforce (Contract roles)
pnpm start -- --site=kforce

# Randstad USA (Contract jobs)
pnpm start -- --site=randstadusa

# Vanguard (Financial services jobs)
pnpm start -- --site=vanguard

# Nvoids (Aggregator, "Today" filter)
pnpm start -- --site=nvoids
```

### Data Cleanup

The tool automatically checks for old data folders (from previous days) when you run it.

- It lists any found folders.
- Prompts you to delete them: `[cleanup] Do you want to delete these old folders? (y/N)`
- Type `y` to clean up disk space, or `n` to keep them.

### Run All Sites

```bash
pnpm start
```

### Advanced Options

```bash
# Re-run AI evaluation on existing session
pnpm start -- --site=corptocorp --session=session-2025-11-19T03-23-05-227Z

# Skip delays between keyword batches (use sparingly)
pnpm start -- --site=corptocorp --fast

# Override keywords for specific search
pnpm start -- --site=vanguard --keywords "java,python,react"

# Backfill a specific date
TEST_RUN_DATE=2025-11-14 pnpm start -- --site=kforce
```

## 📊 Supported Sites

| Site           | Speed          | Visa Filter  | Notes                                                  |
| -------------- | -------------- | ------------ | ------------------------------------------------------ |
| **Dice**       | ⚡⚡⚡ Fastest | OPT/STEM OPT | Bulk extraction, "Today" (robust parsing) + "Contract" |
| **CorpToCorp** | ⚡⚡⚡ Fastest | OPT/STEM OPT | C2C listings, auto-sorts by date                       |
| **Kforce**     | ⚡ Slower      | OPT/STEM OPT | Contract roles, 30s crawl-delay required               |
| **Randstad**   | ⚡⚡ Fast      | OPT/STEM OPT | Contract/Temp jobs                                     |
| **Vanguard**   | ⚡⚡ Fast      | OPT/STEM OPT | Financial services, auto-sorts newest                  |
| **Nvoids**     | ⚡⚡ Fast      | OPT/STEM OPT | Aggregator, "Today" filter (IST/EST)                   |

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

**Stage 1: Title Filter** (uses configured provider via `AI_DEFAULT_PROVIDER`)

- Removes: Data Engineer, BI/Analytics, QA/SDET, .NET, C#, Go, Legacy Tech
- Keeps: Modern web/full-stack roles
- Customize rules in `config.json` → `ai.prompts.titleFilter`

**Stage 2: Detail Evaluation** (uses configured provider, with fallback when set to `both`)

- **Fallback Logic**: When `AI_DEFAULT_PROVIDER=both`, automatically falls back from DeepInfra to Gemini on failure.
- Customize rules in `config.json` → `ai.prompts.detailEvaluation`

- ✅ **Tech Stack**: React, Angular, Next.js, Node.js, Java/Spring Boot, Python/FastAPI
- ✅ **Experience**: Min <= 5 years (e.g., "3-5 years", "5+", "5 years"). Accepts parallel experience.
- ✅ **Visa**: Explicitly accepts OPT/STEM OPT, or if not mentioned.
- ❌ **Rejects**: Min > 5 years (e.g. "6+ years"), H1B/H4/USC/GC-only restrictions, non-web stacks.

## 📂 Output Structure

```
data/
└── corptocorp.org/
    └── 11_18_2025/
        ├── new_jobs_11_18_2025.csv          # Final approved jobs
        ├── seen.json                         # Deduplication store (accepted + rejected)
        └── sessions/
            └── session-2025-11-19T.../
                └── roles/
                    └── new_roles.csv         # Staged jobs (pre-AI)
```

> [!NOTE] > **Cost Optimization**: `seen.json` stores both accepted AND rejected job IDs. This means previously rejected jobs are skipped immediately in future runs, saving AI API costs on title filtering and detail evaluation.

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
