# System Overview

Complete technical overview of the Job Scraper system — architecture, runtime topology, data flows, and cross-cutting concerns.

---

## 1. Runtime Topology

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            YOUR MACBOOK                                │
│                                                                        │
│  ┌────────────────────────┐           ┌─────────────────────────────┐  │
│  │   n8n (Docker)         │   HTTP    │   Scraper Service           │  │
│  │   Port 5678            │◄─────────►│   Port 3333                 │  │
│  │                        │           │                              │  │
│  │  ┌─────────────────┐   │  POST    │  ┌─────────────────────────┐ │  │
│  │  │ Telegram Trigger │   │ /scrape  │  │ Express HTTP API        │ │  │
│  │  │ Cron Scheduler   │   │          │  │ (src/server.ts)         │ │  │
│  │  │ Workflow Engine  │   │  GET     │  ├─────────────────────────┤ │  │
│  │  │ Telegram Send    │   │ /status  │  │ Scrape Orchestrator     │ │  │
│  │  └─────────────────┘   │          │  │ (scrapeOrchestrator.ts) │ │  │
│  │                        │  GET     │  ├─────────────────────────┤ │  │
│  │  4 workflows:          │ /results │  │ 6 Playwright Scrapers   │ │  │
│  │  • Telegram Router     │          │  │ (headful Chromium)       │ │  │
│  │  • Scraper Orchestrator│  SSE     │  ├─────────────────────────┤ │  │
│  │  • Scheduled Scrape    │ /stream  │  │ AI Evaluation           │ │  │
│  │  • Live Webhook        │          │  │ (DeepInfra + Gemini)    │ │  │
│  │                        │          │  ├─────────────────────────┤ │  │
│  │  Connects via:         │          │  │ Dedup + CSV + Rejected  │ │  │
│  │  host.docker.internal  │          │  │ Logger                  │ │  │
│  └────────────┬───────────┘          └─────────────────────────────┘  │
│               │                               │                       │
│               ▼                               ▼                       │
│        Telegram Bot API             data/ folder                      │
│               │                     ├── <site>/<date>/                │
│               ▼                     │   ├── new_jobs.csv              │
│        User's Phone                 │   ├── seen.json                 │
│                                     │   └── sessions/                 │
│                                     └── rejected_jobs.xlsx            │
└─────────────────────────────────────────────────────────────────────────┘

External APIs:
  ├── DeepInfra (api.deepinfra.com) — NVIDIA Nemotron model
  ├── Gemini (generativelanguage.googleapis.com) — Fallback AI
  └── 6 Job Board Websites (Playwright browser automation)
```

---

## 2. Components

### 2.1 Scraper Service

| Property | Value |
|----------|-------|
| Entry point | `src/server.ts` |
| Framework | Express 5 |
| Port | 3333 (configurable via `SCRAPER_PORT`) |
| Launch | `pnpm start` or `pnpm serve` |
| Process | Host macOS (not Docker) |

**Why on host?** Playwright requires headful Chromium with persistent browser profiles (`.playwright/<site>/`). Docker can't provide this without X11 and loses login cookies between restarts.

**Responsibilities:**
- HTTP API for triggering scrapes and querying results
- Session lifecycle management (running → completed/failed)
- SSE streaming for live mode (`onJobAccepted` callback)
- Historical result retrieval from CSV files

### 2.2 Scrape Orchestrator

| Property | Value |
|----------|-------|
| File | `src/lib/scrapeOrchestrator.ts` |
| Used by | `server.ts`, `cli.ts` |

**Responsibilities:**
- Runs site scrapers sequentially
- Auto-cleanup of data folders older than 3 days
- Returns `OrchestratorResult` with all accepted jobs
- Transport-agnostic (doesn't know about HTTP or terminals)

### 2.3 Site Scrapers (×6)

| Site | File | Speed | Key Feature |
|------|------|-------|-------------|
| Kforce | `src/sites/kforce/index.ts` | Slower | 30s crawl-delay, facet filters |
| Dice | `src/sites/dice/index.ts` | Fast | Bulk DOM extraction, C2C validation |
| CorpToCorp | `src/sites/corptocorp/index.ts` | Fast | DataTables, modal dismissal |
| Randstad | `src/sites/randstadusa/index.ts` | Fast | `__ROUTE_DATA__` extraction, contract filter |
| Vanguard | `src/sites/vanguard/index.ts` | Fast | Fusion tabs, select sort |
| Nvoids | `src/sites/nvoids/index.ts` | Fast | Ad blocking, email filter, IST/EST dates |

**Common pipeline (all sites):**
```
Scrape keywords in parallel batches
  → Deduplicate against seen.json
  → AI title filter (batch, DeepInfra/Gemini)
  → AI detail evaluation (per-job, DeepInfra/Gemini)
  → Write to CSV + fire onJobAccepted callback
  → Return JobRow[]
