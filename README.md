# Personal Job Scraper

A powerful, AI-powered job scraping system that finds jobs from 6 boards, filters them with AI, and delivers results via **Telegram bot** — orchestrated by **n8n** workflows running on your Mac.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          YOUR MACBOOK                               │
│                                                                     │
│  ┌───────────────────────┐         ┌──────────────────────────┐    │
│  │   n8n (Docker)        │  HTTP   │  Scraper Service         │    │
│  │   localhost:5678      │◄───────►│  localhost:3333           │    │
│  │                       │         │                           │    │
│  │  Telegram Trigger ──┐ │  POST   │  Express API wrapping:   │    │
│  │  Cron Scheduler   ──┤ │ /scrape │  ├── 6 Playwright        │    │
│  │  Workflow Logic   ──┤ │         │  │   scrapers (headful)   │    │
│  │  Telegram Send    ──┘ │  GET    │  ├── AI evaluation        │    │
│  │                       │ /status │  │   (DeepInfra + Gemini) │    │
│  │  Runs in Docker with  │         │  ├── Deduplication        │    │
│  │  auto-restart         │  GET    │  │   (seen.json)          │    │
│  │                       │/results │  └── CSV output           │    │
│  │  Connects to scraper  │         │                           │    │
│  │  via host.docker.     │  SSE    │  Runs on host macOS       │    │
│  │  internal:3333        │/stream  │  (needs real browser)     │    │
│  └───────────┬───────────┘         └──────────────────────────┘    │
│              │                              │                       │
│              ▼                              ▼                       │
│     Telegram Bot API              data/ (CSV, seen.json)           │
│              │                                                      │
└──────────────┼──────────────────────────────────────────────────────┘
               ▼
        Your Telegram Chat
        (phone/desktop)
```

### Why This Architecture?

**Why not run everything in n8n?**
The 6 Playwright scrapers use **headful browser mode** with persistent login contexts, cookie consent flows, and complex site-specific DOM interactions. Running Playwright inside n8n's Docker container would require a custom Docker image, switching to headless mode (breaking sites that detect it), and losing persistent browser profiles. The risk/reward isn't worth it.

**Why not run everything as code?**
Scheduling, Telegram bot handling, and workflow orchestration are exactly what n8n excels at. Using n8n means you get a visual UI to monitor runs, easy Telegram integration, and cron scheduling — without writing any of that code yourself.

**The hybrid approach gives you:**
- Scraping stays on your Mac with real browsers (reliable, hard to block)
- n8n handles all the orchestration, scheduling, and Telegram messaging (visual, configurable)
- The two communicate via a simple HTTP API on localhost

### Data Flow: What Happens When You Send `/start dice`

```
1. You send "/start dice" in Telegram
                    │
2. n8n Telegram Trigger picks it up
                    │
3. n8n Code node parses: command=start, site=dice
                    │
4. n8n HTTP Request: POST http://host.docker.internal:3333/scrape
   Body: { "sites": "dice" }
                    │
5. Scraper Service receives request, returns { sessionId: "scrape-..." }
   Starts scraping in background
                    │
6. n8n sends you: "Scrape started! Session: scrape-..."
                    │
7. n8n polls GET /scrape/{id}/status every 30 seconds
                    │
8. Meanwhile, the scraper:
   a. Launches Chromium with your saved dice.com profile
   b. Searches each keyword (React, Java, Python, etc.)
   c. Extracts job cards from search results
   d. Runs AI title filter (batch call to DeepInfra)
   e. Opens each surviving job's detail page
   f. Runs AI detail evaluation (DeepInfra, fallback Gemini)
   g. Accepted jobs → CSV + onJobAccepted callback
                    │
9. Session completes → n8n detects state: "completed"
                    │
10. n8n fetches GET /scrape/{id}/results
                    │
