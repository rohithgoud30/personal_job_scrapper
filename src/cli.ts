import readline from "readline";
import { runAllSites } from "./lib/scrapeOrchestrator";
import { RunOptions } from "./sites/types";

function getArgValue(flag: string): string | undefined {
  const flagWithEquals = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (flagWithEquals) {
    return flagWithEquals.split("=")[1];
  }

  const flagIndex = process.argv.indexOf(flag);
  if (flagIndex !== -1 && process.argv.length > flagIndex + 1) {
    return process.argv[flagIndex + 1];
  }

  return undefined;
}

function parseSiteFilter(): Set<string> | undefined {
  const raw = getArgValue("--site");
  if (!raw) {
    return undefined;
  }

  const values = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return values.length ? new Set(values) : undefined;
}

function parseKeywords(): string[] | undefined {
  const raw = getArgValue("--keywords");
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

const siteFilter = parseSiteFilter();
const runOptions: RunOptions = {
  skipBatchPause:
    process.argv.includes("--skip-batch-wait") ||
    process.argv.includes("--fast"),
  resumeSessionId: getArgValue("--resume-session") ?? getArgValue("--session"),
  keywords: parseKeywords(),
};

const stopTimer = startElapsedTimer();

runAllSites(siteFilter, runOptions)
  .then((result) => {
    stopTimer();
    console.log(
      `[cli] Done. ${result.jobs.length} jobs accepted across ${result.sitesRun} site(s).`
    );
  })
  .catch((error) => {
    stopTimer();
    console.error("Manual run failed", error);
    process.exitCode = 1;
  });

/* ------------------------------------------------------------------ */
/*  Elapsed timer (CLI-only)                                           */
/* ------------------------------------------------------------------ */

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function startElapsedTimer(label = "[runner] Elapsed"): () => void {
  const start = Date.now();
  const originalLog = console.log;

  const render = () => {
    const duration = Date.now() - start;
    rewriteLine(`${label}: ${formatDuration(duration)}`);
  };

  console.log = (...args: unknown[]) => {
    clearStatusLine();
    originalLog(...args);
    render();
  };

  render();
  const interval = setInterval(render, 1000);

  return () => {
    clearInterval(interval);
    console.log = originalLog;
    clearStatusLine();
    originalLog(`${label}: ${formatDuration(Date.now() - start)}`);
  };
}

function rewriteLine(text: string): void {
  if (!process.stdout.isTTY) {
    process.stdout.write(`${text}\n`);
    return;
  }
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(text);
}

function clearStatusLine(): void {
  if (!process.stdout.isTTY) {
    return;
  }
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
}