```

### 2.4 AI Evaluation System

| Property | Value |
|----------|-------|
| File | `src/lib/aiEvaluator.ts` |
| Primary | DeepInfra (NVIDIA Nemotron via OpenAI-compatible API) |
| Fallback | Gemini (google/genai SDK) |
| Mode | `AI_DEFAULT_PROVIDER=both` → primary + fallback |

**Two stages:**
1. **Title Filter** — Batch of job titles → AI returns IDs to remove (wrong stack, wrong level, wrong location)
2. **Detail Evaluation** — Full job description → AI returns `{ accepted: boolean, reasoning: string }`

**Retry sequence (mode=both):** DeepInfra → Gemini → Gemini

### 2.5 n8n Workflows

| Workflow | File | Trigger | Purpose |
|----------|------|---------|---------|
| Telegram Router | `telegram-router.json` | Telegram message | Parses commands, routes to handlers |
| Scraper Orchestrator | `scraper-orchestrator.json` | Execute Workflow | POST /scrape → poll → fetch → send |
| Scheduled Scrape | `scheduled-scrape.json` | Cron (hourly :05) | Automated periodic scraping |
| Live Webhook | `live-webhook.json` | Webhook POST | Real-time job delivery to Telegram |

### 2.6 CLI Mode

| Property | Value |
|----------|-------|
| Entry point | `src/cli.ts` |
| Launch | `pnpm cli` |

Original terminal-based interface with elapsed timer. Uses the same orchestrator as the server.

---

## 3. Data Flow Diagrams

### 3.1 Telegram `/start dice` → Job Cards

```
User: /start dice
  │
  ▼
n8n Telegram Trigger
  │ Parse command
  ▼
n8n HTTP Request: POST /scrape { sites: "dice" }
  │
  ▼
server.ts creates session, returns { sessionId }
  │ Background: runAllSites()
  ▼
dice/index.ts:
  │ Launch Chromium → search keywords
  │ Extract job cards from DOM
  │ Deduplicate against seen.json
  ▼
aiEvaluator.ts (title filter):
  │ Batch POST to DeepInfra
  │ Remove irrelevant titles
  ▼
aiEvaluator.ts (detail eval):
  │ Per-job POST to DeepInfra (fallback: Gemini)
  │ Accept/reject with reasoning
  ▼
Accepted jobs:
  ├── appendJobRows() → CSV file
  ├── seen.add() → dedup store
  └── onJobAccepted(job) → session.jobs[] + SSE listeners
  │
  ▼
n8n polls GET /scrape/:id/status (every 30s)
  │ Detects state: "completed"
  ▼
n8n fetches GET /scrape/:id/results
  │ Formats each job as Telegram card
  ▼
Telegram: job cards + summary message
```

### 3.2 Live Mode (SSE)

```
User: /live → n8n sets live flag
User: /start → n8n POST /scrape + GET /stream (SSE)

Each accepted job:
  onJobAccepted(job)
    → session.listeners.forEach(cb => cb(job))
    → SSE: data: { title, site, url, ... }
    → n8n receives event
    → Telegram: sends job card immediately

User: /stop → n8n closes SSE
```

### 3.3 Historical Query

```
User: /start dice 2026-03-12
  │
  ▼
n8n: GET /results/dice/2026-03-12
  │
  ▼