11. n8n formats each job as a Telegram message card:
    ┌────────────────────────────────────┐
    │ **React Developer** | Dice         │
    │ 📍 Austin, TX (Remote)            │
    │ 📅 Posted: 03/13/2026             │
    │ 🔗 https://dice.com/job/...       │
    └────────────────────────────────────┘
                    │
12. n8n sends summary: "✅ Scrape complete! 5 jobs found."
```

### Data Flow: Live Mode (`/live` + `/start`)

```
1. You send "/live" → n8n enables live mode flag
2. You send "/start" → n8n starts scrape AND opens SSE stream
3. Scraper finds a job that passes AI → onJobAccepted fires
4. SSE pushes the job to n8n instantly
5. n8n sends you the job card in Telegram immediately
   (no waiting for the full scrape to finish)
6. You send "/stop" → n8n closes SSE stream
```

### Component Breakdown

| Component | Runs On | Purpose | Port |
|-----------|---------|---------|------|
| **Scraper Service** | Host macOS | Playwright scraping + AI filtering | 3333 |
| **n8n** | Docker | Scheduling, Telegram bot, orchestration | 5678 |
| **Telegram Bot** | Telegram cloud | User interface (commands + messages) | — |
| **Chromium** | Host macOS | Headful browser for 6 job sites | — |

### API Reference

| Endpoint | Method | Body | Response |
|----------|--------|------|----------|
| `/scrape` | POST | `{ sites?: "dice,kforce", date?: "2026-03-12" }` | `{ sessionId, state, sites }` |
| `/scrape/:id/status` | GET | — | `{ state, jobCount, startedAt, completedAt }` |
| `/scrape/:id/results` | GET | — | `{ jobs: JobRow[] }` |
| `/scrape/:id/stream` | GET | — | SSE stream of `JobRow` objects |
| `/results/:site/:date` | GET | — | `{ jobs: JobRow[] }` (historical CSV data) |
| `/status` | GET | — | `{ health, running, lastRunTime, availableSites }` |

---

## Telegram Bot Setup

### Step 1: Create the Bot

1. Open Telegram on your phone or desktop
2. Search for **@BotFather** and start a chat
3. Send `/newbot`
4. BotFather asks for a **display name** — type something like:
   ```
   Job Scraper Bot
   ```
5. BotFather asks for a **username** (must end in `bot`) — type something like:
   ```
   rohith_jobscraper_bot
   ```
6. BotFather replies with your **bot token**:
   ```
   Done! Congratulations on your new bot. You can now add a description...

   Use this token to access the HTTP Bot API:
   7123456789:AAHk5Gx_example_token_here

   Keep your token secure and store it safely.
   ```
7. **Copy the token** (the `7123456789:AAH...` string)

### Step 2: Get Your Chat ID

1. Open a chat with your new bot in Telegram
2. Send it any message (e.g., "hello")
3. Run this in your terminal:
   ```bash
   curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates" | python3 -m json.tool
   ```
   Replace `<YOUR_TOKEN>` with your actual token.

4. Look for `"chat": { "id": 123456789 }` in the output:
   ```json
   {
     "result": [
       {
         "message": {
           "chat": {
             "id": 123456789,
             "first_name": "Rohith",
             "type": "private"
           },
           "text": "hello"
         }
       }
     ]
   }
   ```
5. **Copy the chat id number** (e.g., `123456789`)

### Step 3: Add to `.env`

```bash
# Add these to your .env file
TELEGRAM_BOT_TOKEN=7123456789:AAHk5Gx_example_token_here
TELEGRAM_CHAT_ID=123456789
```

### Step 4: Add to n8n

1. Open n8n at `http://localhost:5678`
2. Go to **Settings** (gear icon) → **Credentials**
3. Click **Add Credential** → search for **Telegram API**
4. Paste your bot token
5. Click **Save**

### Telegram Commands

