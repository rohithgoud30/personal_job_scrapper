# Telegram Bot Setup Guide

Complete guide to creating and configuring the Telegram bot for job notifications.

## Part 1: Create the Bot

### Step 1: Talk to BotFather

1. Open **Telegram** (phone or desktop)
2. Search for **@BotFather** in the search bar
3. Start a chat with BotFather (tap "Start" if prompted)

### Step 2: Create a New Bot

Send this message to BotFather:

```
/newbot
```

BotFather responds:

```
Alright, a new bot. How are we going to call it?
Please choose a name for your bot.
```

### Step 3: Choose a Display Name

Type a friendly name (this is what appears in conversations):

```
Job Scraper Bot
```

BotFather responds:

```
Good. Now let's choose a username for your bot.
It must end in `bot`. Like this, for example: TetrisBot or tetris_bot.
```

### Step 4: Choose a Username

Type a unique username ending in `bot`:

```
rohith_jobscraper_bot
```

BotFather responds with your bot token:

```
Done! Congratulations on your new bot. You can now add a description,
about section, and profile picture for your bot.

Use this token to access the HTTP Bot API:
7123456789:AAHk5Gx-1234567890abcdefghijklmnop

You can use this token to test your bot right away.
For a description of the Bot API, see this page:
https://core.telegram.org/bots/api
```

**Copy the token** — the string that looks like `7123456789:AAHk5Gx-1234567890abcdefghijklmnop`.

### Step 5: Set Bot Commands (Optional but Recommended)

Send to BotFather:

```
/setcommands
```

Select your bot, then send:

```
start - Scrape all sites or a specific site
live - Enable live mode (jobs sent as found)
stop - Disable live mode
status - Show running sessions and health
```

This makes commands appear as suggestions when users type `/` in the chat.

---

## Part 2: Get Your Chat ID

### Step 1: Message Your Bot

1. Open Telegram
2. Search for your bot's username (e.g., `@rohith_jobscraper_bot`)
3. Start a chat with it
4. Send any message, like `hello`

### Step 2: Retrieve the Chat ID

Run this command in your terminal (replace `<TOKEN>` with your actual token):

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | python3 -m json.tool
```

Example output:

```json
{
  "ok": true,
  "result": [
    {
      "update_id": 123456789,
      "message": {
        "message_id": 1,
        "from": {
          "id": 987654321,
          "is_bot": false,
          "first_name": "Rohith",
          "language_code": "en"
        },
        "chat": {
          "id": 987654321,
          "first_name": "Rohith",
          "type": "private"
        },
        "date": 1710345600,
        "text": "hello"
      }
    }
  ]
}
```

Your chat ID is the number in `"chat": { "id": 987654321 }`.

**If the result array is empty:** Send another message to your bot, wait a few seconds, and run the curl command again.

### Quick One-Liner

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if data['result']:
    print('Chat ID:', data['result'][0]['message']['chat']['id'])
else:
    print('No messages yet. Send a message to your bot first.')
"
```

---

## Part 3: Configure the Project

### Add to `.env`

```env
TELEGRAM_BOT_TOKEN=7123456789:AAHk5Gx-1234567890abcdefghijklmnop
TELEGRAM_CHAT_ID=987654321
```

### Verify

```bash
# Test that the token works by sending yourself a message
curl -s -X POST "https://api.telegram.org/bot<TOKEN>/sendMessage" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": <CHAT_ID>, "text": "Bot is working!"}' | python3 -m json.tool
```

You should receive "Bot is working!" in your Telegram chat.

---

## Part 4: Configure n8n

### Add Telegram Credential

1. Open n8n at `http://localhost:5678`
2. Go to **Settings** (gear icon bottom-left) → **Credentials**
3. Click **Add Credential**
4. Search for **Telegram API**
5. In the **Access Token** field, paste your bot token
6. Click **Test** to verify — should show a green checkmark
7. Click **Save**

### Set Environment Variable

The n8n workflows use `$env.TELEGRAM_CHAT_ID` to know where to send messages. Set this when starting the n8n container:

