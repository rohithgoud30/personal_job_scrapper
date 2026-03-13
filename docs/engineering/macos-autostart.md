# macOS Auto-Start Setup

How to make the scraper service and n8n start automatically when your Mac boots.

## Scraper Service (LaunchAgent)

### Install

```bash
# Copy the plist template to LaunchAgents
cp com.jobscraper.service.plist ~/Library/LaunchAgents/

# Load it (starts immediately + on every login)
launchctl load ~/Library/LaunchAgents/com.jobscraper.service.plist
```

### Verify

```bash
# Check if running
launchctl list | grep jobscraper

# Test the server
curl http://localhost:3333/status

# View logs
tail -f /tmp/jobscraper.stdout.log
tail -f /tmp/jobscraper.stderr.log
```

### Stop / Uninstall

```bash
# Stop (temporary, restarts on login)
launchctl unload ~/Library/LaunchAgents/com.jobscraper.service.plist

# Uninstall (permanent)
launchctl unload ~/Library/LaunchAgents/com.jobscraper.service.plist
rm ~/Library/LaunchAgents/com.jobscraper.service.plist
```

### Customize Paths

If your Node.js or project path differs, edit the plist before installing:

```xml
<key>ProgramArguments</key>
<array>
    <string>/usr/local/bin/node</string>          <!-- Your node path: which node -->
    <string>/path/to/cli-test/node_modules/.bin/ts-node</string>
    <string>/path/to/cli-test/src/server.ts</string>
</array>

<key>WorkingDirectory</key>
<string>/path/to/cli-test</string>
```

Find your node path: `which node`

## n8n (Docker Auto-Restart)

Docker Desktop auto-starts on macOS login by default. The n8n container uses `--restart=always`, so it starts with Docker.

### Verify Docker Auto-Start

1. Open **Docker Desktop** → **Settings** → **General**
2. Ensure **"Start Docker Desktop when you sign in"** is checked

### Verify n8n Auto-Restart

```bash
# Check the restart policy
docker inspect n8n --format '{{.HostConfig.RestartPolicy.Name}}'
# Should output: always
```

## Boot Sequence

After a Mac restart:

```
1. macOS login
   ├── Docker Desktop starts automatically
   │   └── n8n container starts (--restart=always)
   │       └── Listens on port 5678
   │       └── Telegram Router active (polling for /start, /status, etc.)
   │       └── Scheduled Scrape active (cron every hour at :05)
   │
   └── LaunchAgent starts scraper service
       └── ts-node src/server.ts
       └── Listens on port 3333
       └── Ready to receive scrape requests from n8n
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| LaunchAgent not starting | Check: `launchctl list \| grep jobscraper`, view `/tmp/jobscraper.stderr.log` |
| Wrong node version | Update the node path in the plist: `which node` |
| ts-node not found | Use full path: `/path/to/cli-test/node_modules/.bin/ts-node` |
| Docker not starting | Docker Desktop → Settings → General → enable auto-start |
| n8n not restarting | Re-run with `--restart=always`: `docker update --restart=always n8n` |
