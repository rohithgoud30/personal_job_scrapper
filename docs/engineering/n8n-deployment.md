# n8n Deployment Guide

How to set up n8n in Docker for workflow orchestration and Telegram bot integration.

## Prerequisites

- **Docker Desktop** installed and running
- **Telegram bot token** (see [telegram-bot.md](../architecture/telegram-bot.md))
- **Scraper service** running on port 3333 (`pnpm start`)

## Step 1: Start n8n Container

```bash
# Create persistent data directory
mkdir -p ~/n8n-data

# Run n8n with auto-restart
docker run -d \
  --name n8n \
  --restart=always \
  -p 5678:5678 \
  -v ~/n8n-data:/home/node/.n8n \
  -e GENERIC_TIMEZONE="America/New_York" \
  -e TZ="America/New_York" \
  -e TELEGRAM_CHAT_ID="<your-chat-id>" \
  n8nio/n8n
```

Access n8n UI at `http://localhost:5678`. Create a local account on first visit.

## Step 2: Add Telegram Credential

1. **Settings** → **Credentials** → **Add Credential**
2. Search **Telegram API**
3. Paste your bot token
4. Click **Test** → green checkmark
5. **Save**

## Step 3: Import Workflows

Import the 4 JSON files from `n8n-workflows/`:

1. Click **Workflows** → **Import from File**
2. Import each:
   - `telegram-router.json` — Parses Telegram commands
   - `scraper-orchestrator.json` — Triggers scrape, polls, sends results
   - `scheduled-scrape.json` — Hourly cron trigger
   - `live-webhook.json` — Real-time job delivery

## Step 4: Connect Workflows

1. Open **Scheduled Scrape** workflow
2. Click the **Execute Workflow** node
3. Set **Workflow ID** to the actual ID of the **Scraper Orchestrator** workflow
4. Save

## Step 5: Activate Workflows

Toggle each workflow ON (switch in top-right corner):
- Telegram Router: **ON** (listens for Telegram messages)
- Scheduled Scrape: **ON** (cron runs hourly)
- Live Webhook: **ON** (listens for webhook calls)
- Scraper Orchestrator: Leave OFF (called by other workflows, not triggered directly)

## Step 6: Verify

1. Make sure scraper service is running: `curl http://localhost:3333/status`
2. Test Docker → host connectivity: `docker exec n8n curl -s http://host.docker.internal:3333/status`
3. Send `/status` to your Telegram bot — should get a response

## Docker Management

```bash
# View logs
docker logs n8n
docker logs -f n8n        # Follow logs

# Restart
docker restart n8n

# Stop
docker stop n8n

# Remove and recreate (data persists in ~/n8n-data)
docker rm n8n
# Re-run the docker run command above

# Update n8n
docker pull n8nio/n8n
docker stop n8n && docker rm n8n
# Re-run the docker run command above
```

## Network Notes

- n8n runs inside Docker and reaches the scraper service via `http://host.docker.internal:3333`
- This is Docker Desktop's built-in host access — no special network config needed
- The scraper service listens on `0.0.0.0:3333` (all interfaces) by default
- If using a firewall, ensure port 3333 is accessible from Docker

## Backup

n8n data (workflows, credentials, execution history) is stored in `~/n8n-data/`. Back up this directory to preserve your setup.

```bash
# Backup
cp -r ~/n8n-data ~/n8n-data-backup-$(date +%Y%m%d)

# Restore
cp -r ~/n8n-data-backup-YYYYMMDD ~/n8n-data
docker restart n8n
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| n8n can't reach scraper | Verify: `docker exec n8n curl http://host.docker.internal:3333/status` |
| Telegram bot not responding | Check Telegram Router workflow is activated (ON) |
| Workflow import fails | Ensure JSON files are valid; re-export from a working n8n instance |
| Cron not firing | Check Scheduled Scrape is activated; verify timezone settings |
| Port 5678 in use | Stop other containers: `docker ps`, or change port: `-p 5679:5678` |
