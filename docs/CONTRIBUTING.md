# Contributing Guide

Conventions, code patterns, and rules for working on the Job Scraper codebase.

---

## 1. Project Structure Rules

### Entry Points

| File | Purpose | Launch |
|------|---------|--------|
| `src/server.ts` | Express HTTP API (default) | `pnpm start` |
| `src/cli.ts` | Terminal CLI mode | `pnpm cli` |
| `src/lib/scrapeOrchestrator.ts` | Shared orchestration (used by both) | Imported, not run directly |

**Rule:** Never import from `server.ts` or `cli.ts` into library code. These are leaf entry points only.

### Module Boundaries

```
src/server.ts ──────► src/lib/scrapeOrchestrator.ts ──► src/sites/*/index.ts
src/cli.ts    ──────►                                  │
                                                        ▼
                                                  src/lib/*.ts (shared)
```

- **Sites** may import from `src/lib/*` (config, csv, dedupe, env, paths, etc.)
- **Sites** must NOT import from other sites
- **Library modules** (`src/lib/*`) must NOT import from `src/sites/*`
- **Orchestrator** imports site runners and lib modules

### Adding New Files

- New library utilities go in `src/lib/`
- New site scrapers go in `src/sites/<site-key>/index.ts`
- New docs go in `docs/architecture/` (per-site) or `docs/engineering/` (setup/ops)

---

## 2. Code Conventions

### TypeScript

- **Strict mode** is enabled in `tsconfig.json`
- All functions must have explicit return types
- Use `interface` for object shapes, `type` for unions/aliases
- No `any` — use `unknown` and narrow with type guards

### Naming

| Thing | Convention | Example |
|-------|-----------|---------|
| Files | camelCase | `scrapeOrchestrator.ts` |
| Site dirs | lowercase | `src/sites/corptocorp/` |
| Functions | camelCase | `runKforceSite()` |
| Interfaces | PascalCase | `RunOptions`, `JobRow` |
| Constants | UPPER_SNAKE | `RETENTION_DAYS`, `CSV_HEADERS` |
| Env vars | UPPER_SNAKE | `AI_API_KEY`, `SCRAPER_PORT` |
| Config keys | camelCase | `searchKeywords`, `postedTodayOnly` |
| CSS selectors | Quoted strings in config | `"input[type='search']"` |

### Error Handling

- Use try/catch in site scrapers — a single keyword failure shouldn't crash the run
- Log errors with `console.error` and site prefix: `[kforce] Failed keyword "react"`
- Always close browser contexts in `finally` blocks
- AI calls use retry with provider fallback, not try/catch loops

### Logging

All console output uses a consistent prefix pattern:

```
[site]              General site messages
[site][keyword]     Keyword-specific messages
[site][AI]          AI evaluation messages
[site][AI][Title Reject #N]  Title rejection details
[server]            HTTP server messages
[runner]            Orchestrator messages
[cleanup]           Data cleanup messages
```

---

## 3. Site Scraper Patterns

### Required Exports

Every site scraper at `src/sites/<key>/index.ts` must export:

```typescript
export async function run<Site>Site(
  site: SiteConfig,
  output: OutputConfig,
  options: RunOptions = {}
): Promise<JobRow[]> { ... }
```

### Required Behaviors

1. **Return `JobRow[]`** — accepted jobs from this run (or `[]` for early exits)
2. **Thread `onJobAccepted`** — pass `options.onJobAccepted` to `evaluateDetailedJobs()`
3. **Call `onJobAccepted?.(role)`** — after `accepted.push(role)` in detail evaluation
4. **Use persistent context** — `chromium.launchPersistentContext(userDataDir, { headless: false })`
5. **Close context in `finally`** — browser must not leak
6. **Write CSV** — `appendJobRows(outputPaths.csvFile, acceptedRows)`
7. **Save seen store** — `saveSeenStore(outputPaths.seenFile, seen)` after processing
8. **Log rejected jobs** — `rejectedLogger.log(...)` for both title and detail rejections
9. **Support resume** — check `options.resumeSessionId`, skip scraping if provided

### Internal Function Pattern

All scrapers follow this internal structure:

```
runXxxSite()
  ├── Setup (paths, session, seen store, browser context)
  ├── scrapeKeywordsInBatches()  → staged Map
  ├── filterTitlesWithAi()       → removal set
  ├── evaluateDetailedJobs()     → accepted JobRow[]
  └── Output (CSV, seen store, return)
```