| Command | What It Does | Example |
|---------|-------------|---------|
| `/start` | Scrape all 6 sites | `/start` |
| `/start <site>` | Scrape one site | `/start dice` |
| `/start <site> <date>` | Get historical results | `/start dice 2026-03-12` |
| `/live` | Enable live mode (jobs sent as found) | `/live` then `/start` |
| `/stop` | Disable live mode | `/stop` |
| `/status` | Show running sessions and health | `/status` |

### What Messages Look Like

**Job card** (one per accepted job):
```
**React Developer** | Dice
📍 Austin, TX (Remote)
📅 Posted: 03/13/2026

🔗 https://www.dice.com/job-detail/abc123
```

**Summary** (after scrape completes):
```
✅ Scrape complete!

📊 5 jobs found.
Session: scrape-1710345600000-a1b2c3
```

**Status** (when you send `/status`):
```
📊 Status

Running sessions: 0
Total sessions: 3
Last run: 2026-03-13T14:30:00.000Z
Available sites: kforce, randstadusa, corptocorp, vanguard, dice, nvoids
```

---

## n8n Setup

### Prerequisites

- **Docker Desktop** installed on your Mac ([download](https://www.docker.com/products/docker-desktop/))

### Step 1: Start n8n

```bash
# Create persistent data directory
mkdir -p ~/n8n-data

# Run n8n (auto-restarts on reboot)
docker run -d \
  --name n8n \
  --restart=always \
  -p 5678:5678 \
  -v ~/n8n-data:/home/node/.n8n \
  -e GENERIC_TIMEZONE="America/New_York" \
  -e TZ="America/New_York" \
  -e TELEGRAM_CHAT_ID="YOUR_CHAT_ID_HERE" \
  n8nio/n8n
```

### Step 2: Access n8n UI

Open `http://localhost:5678` in your browser. Create an account (local only, no cloud needed).

### Step 3: Add Telegram Credential

1. **Settings** → **Credentials** → **Add Credential**
2. Search **Telegram API**
3. Paste your bot token from BotFather
4. Save

### Step 4: Import Workflows

Import the 4 workflow JSON files from `n8n-workflows/`:

1. In n8n UI, click **Workflows** → **Import from File**
2. Import each file:
   - `telegram-router.json` — Handles `/start`, `/live`, `/stop`, `/status` commands
   - `scraper-orchestrator.json` — Triggers scrape, polls status, sends results
   - `scheduled-scrape.json` — Hourly cron trigger (every hour at :05)
   - `live-webhook.json` — Receives live job events for immediate Telegram delivery

3. In **Scheduled Scrape** workflow, update the **Execute Workflow** node to point to the **Scraper Orchestrator** workflow ID

4. **Activate** each workflow (toggle switch in top-right)

### Step 5: Start the Scraper Service

```bash
cd /Users/rohithgoud30/personal_dev/cli-test
pnpm start
```

The server starts on port 3333. n8n connects to it via `http://host.docker.internal:3333`.

### Step 6: Test It

Send `/status` to your bot in Telegram. You should get a response showing available sites and health status.

Then try `/start dice` to run a scrape of Dice.com and get results delivered to Telegram.

---

## Quick Start

```bash
# Install dependencies
pnpm install
pnpm exec playwright install chromium

# Configure environment
cp .env.example .env
# Edit .env with your API keys, Telegram token, and chat ID

# Start the scraper service (HTTP API mode)
pnpm start

# Or run in CLI mode (original behavior, no server)
pnpm cli -- --site=corptocorp
```

## Prerequisites

- **Node.js** v18 or higher
- **pnpm** (install via `corepack enable` or `npm i -g pnpm`)
- **Docker Desktop** (for n8n)
- **DeepInfra API Key** (for NVIDIA models via DeepInfra)
- **Gemini API Key** (if using Gemini as provider or fallback)
- **Telegram** account (for bot setup)

## Configuration

### Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

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

# Scraper HTTP Server
SCRAPER_PORT=3333

# Telegram Bot (from @BotFather)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

| Variable | Description | Required |
|----------|-------------|----------|
| `AI_API_KEY` | DeepInfra API key | Yes |
| `AI_BASE_URL` | DeepInfra endpoint URL | Yes |
| `AI_MODEL` | NVIDIA model name | Yes |
| `GEMINI_API_KEY` | Gemini API key | Yes |
| `GEMINI_MODEL` | Gemini model name | Yes |
| `AI_DEFAULT_PROVIDER` | `deepinfra`, `gemini`, or `both` | Yes |
| `TITLE_BATCH_SIZE` | Jobs per AI title filter batch | Yes |
| `KEYWORD_BATCH_SIZE` | Parallel keyword searches | Yes |
| `AI_RETRY_DELAY_MS` | Retry delay in milliseconds | Yes |
| `SCRAPER_PORT` | HTTP server port | No (default: 3333) |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | For Telegram |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID | For Telegram |
| `TEST_RUN_DATE` | Backfill date (YYYY-MM-DD) | No |

### Search Keywords (config.json)

Edit `config.json` → `sharedSearchKeywords` with your target job keywords:

```json
{
  "sharedSearchKeywords": [
    "full stack developer",
    "React developer",
    "Node.js engineer",
    "Java Spring Boot",
    "Python FastAPI"
  ]
}
```

### AI Prompts (config.json)

The AI uses two prompts in `config.json` → `ai.prompts`:

| Prompt | Purpose |
|--------|---------|
| `titleFilter` | Stage 1: Quickly filter job titles in bulk |
| `detailEvaluation` | Stage 2: Evaluate full job descriptions one by one |

See the "Personalizing AI Prompts" section below for customization.

---

## Usage

### Server Mode (default — for n8n + Telegram)

```bash
# Start the HTTP API server
pnpm start
# → Listening on http://localhost:3333

# Test it
curl http://localhost:3333/status
curl -X POST http://localhost:3333/scrape -H 'Content-Type: application/json' -d '{"sites":"dice"}'
```

### CLI Mode (original behavior, no server)

```bash
# Run all sites
pnpm cli

# Run specific site
pnpm cli -- --site=dice

# Fast mode (skip delays)
pnpm cli -- --site=corptocorp --fast

# Override keywords
pnpm cli -- --site=vanguard --keywords "java,python,react"

# Resume AI evaluation on existing session
pnpm cli -- --site=corptocorp --session=session-2026-03-13T17-24-32-968Z

# Backfill a specific date
TEST_RUN_DATE=2026-03-12 pnpm cli -- --site=kforce
```

---

## Supported Sites

| Site | Speed | Visa Filter | Notes |
|------|-------|-------------|-------|
| **Dice** | Fast | OPT/STEM OPT | Bulk extraction, "Today" + "Contract" filters |
| **CorpToCorp** | Fast | OPT/STEM OPT | C2C listings, auto-sorts by date |
| **Kforce** | Slower | OPT/STEM OPT | Contract roles, 30s crawl-delay |
| **Randstad** | Fast | OPT/STEM OPT | Contract/Temp jobs |
| **Vanguard** | Fast | OPT/STEM OPT | Financial services, auto-sorts newest |
| **Nvoids** | Fast | OPT/STEM OPT | Aggregator, "Today" filter (IST/EST) |

## How It Works

```
┌──────────────┐
│   Scraping   │  Launch headful Chromium → search keywords → extract listings
└──────────────┘
       │
       ▼
┌──────────────┐
│  AI Filter 1 │  Batch title filter via DeepInfra/Gemini
│  (Title)     │  Remove: Data/BI/Legacy/QA/.NET/C# roles
└──────────────┘  Keep: React/Node/Java/Python/Full-stack
       │
       ▼
┌──────────────┐
│  AI Filter 2 │  Per-job detail evaluation
│  (Detail)    │  Check: tech stack, experience (≤5yr), visa, location
└──────────────┘
       │
       ▼
┌──────────────┐
│   Output     │  CSV file + onJobAccepted callback → Telegram
└──────────────┘
```

## Output Structure

```
data/
├── corptocorp.org/
│   └── 03_13_2026/
│       ├── new_jobs_03_13_2026.csv      # Final approved jobs
│       ├── seen.json                     # Deduplication store
│       └── sessions/
│           └── session-2026-03-13T.../
│               └── roles/
│                   └── new_roles.csv     # Staged jobs (pre-AI)
├── jobs.nvoids.com/
│   └── ...
└── rejected_jobs.xlsx                    # All rejected jobs with reasons
```

## Auto-Start on macOS

To have the scraper service start automatically on login:

```bash
# Copy the LaunchAgent plist (edit paths inside if needed)
cp com.jobscraper.service.plist ~/Library/LaunchAgents/

# Load it
launchctl load ~/Library/LaunchAgents/com.jobscraper.service.plist

# Check status
launchctl list | grep jobscraper

# Logs
tail -f /tmp/jobscraper.stdout.log
tail -f /tmp/jobscraper.stderr.log

# To stop auto-start
launchctl unload ~/Library/LaunchAgents/com.jobscraper.service.plist
```

Docker handles n8n auto-restart (`--restart=always`).

---

## Personalizing AI Prompts

The default prompts are designed for a specific profile. **Customize them for your background!**

1. Copy the existing prompts from `config.json` → `ai.prompts`
2. Open ChatGPT (or any AI assistant)
3. Paste this template along with your resume:

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

4. Replace the prompts in your `config.json` with the generated ones

After updating prompts, test with one site:
```bash
pnpm cli -- --site=corptocorp
```

## Troubleshooting

### "No sites matched the provided --site filter"
- Check that the site key is correct: `corptocorp`, `kforce`, `randstadusa`, `dice`, `vanguard`, `nvoids`
- Ensure `config.json` is valid JSON

### "ProcessSingleton" error
- Close any existing browser windows using the same profile
- Wait 30 seconds and try again

### n8n can't reach scraper
- Make sure the scraper service is running (`pnpm start`)
- Verify Docker can reach host: `docker exec n8n curl http://host.docker.internal:3333/status`

### Telegram bot not responding
- Check the bot token is correct in n8n credentials
- Make sure the Telegram Router workflow is **activated** in n8n
- Verify your chat ID is correct: send a message to the bot, then check `/getUpdates`

### No jobs found
- Check `config.json` → `search.criteria.searchKeywords`
- Verify `postedTodayOnly` setting (set to `false` for testing)
- Check if site structure changed (inspect selectors)

## File Structure

```
src/
├── server.ts                    # Express HTTP API (main entry point)
├── cli.ts                       # CLI entry point (original mode)
├── lib/
│   ├── scrapeOrchestrator.ts    # Runs sites, auto-cleanup, returns results
│   ├── aiEvaluator.ts           # DeepInfra + Gemini AI filtering
│   ├── config.ts                # config.json loader
│   ├── csv.ts                   # CSV read/write
│   ├── dedupe.ts                # seen.json deduplication
│   ├── env.ts                   # .env variable loader
│   ├── paths.ts                 # Output path builder
│   ├── session.ts               # Session management
│   ├── time.ts                  # Eastern timezone helpers
│   ├── cookies.ts               # Cookie consent handler
│   ├── throttle.ts              # Sleep helper
│   └── rejectedLogger.ts        # Rejected jobs Excel log
├── sites/
│   ├── types.ts                 # RunOptions (with onJobAccepted)
│   ├── kforce/index.ts
│   ├── dice/index.ts
│   ├── corptocorp/index.ts
│   ├── randstadusa/index.ts
│   ├── vanguard/index.ts
│   └── nvoids/index.ts
n8n-workflows/
├── telegram-router.json         # Telegram command handler
├── scraper-orchestrator.json    # Scrape + poll + send results
├── scheduled-scrape.json        # Hourly cron trigger
└── live-webhook.json            # Live mode job delivery
```

## License

MIT License - see LICENSE file for details
