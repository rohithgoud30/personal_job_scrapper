# System Architecture

This document explains the overall system: how the scraper service, n8n, and Telegram bot work together.

## Overview

The system is a hybrid of two processes running on your MacBook:

1. **Scraper Service** — Express HTTP API wrapping the 6 Playwright scrapers + AI filtering
2. **n8n** — Docker container handling scheduling, Telegram bot, and workflow orchestration

```
┌──────────────────────┐       HTTP (localhost)       ┌──────────────────────┐
│   n8n (Docker)       │ ◄──────────────────────────► │  Scraper Service     │
│   Port 5678          │                               │  Port 3333           │
│                      │   POST /scrape                │                      │
│  Telegram Trigger    │   GET  /scrape/:id/status     │  Express + Playwright│
│  Cron Scheduler      │   GET  /scrape/:id/results    │  + AI (DeepInfra     │
│  Workflow Logic      │   GET  /scrape/:id/stream     │    + Gemini)         │
│  Telegram Send       │   GET  /results/:site/:date   │  + Dedup + CSV       │
│                      │   GET  /status                │                      │
└──────────┬───────────┘                               └──────────────────────┘
           │                                                    │
           ▼                                                    ▼
    Telegram Bot API                                   data/ folder
           │                                           (CSV, seen.json,
           ▼                                            rejected_jobs.xlsx)
    User's Phone/Desktop
```

## Components

### Scraper Service (`src/server.ts`)

An Express server running on the host macOS (not Docker) at port 3333.

**Why on the host?** The 6 scrapers use Playwright in headful mode with persistent browser contexts. Each site has its own Chromium profile (`.playwright/<site>/`) that stores cookies and login sessions. Running headful browsers in Docker is impractical — you'd need X11 forwarding and would lose persistent contexts.

**Entry point:** `pnpm start` or `pnpm serve`

**Responsibilities:**
- Receives scrape requests via HTTP API
- Spawns background scraping sessions
- Tracks session state (running/completed/failed)
- Serves results via JSON endpoints
- Provides SSE streaming for live mode via `onJobAccepted` callback
- Serves historical results from CSV files on disk

**Session lifecycle:**
```
POST /scrape { sites: "dice" }
  → Creates session with unique ID
  → Starts runAllSites() in background
  → Returns { sessionId } immediately

GET /scrape/:id/status
  → { state: "running", jobCount: 3 }
  → { state: "completed", jobCount: 12, completedAt: "..." }

GET /scrape/:id/results
  → { jobs: [ { site, title, company, location, posted, url, ... } ] }

GET /scrape/:id/stream
  → SSE: data: {"site":"dice","title":"React Dev",...}
  → SSE: data: {"site":"dice","title":"Java Dev",...}
  → SSE: event: done, data: {"state":"completed","jobCount":12}
```

### Scrape Orchestrator (`src/lib/scrapeOrchestrator.ts`)

Extracted from the old `src/index.ts`. Manages the execution of site scrapers.

**Key functions:**
- `runAllSites(siteFilter, options)` — Runs sites sequentially, returns `OrchestratorResult` with all accepted jobs, duration, and site count
- `siteMatchesFilter(site, filter)` — Matches by key, host, or host-without-TLD
- `cleanupOldData()` — Auto-deletes data folders older than 3 days (no interactive prompt)

**The old index.ts was split into:**
- `src/lib/scrapeOrchestrator.ts` — Core logic (reusable by both server and CLI)
- `src/cli.ts` — CLI entry point (argument parsing, elapsed timer)
- `src/server.ts` — HTTP API entry point

### CLI Mode (`src/cli.ts`)

The original CLI behavior, now using the orchestrator.

**Entry point:** `pnpm cli`

```bash
pnpm cli                                    # All sites
pnpm cli -- --site=dice                     # Single site
pnpm cli -- --site=kforce --fast            # Skip batch delays
pnpm cli -- --site=corptocorp --session=... # Resume AI evaluation
pnpm cli -- --keywords "java,react"         # Override keywords
```

Includes the real-time elapsed timer in the terminal.

### n8n (Docker)

Workflow automation platform handling scheduling, Telegram bot interaction, and scrape orchestration.

**Runs in Docker with auto-restart:**
```bash
docker run -d --name n8n --restart=always \
  -p 5678:5678 \
  -v ~/n8n-data:/home/node/.n8n \
  -e GENERIC_TIMEZONE="America/New_York" \
  -e TZ="America/New_York" \
  n8nio/n8n
```

