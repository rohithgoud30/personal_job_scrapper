import express, { Request, Response, Router } from "express";
import fs from "fs";
import path from "path";
import { env } from "./lib/env";
import { JobRow, readJobRows } from "./lib/csv";
import {
  runAllSites,
  getAvailableSiteKeys,
  siteMatchesFilter,
  OrchestratorResult,
} from "./lib/scrapeOrchestrator";
import { RunOptions } from "./sites/types";
import { loadConfig } from "./lib/config";
import { buildOutputPaths } from "./lib/paths";
import { getEasternDateParts } from "./lib/time";

/* ------------------------------------------------------------------ */
/*  Session tracking                                                   */
/* ------------------------------------------------------------------ */

type SessionState = "running" | "completed" | "failed";

interface ScrapeSession {
  id: string;
  state: SessionState;
  sites: string[];
  date?: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  jobs: JobRow[];
  /** SSE listeners waiting for live updates */
  listeners: Set<(job: JobRow) => void>;
}

const sessions = new Map<string, ScrapeSession>();
let lastRunTime: string | null = null;

function generateSessionId(): string {
  return `scrape-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ------------------------------------------------------------------ */
/*  Express app                                                        */
/* ------------------------------------------------------------------ */

const app = express();
app.use(express.json());

/* ---------- POST /scrape ----------------------------------------- */
app.post("/scrape", (req: Request, res: Response) => {
  const { sites, date } = req.body as { sites?: string; date?: string };
  const sessionId = generateSessionId();

  const siteFilter = sites
    ? new Set(
        sites
          .split(",")
          .map((s: string) => s.trim().toLowerCase())
          .filter(Boolean)
      )
    : undefined;

  const session: ScrapeSession = {
    id: sessionId,
    state: "running",
    sites: siteFilter ? [...siteFilter] : getAvailableSiteKeys(),
    date,
    startedAt: new Date().toISOString(),
    jobs: [],
    listeners: new Set(),
  };
  sessions.set(sessionId, session);

  // If a specific date is requested, set the env override for historical mode
  if (date) {
    process.env.TEST_RUN_DATE = date;
  }

  const options: RunOptions = {
    skipBatchPause: false,
    onJobAccepted: (job: JobRow) => {
      session.jobs.push(job);
      // Notify SSE listeners
      for (const listener of session.listeners) {
        listener(job);
      }
    },
  };

  // Fire and forget — scraping runs in the background
  runAllSites(siteFilter, options)
    .then((result: OrchestratorResult) => {
      session.state = "completed";
      session.completedAt = new Date().toISOString();
      lastRunTime = session.completedAt;
      // Clear date override
      if (date) {
        delete process.env.TEST_RUN_DATE;
      }
    })
    .catch((err: Error) => {
      session.state = "failed";
      session.error = err.message;
      session.completedAt = new Date().toISOString();
      if (date) {
        delete process.env.TEST_RUN_DATE;
      }
      console.error(`[server] Session ${sessionId} failed:`, err);
    });

  res.json({ sessionId, state: "running", sites: session.sites });
});

/* ---------- GET /scrape/:id/status ------------------------------- */
app.get("/scrape/:id/status", (req: Request, res: Response) => {
  const session = sessions.get(String(req.params.id));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  res.json({
    id: session.id,
    state: session.state,
    sites: session.sites,
    jobCount: session.jobs.length,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    error: session.error,
  });
});

/* ---------- GET /scrape/:id/results ------------------------------ */
app.get("/scrape/:id/results", (req: Request, res: Response) => {
  const session = sessions.get(String(req.params.id));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  res.json({
    id: session.id,
    state: session.state,
    jobCount: session.jobs.length,
    jobs: session.jobs,
  });
});

/* ---------- GET /scrape/:id/stream (SSE) ------------------------- */
app.get("/scrape/:id/stream", (req: Request, res: Response) => {
  const session = sessions.get(String(req.params.id));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // Set up SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send existing jobs as initial batch
  for (const job of session.jobs) {
    res.write(`data: ${JSON.stringify(job)}\n\n`);
  }

  // If already completed, send done event and close
  if (session.state !== "running") {
    res.write(
      `event: done\ndata: ${JSON.stringify({
        state: session.state,
        jobCount: session.jobs.length,
      })}\n\n`
    );
    res.end();
    return;
  }

  // Register listener for new jobs
  const listener = (job: JobRow) => {
    res.write(`data: ${JSON.stringify(job)}\n\n`);
  };
  session.listeners.add(listener);

  // Poll for completion
  const interval = setInterval(() => {
    if (session.state !== "running") {
      res.write(
        `event: done\ndata: ${JSON.stringify({
          state: session.state,
          jobCount: session.jobs.length,
        })}\n\n`
      );
      res.end();
      clearInterval(interval);
      session.listeners.delete(listener);
    }
  }, 5000);

  // Cleanup on client disconnect
  req.on("close", () => {
    session.listeners.delete(listener);
    clearInterval(interval);
  });
});

/* ---------- GET /results/:site/:date ----------------------------- */
/* Historical results: reads from CSV files on disk for a specific site/date */
app.get("/results/:site/:date", async (req: Request, res: Response) => {
  try {
    const siteKey = String(req.params.site);
    const date = String(req.params.date);
    const config = loadConfig();
    const siteConfig = config.sites.find(
      (s) =>
        s.key === siteKey ||
        s.host === siteKey ||
        s.host.replace(/\.\w+$/, "") === siteKey
    );

    if (!siteConfig) {
      res.status(404).json({ error: `Site "${siteKey}" not found` });
      return;
    }

    // Parse date (YYYY-MM-DD) → build output paths
    const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      res.status(400).json({
        error: 'Invalid date format. Use YYYY-MM-DD.',
      });
      return;
    }

    const [, yearStr, monthStr, dayStr] = match;
    const dateFolder = `${monthStr}_${dayStr}_${yearStr}`;
    const csvDir = path.join(config.output.root, siteConfig.host, dateFolder);

    if (!fs.existsSync(csvDir)) {
      res.json({ site: siteKey, date, jobs: [] });
      return;
    }

    // Find CSV files in the date folder
    const entries = await fs.promises.readdir(csvDir);
    const csvFiles = entries.filter((e) => e.endsWith(".csv"));

    const allJobs: JobRow[] = [];
    for (const csvFile of csvFiles) {
      const rows = await readJobRows(path.join(csvDir, csvFile));
      allJobs.push(...rows);
    }

    res.json({ site: siteKey, date, jobCount: allJobs.length, jobs: allJobs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/* ---------- GET /status ------------------------------------------ */
app.get("/status", (_req: Request, res: Response) => {
  const running: string[] = [];
  let totalSessions = 0;

  for (const [id, session] of sessions) {
    totalSessions++;
    if (session.state === "running") {
      running.push(id);
    }
  }

  res.json({
    health: "ok",
    running: running.length,
    runningSessions: running,
    totalSessions,
    lastRunTime,
    availableSites: getAvailableSiteKeys(),
  });
});

/* ------------------------------------------------------------------ */
/*  Start server                                                       */
/* ------------------------------------------------------------------ */

const PORT = env.scraperPort;
app.listen(PORT, () => {
  console.log(`[server] Scraper API listening on http://localhost:${PORT}`);
  console.log(`[server] Available sites: ${getAvailableSiteKeys().join(", ")}`);
  console.log(`[server] Endpoints:`);
  console.log(`  POST /scrape              - Start a scrape session`);
  console.log(`  GET  /scrape/:id/status   - Check session status`);
  console.log(`  GET  /scrape/:id/results  - Get session results`);
  console.log(`  GET  /scrape/:id/stream   - SSE live stream`);
  console.log(`  GET  /results/:site/:date - Historical results`);
  console.log(`  GET  /status              - Server health & info`);
});