```bash
docker run -d \
  --name n8n \
  --restart=always \
  -p 5678:5678 \
  -v ~/n8n-data:/home/node/.n8n \
  -e GENERIC_TIMEZONE="America/New_York" \
  -e TZ="America/New_York" \
  -e TELEGRAM_CHAT_ID="987654321" \
  n8nio/n8n
```

If n8n is already running, recreate the container:

```bash
docker stop n8n && docker rm n8n
# Then run the docker run command above
```

### Import Workflows

1. In n8n, click **Workflows** → **Import from File**
2. Import these files from the `n8n-workflows/` directory:
   - `telegram-router.json`
   - `scraper-orchestrator.json`
   - `scheduled-scrape.json`
   - `live-webhook.json`
3. In each workflow, verify the Telegram nodes have the correct credential selected
4. In **Scheduled Scrape**, update the Execute Workflow node to reference the **Scraper Orchestrator** workflow's ID
5. **Activate** each workflow (toggle in top-right corner)

---

## Part 5: Test Everything

### Test 1: Server Health

Make sure the scraper service is running:

```bash
pnpm start
```

In another terminal:

```bash
curl http://localhost:3333/status
```

Expected: `{"health":"ok","running":0,...}`

### Test 2: Telegram `/status`

Send `/status` to your bot in Telegram.

Expected response:

```
📊 Status

Running sessions: 0
Total sessions: 0
Last run: Never
Available sites: kforce, randstadusa, corptocorp, vanguard, dice, nvoids
```

### Test 3: Single Site Scrape

Send `/start dice` to your bot.

Expected:
1. Immediate acknowledgment: "Scrape started! Session: scrape-..."
2. After scraping completes (few minutes): Job cards appear one by one
3. Final summary: "Scrape complete! X jobs found."

### Test 4: Historical Query

Send `/start dice 2026-03-13` (use a date you've previously scraped).

Expected: Previously scraped results for that date, delivered as Telegram messages.

### Test 5: Live Mode

1. Send `/live` — bot responds "Live mode enabled!"
2. Send `/start corptocorp` — bot acknowledges
3. As jobs are found and pass AI evaluation, they appear immediately in the chat
4. Send `/stop` — live mode disabled

---

## Telegram Message Formats

### Job Card

```
**React Developer** | Dice
📍 Austin, TX (Remote)
📅 Posted: 03/13/2026

🔗 https://www.dice.com/job-detail/abc123
```

### Scrape Started

```
🔄 Scrape started!
Session: scrape-1710345600000-a1b2c3
Sites: dice

I'll send you the results when done.
```

### Scrape Complete

```
✅ Scrape complete!

📊 5 jobs found.
Session: scrape-1710345600000-a1b2c3
```

### Status

```
📊 Status

Running sessions: 0
Total sessions: 3
Last run: 2026-03-13T14:30:00.000Z
Available sites: kforce, randstadusa, corptocorp, vanguard, dice, nvoids
```

---

## Troubleshooting

### Bot doesn't respond to commands

1. **Check workflow is active:** In n8n, make sure the Telegram Router workflow toggle is ON (green)
2. **Check credential:** Settings → Credentials → Telegram API → click Test
3. **Check polling:** The Telegram Trigger node uses polling — it checks for new messages periodically
4. **Check n8n logs:** `docker logs n8n`

### "Session not found" errors

The scraper service must be running. n8n connects to `http://host.docker.internal:3333`.

Test connectivity from inside Docker:

```bash
docker exec n8n curl -s http://host.docker.internal:3333/status
```

If this fails, Docker's host networking may need configuration.

### Messages not arriving

- Verify `TELEGRAM_CHAT_ID` is correct (re-run the getUpdates curl)
- Check that n8n has the env variable: go to any Telegram Send node, the chatId field should show your numeric ID
- Make sure you haven't blocked the bot in Telegram

### Rate limiting

Telegram limits bots to ~30 messages per second. If you scrape many jobs at once, n8n's SplitInBatches node handles this by sending messages sequentially with a small delay.

### Multiple users

To allow other Telegram users to use the bot, you'd need to:
1. Have them send `/start` to the bot to initiate a chat
2. Get their chat ID (via getUpdates)
3. Modify the n8n workflows to support multiple chat IDs (e.g., store in a database or JSON file)

Currently the system is designed for single-user (your own chat ID).