### Adding a New Site

1. Create `src/sites/<key>/index.ts` following the pattern above
2. Add the site to `config.json` with selectors, keywords, and run settings
3. Register in `src/lib/scrapeOrchestrator.ts` → `runSite()` switch statement
4. Create `docs/architecture/<key>.md` documenting site-specific behavior
5. The HTTP API auto-discovers new sites via `getAvailableSiteKeys()`

---

## 4. Configuration Patterns

### Adding an Environment Variable

1. Add to `.env.example` with a comment
2. Add to `src/lib/env.ts` → `env` object
3. If required, add to `requireEnv()` union type
4. Document in README.md env vars table

### Adding a Config Option

1. Add to `config.json` under the appropriate site or global section
2. Add TypeScript type to `src/lib/config.ts`
3. Access via `loadConfig()` — never read config.json directly

### Selectors

- All DOM selectors live in `config.json` → `site.search.selectors`
- Code references selectors by key, never hardcodes DOM queries
- Fallback selectors are defined in the site scraper code (not config)

---

## 5. AI Prompt Changes

### Title Filter Prompt

Located in `config.json` → `ai.prompts.titleFilter` (array of strings joined as system prompt).

**Output contract:**
```json
{ "remove": [ { "job_id": "string", "reason": "string" } ] }
```

### Detail Evaluation Prompt

Located in `config.json` → `ai.prompts.detailEvaluation` (array of strings joined as system prompt).

**Output contract:**
```json
{ "accepted": true/false, "reasoning": "string" }
```

**Rules for modifying prompts:**
- Test with a single site first: `pnpm cli -- --site=corptocorp`
- Check `data/rejected_jobs.xlsx` to verify rejection reasons make sense
- Use `--session` to re-run AI on existing data without re-scraping

---

## 6. n8n Workflow Changes

### Editing Workflows

1. Make changes in the n8n UI at `http://localhost:5678`
2. Test the workflow
3. Export as JSON: Workflow menu → Export → Download
4. Save to `n8n-workflows/<name>.json`
5. Commit the updated JSON

### Workflow Conventions

- All HTTP requests use `http://host.docker.internal:3333` (Docker host access)
- Telegram messages use `$env.TELEGRAM_CHAT_ID` for the recipient
- Job cards use Markdown formatting with bold title and emoji prefixes
- Poll intervals: 30 seconds for status checks

---

## 7. Testing

### Smoke Tests

```bash
pnpm smoke:kforce    # Test Kforce scraper basics
pnpm smoke:randstad  # Test Randstad scraper basics
```

### Manual Testing

```bash
# Test server endpoints
curl http://localhost:3333/status
curl -X POST http://localhost:3333/scrape -H 'Content-Type: application/json' -d '{"sites":"dice"}'

# Test CLI mode
pnpm cli -- --site=corptocorp --fast

# Test AI re-evaluation
pnpm cli -- --site=kforce --session=<session-id>
```

### Type Checking

```bash
pnpm typecheck    # tsc --noEmit
```

---

## 8. Git Conventions

### Branch Naming

```
feature/<description>    # New features
fix/<description>        # Bug fixes
docs/<description>       # Documentation only
refactor/<description>   # Code restructuring
```

### Commit Messages

```
feat: add Telegram live mode SSE streaming
fix: handle empty search results in dice scraper
refactor: extract scrapeOrchestrator from index.ts
docs: update architecture docs for n8n migration
```

### What Not to Commit

- `.env` (secrets)
- `data/` (scraped output)
- `.playwright/` (browser profiles with cookies)
- `node_modules/`
- `dist/` (build output)

---

## 9. Documentation

### When to Write Docs

- **New site scraper** → `docs/architecture/<site>.md`
- **New infrastructure/tool** → `docs/engineering/<topic>.md`
- **Architecture change** → update `docs/SYSTEM_OVERVIEW.md`
- **New convention** → update this file (`docs/CONTRIBUTING.md`)

### Doc Structure

Architecture docs follow this template:

```markdown
# <Site/Component> Architecture

## 1. Configuration & Environment
## 2. Execution Workflow
## 3. Data Extraction Details
## 4. AI Evaluation
## 5. Output & Deduplication
## 6. Session Resume
## 7. Hybrid Architecture (server + n8n)
```

Engineering docs follow this template:

```markdown
# <Topic>

## Prerequisites
## Step-by-Step Setup
## Configuration
## Verification
## Troubleshooting
```