**Connects to scraper via:** `http://host.docker.internal:3333` (Docker's host access)

**4 workflows:**

| Workflow | File | Purpose |
|----------|------|---------|
| Telegram Router | `telegram-router.json` | Parses `/start`, `/live`, `/stop`, `/status` commands |
| Scraper Orchestrator | `scraper-orchestrator.json` | POST /scrape → poll status → fetch results → send Telegram |
| Scheduled Scrape | `scheduled-scrape.json` | Cron trigger (every hour at :05) → calls orchestrator |
| Live Webhook | `live-webhook.json` | Receives live job events → sends Telegram immediately |

### Telegram Bot

User interface via Telegram messaging.

**Created via @BotFather.** Token stored in `.env` as `TELEGRAM_BOT_TOKEN`.

**Commands:** `/start`, `/start <site>`, `/start <site> <date>`, `/live`, `/stop`, `/status`

## Data Flow

### Standard scrape (`/start dice`)

```
Telegram → n8n Trigger → Parse "/start dice"
  → n8n HTTP POST /scrape {sites:"dice"} → Scraper Service
  → Scraper launches Chromium, searches keywords
  → Scrapes job cards from search results
  → AI title filter (batch → DeepInfra, fallback Gemini)
  → AI detail evaluation (per job → DeepInfra, fallback Gemini)
  → Accepted jobs written to CSV + pushed via onJobAccepted
  → Session state → "completed"

n8n polls /status every 30s
  → Detects "completed"
  → Fetches /results
  → Formats each job as Telegram message card
  → Sends summary message
```

### Live mode (`/live` + `/start`)

```
User sends "/live" → n8n sets live flag
User sends "/start" → n8n POST /scrape + opens GET /stream (SSE)
  → Each accepted job fires onJobAccepted callback
  → SSE pushes job JSON to n8n instantly
  → n8n sends Telegram card immediately (no wait for completion)
User sends "/stop" → n8n closes SSE connection
```

### Historical query (`/start dice 2026-03-12`)

```
n8n parses date argument
  → GET /results/dice/2026-03-12
  → Server reads CSV files from data/dice.com/03_12_2026/
  → Returns stored job rows
  → n8n sends as Telegram messages
```

### Scheduled run (cron)

```
n8n Scheduled Scrape workflow
  → Cron fires at :05 every hour
  → Calls Scraper Orchestrator workflow
  → Same flow as /start (all sites)
```

## AI Provider System

The AI evaluation uses a dual-provider system with retry logic:

```
Provider: "both" (default)
  Attempt 1: DeepInfra (NVIDIA Nemotron)
  Attempt 2: Gemini (gemini-2.5-flash)
  Attempt 3: Gemini (gemini-2.5-flash)

Provider: "deepinfra"
  All attempts: DeepInfra only

Provider: "gemini"
  All attempts: Gemini only
```

**Title filter:** 2 retry attempts, processes jobs in batches of `TITLE_BATCH_SIZE`
**Detail evaluation:** 3 retry attempts, processes jobs one at a time

**Retry triggers:** Rate limits, HTML responses (blocking detection), network errors
**Immediate failure:** JSON parse errors (malformed AI response)

## Auto-Start

### Scraper Service (LaunchAgent)

```bash
cp com.jobscraper.service.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.jobscraper.service.plist
```

Starts `ts-node src/server.ts` at login. Logs to `/tmp/jobscraper.stdout.log`.

### n8n (Docker)

The `--restart=always` flag ensures n8n restarts when Docker Desktop starts (which auto-launches on macOS login).

## File Structure

```
src/
├── server.ts                    # Express HTTP API entry point
├── cli.ts                       # CLI entry point (original mode)
├── lib/
│   ├── scrapeOrchestrator.ts    # Site runner, cleanup, returns results
│   ├── aiEvaluator.ts           # DeepInfra + Gemini dual-provider AI
│   ├── config.ts                # config.json loader & types
│   ├── csv.ts                   # CSV read/write (JobRow)
│   ├── dedupe.ts                # seen.json deduplication
│   ├── env.ts                   # .env loader
│   ├── paths.ts                 # Output path builder
│   ├── session.ts               # Session management & resume
│   ├── time.ts                  # Eastern timezone helpers
│   ├── cookies.ts               # Cookie consent handler
│   ├── throttle.ts              # Sleep helper
│   └── rejectedLogger.ts        # Rejected jobs Excel log
├── sites/
│   ├── types.ts                 # RunOptions { onJobAccepted, ... }
│   ├── kforce/index.ts          # Returns Promise<JobRow[]>
│   ├── dice/index.ts            # Returns Promise<JobRow[]>
│   ├── corptocorp/index.ts      # Returns Promise<JobRow[]>
│   ├── randstadusa/index.ts     # Returns Promise<JobRow[]>
│   ├── vanguard/index.ts        # Returns Promise<JobRow[]>
│   └── nvoids/index.ts          # Returns Promise<JobRow[]>
n8n-workflows/
├── telegram-router.json
├── scraper-orchestrator.json
├── scheduled-scrape.json
└── live-webhook.json
```

## Key Design Decisions

1. **Hybrid over pure-n8n:** Playwright needs headful browsers with persistent contexts. Running inside Docker would break site interactions.

2. **Express over raw HTTP:** The server needs session tracking, SSE streaming, and JSON body parsing — Express handles this cleanly.

3. **onJobAccepted callback:** Threaded through all 6 scrapers. Fires after AI detail evaluation passes. Enables both SSE live streaming and in-memory result collection without changing scraper internals.

4. **3-day auto-cleanup:** Replaces the interactive readline prompt. Server mode can't prompt for input, and keeping recent data allows `/start <site> <date>` historical queries.

5. **Orchestrator extraction:** `scrapeOrchestrator.ts` is shared by both `server.ts` and `cli.ts`, avoiding code duplication. The orchestrator is transport-agnostic — it doesn't know about HTTP or terminals.

6. **Site runners return JobRow[]:** Changed from void to enable result collection. Early returns produce `[]`, successful runs return the accepted rows. No behavior change — CSV writing still happens inside each runner.
