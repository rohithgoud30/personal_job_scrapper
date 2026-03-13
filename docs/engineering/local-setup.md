# Local Development Setup

Complete guide to setting up the Job Scraper system on a new Mac.

## Prerequisites

- **macOS** (tested on 14+ Sonoma/Sequoia)
- **Node.js** v18+ (`brew install node` or use nvm)
- **pnpm** (`corepack enable` or `npm i -g pnpm`)
- **Git**
- **Docker Desktop** ([download](https://www.docker.com/products/docker-desktop/)) — for n8n

## Step 1: Clone and Install

```bash
git clone <repo-url>
cd cli-test

# Install dependencies
pnpm install

# Install Playwright's Chromium browser
pnpm exec playwright install chromium
```

## Step 2: Environment Configuration

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
# REQUIRED — AI Providers
AI_API_KEY=<your-deepinfra-key>
AI_BASE_URL=https://api.deepinfra.com/v1/openai
AI_MODEL=nvidia/NVIDIA-Nemotron-3-Super-120B-A12B
GEMINI_API_KEY=<your-gemini-key>
GEMINI_MODEL=gemini-2.5-flash
AI_DEFAULT_PROVIDER=both

# REQUIRED — Batch sizing
TITLE_BATCH_SIZE=50
KEYWORD_BATCH_SIZE=5
AI_RETRY_DELAY_MS=5000

# OPTIONAL — Server
SCRAPER_PORT=3333

# OPTIONAL — Telegram (needed for n8n integration)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

## Step 3: Verify Setup

```bash
# Type check
pnpm typecheck

# Test CLI mode with a fast single-site run
pnpm cli -- --site=corptocorp --fast
```

You should see Chromium open, navigate to corptocorp.org, search keywords, and run AI filtering.

## Step 4: Start the Server

```bash
pnpm start
```

In another terminal:

```bash
curl http://localhost:3333/status
# → {"health":"ok","running":0,"availableSites":["kforce","randstadusa",...]}
```

## Step 5: Set Up n8n (Optional)

See [n8n-deployment.md](./n8n-deployment.md) for Docker setup and workflow import.

## Step 6: Set Up Telegram (Optional)

See [docs/architecture/telegram-bot.md](../architecture/telegram-bot.md) for BotFather walkthrough.

## Project Scripts

| Script | Command | Description |
|--------|---------|-------------|
| Server mode | `pnpm start` | Express API on port 3333 |
| CLI mode | `pnpm cli` | Terminal with elapsed timer |
| CLI single site | `pnpm cli -- --site=dice` | Scrape one site |
| CLI fast mode | `pnpm cli -- --site=kforce --fast` | Skip inter-batch delays |
| Type check | `pnpm typecheck` | `tsc --noEmit` |
| Build | `pnpm build` | Compile to `dist/` |
| Smoke: Kforce | `pnpm smoke:kforce` | Kforce smoke test |
| Smoke: Randstad | `pnpm smoke:randstad` | Randstad smoke test |

## Browser Profiles

Each site gets a persistent Chromium profile at the path specified in `config.json` → `site.userDataDir`. These store cookies and login sessions.

If you get a "ProcessSingleton" error, close any Chromium windows using that profile, wait 30 seconds, and retry.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `playwright install` fails | Run `pnpm exec playwright install --with-deps chromium` |
| Missing env var error | Check `.env` has all required values from `.env.example` |
| ProcessSingleton error | Close existing Chromium windows, wait 30s |
| No jobs found | Check `config.json` keywords, verify `postedTodayOnly` setting |
| AI evaluation errors | Check API keys in `.env`, verify DeepInfra/Gemini account status |