server.ts reads data/dice.com/03_12_2026/*.csv
  │
  ▼
Returns stored JobRow[] → n8n → Telegram cards
```

---

## 4. Cross-Cutting Concerns

### 4.1 Configuration

| Source | Scope | Examples |
|--------|-------|---------|
| `.env` | Secrets, API keys | AI_API_KEY, TELEGRAM_BOT_TOKEN |
| `config.json` | Site selectors, keywords, AI prompts | search.selectors, sharedSearchKeywords |
| `src/lib/env.ts` | Runtime env access | `env.scraperPort`, `env.aiModel` |
| `src/lib/config.ts` | Config file loader | `loadConfig()` → typed ConfigFile |

### 4.2 Deduplication

**File:** `src/lib/dedupe.ts`
**Storage:** `data/<site>/<date>/seen.json` — Set of job keys (job_id or SHA1 hash)
**Scope:** Per-site, per-date
**Includes:** Both accepted AND rejected jobs (saves AI costs on re-runs)

### 4.3 Session Management

**File:** `src/lib/session.ts`
**Path:** `data/<site>/<date>/sessions/<session-id>/roles/new_roles.csv`
**Purpose:** Resume AI evaluation on previously scraped data without re-scraping
**Resume:** `pnpm cli -- --site=kforce --session=session-2026-03-13T17-24-32-968Z`

### 4.4 Rejected Jobs Log

**File:** `src/lib/rejectedLogger.ts`
**Output:** `data/rejected_jobs.xlsx`
**Format:** Excel workbook with sheets per site/stage (e.g., "Kforce - Title", "Dice - Detail")
**Fields:** title, url, JD text, rejection reason, timestamp

### 4.5 Timezone Handling

**File:** `src/lib/time.ts`
**Zone:** America/New_York (Eastern)
**Usage:** All dates, folder names (MM_DD_YYYY), scraped_at timestamps
**Exception:** Nvoids uses IST/EST dual-check for posted dates

### 4.6 Data Retention

**Policy:** Auto-delete folders older than 3 days
**Implementation:** `cleanupOldData()` in `scrapeOrchestrator.ts`
**Trigger:** Runs before each scrape session
**Purpose:** Keep recent data for historical queries, prevent disk bloat

---

## 5. API Reference

### Scraper Service (Port 3333)

| Endpoint | Method | Request | Response |
|----------|--------|---------|----------|
| `/scrape` | POST | `{ sites?: "dice,kforce", date?: "2026-03-12" }` | `{ sessionId, state, sites }` |
| `/scrape/:id/status` | GET | — | `{ id, state, jobCount, startedAt, completedAt, error }` |
| `/scrape/:id/results` | GET | — | `{ id, state, jobCount, jobs: JobRow[] }` |
| `/scrape/:id/stream` | GET | — | SSE stream: `data: JobRow` per accepted job |
| `/results/:site/:date` | GET | — | `{ site, date, jobCount, jobs: JobRow[] }` |
| `/status` | GET | — | `{ health, running, runningSessions, totalSessions, lastRunTime, availableSites }` |

### JobRow Schema

```typescript
interface JobRow {
  site: string;        // "kforce", "dice", etc.
  title: string;       // "React Developer"
  company: string;     // "Kforce", "Randstad", etc.
  location: string;    // "Austin, TX (Remote)"
  posted: string;      // "03/13/2026" or "Today"
  url: string;         // Full job URL
  job_id?: string;     // Site-specific ID
  scraped_at: string;  // "2:30 PM ET"
}
```

---

## 6. Technology Stack

| Category | Technology | Purpose |
|----------|-----------|---------|
| Runtime | Node.js 18+ | Server runtime |
| Language | TypeScript 5.9 (strict) | Type safety |
| Package Manager | pnpm 10 | Fast, disk-efficient |
| HTTP Server | Express 5 | API endpoints |
| Browser Automation | Playwright 1.58 | Headful Chromium scraping |
| AI (Primary) | DeepInfra + NVIDIA Nemotron | Job title/detail evaluation |
| AI (Fallback) | Google Gemini 2.5 Flash | Fallback when DeepInfra fails |
| AI Client | OpenAI SDK (DeepInfra), @google/genai (Gemini) | API clients |
| CSV | @fast-csv/format, @fast-csv/parse | Read/write CSV files |
| Excel | xlsx | Rejected jobs workbook |
| Workflow | n8n (Docker) | Scheduling, Telegram, orchestration |
| Messaging | Telegram Bot API | Job delivery to user |
| Env | dotenv | Environment variable loading |

---

## 7. File Structure

```
src/
├── server.ts                    # Express HTTP API (default entry point)
├── cli.ts                       # CLI entry point (terminal mode)
├── lib/
│   ├── scrapeOrchestrator.ts    # Runs sites, cleanup, returns results
│   ├── aiEvaluator.ts           # Dual-provider AI (DeepInfra + Gemini)
│   ├── config.ts                # config.json loader with TypeScript types
│   ├── csv.ts                   # CSV read/write (JobRow interface)
│   ├── dedupe.ts                # seen.json deduplication (SHA1 keys)
│   ├── env.ts                   # .env loader (all env vars)
│   ├── paths.ts                 # Output path builder (date folders)
│   ├── session.ts               # Session management & resume
│   ├── time.ts                  # Eastern timezone helpers
│   ├── cookies.ts               # Cookie consent auto-accept
│   ├── throttle.ts              # sleep() helper
│   └── rejectedLogger.ts        # Rejected jobs Excel logger
├── sites/
│   ├── types.ts                 # RunOptions { onJobAccepted, ... }
│   ├── kforce/index.ts          # → Promise<JobRow[]>
│   ├── dice/index.ts            # → Promise<JobRow[]>
│   ├── corptocorp/index.ts      # → Promise<JobRow[]>
│   ├── randstadusa/index.ts     # → Promise<JobRow[]>
│   ├── vanguard/index.ts        # → Promise<JobRow[]>
│   └── nvoids/index.ts          # → Promise<JobRow[]>
└── smoke/                       # Smoke tests

config.json                      # Site configs, keywords, AI prompts
n8n-workflows/                   # 4 exportable workflow JSONs
com.jobscraper.service.plist     # macOS LaunchAgent template
docs/
├── SYSTEM_OVERVIEW.md           # ← You are here
├── CONTRIBUTING.md              # Conventions and code patterns
├── architecture/                # Per-site and system architecture
│   ├── system.md
│   ├── telegram-bot.md
│   ├── kforce.md, dice.md, corptocorp.md
│   ├── randstadusa.md, vanguard.md, nvoids.md
└── engineering/                 # Setup and deployment guides
    ├── local-setup.md
    ├── n8n-deployment.md
    ├── macos-autostart.md
    ├── ai-provider-setup.md
    └── adding-new-sites.md
```

---

## 8. Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Hybrid architecture** | Playwright needs real browsers; n8n excels at orchestration |
| **Express server** | Session tracking, SSE streaming, JSON APIs |
| **onJobAccepted callback** | Decouples live streaming from scraper internals |
| **3-day auto-cleanup** | Server can't prompt; keeps history for `/start <site> <date>` |
| **Dual AI provider** | DeepInfra is fast/cheap; Gemini is reliable fallback |
| **Per-site seen.json** | Independent dedup; won't lose data if one site breaks |
| **Sequential site runs** | Avoids browser profile conflicts |
| **Orchestrator extraction** | Shared by server.ts and cli.ts; no code duplication |
| **Site runners return JobRow[]** | Enables result collection without changing internal CSV writes |

---

## 9. Performance Notes

| Operation | Duration | Notes |
|-----------|----------|-------|
| Single site scrape | 2–15 min | Depends on keywords and page count |
| All 6 sites | 15–60 min | Sequential, varies by job volume |
| AI title filter | 2–10s per batch | 50 jobs per batch |
| AI detail eval | 3–8s per job | Includes page load + API call |
| Keyword batch | 5 keywords parallel | Limited by `KEYWORD_BATCH_SIZE` |
| Inter-batch delay | 25–30s | Robots.txt crawl-delay compliance |

---

## 10. Security Considerations

| Concern | Mitigation |
|---------|-----------|
| API keys in `.env` | `.env` in `.gitignore`, never committed |
| Telegram bot token | Stored in `.env` + n8n credentials (encrypted) |
| Browser profiles | Local `.playwright/` dirs, contain session cookies |
| No auth on scraper API | Localhost-only (port 3333 not exposed externally) |
| AI prompt injection | Fixed system prompts in config.json; user input is job data only |
