import fs from "fs";
import path from "path";
import cron from "node-cron";
import readline from "readline";
import { loadConfig, OutputConfig, SiteConfig } from "./lib/config";
import { runKforceSite } from "./sites/kforce";
import { runRandstadSite } from "./sites/randstadusa";
import { runCorpToCorpSite } from "./sites/corptocorp";
import { runVanguardSite } from "./sites/vanguard";
import { runDiceSite } from "./sites/dice";
import { runNvoidsSite } from "./sites/nvoids";
import { RunOptions } from "./sites/types";
import { getEasternDateParts } from "./lib/time";
import { rejectedLogger } from "./lib/rejectedLogger";

async function runSite(
  site: SiteConfig,
  output: OutputConfig,
  options: RunOptions
): Promise<void> {
  switch (site.key) {
    case "kforce":
      await runKforceSite(site, output, options);
      break;
    case "randstadusa":
      await runRandstadSite(site, output, options);
      break;
    case "corptocorp":
      await runCorpToCorpSite(site, output, options);
      break;
    case "vanguard":
      await runVanguardSite(site, output, options);
      break;
    case "dice":
      await runDiceSite(site, output, options);
      break;
    case "nvoids":
      await runNvoidsSite(site, output, options);
      break;
    default:
      console.warn(`No runner implemented for site key: ${site.key}`);
      break;
  }
}

async function cleanupOldData(
  sites: SiteConfig[],
  output: OutputConfig,
  siteFilter: Set<string> | undefined
): Promise<void> {
  const eastern = getEasternDateParts(new Date());
  const month = String(eastern.month).padStart(2, "0");
  const day = String(eastern.day).padStart(2, "0");
  const year = eastern.year;
  const todayFolder = `${month}_${day}_${year}`;

  const foldersToDelete: string[] = [];

  // Filter sites if a specific site is requested
  const targetSites = siteFilter
    ? sites.filter((s) => siteFilter.has(s.key))
    : sites;

  for (const site of targetSites) {
    const siteDir = path.join(output.root, site.host);
    if (!fs.existsSync(siteDir)) continue;

    const entries = await fs.promises.readdir(siteDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Check if it matches date format MM_DD_YYYY
        if (/^\d{2}_\d{2}_\d{4}$/.test(entry.name)) {
          if (entry.name !== todayFolder) {
            foldersToDelete.push(path.join(siteDir, entry.name));
          }
        }
      }
    }
  }

  if (foldersToDelete.length === 0) {
    return;
  }

  console.log("[cleanup] Found old data folders:");
  for (const folder of foldersToDelete) {
    console.log(` - ${folder}`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question(
      "[cleanup] Do you want to delete these old folders? (y/N) ",
      resolve
    );
  });

  rl.close();

  if (answer.trim().toLowerCase() === "y") {
    console.log("[cleanup] Deleting folders...");
    for (const folder of foldersToDelete) {
      await fs.promises.rm(folder, { recursive: true, force: true });
      console.log(` - Deleted ${folder}`);
    }
  } else {
    console.log("[cleanup] Skipped deletion.");
  }
}

async function runAllSites(
  siteFilter: Set<string> | undefined,
  options: RunOptions
): Promise<void> {
  const config = loadConfig();
  const targets = siteFilter
    ? config.sites.filter((site) => siteFilter.has(site.key))
    : config.sites;

  if (!targets.length) {
    console.warn("[runner] No sites matched the provided --site filter.");
    return;
  }

  // Run cleanup check before starting
  await cleanupOldData(config.sites, config.output, siteFilter);

  const startTime = Date.now();
  const stopTimer = startElapsedTimer();
  for (const site of targets) {
    await runSite(site, config.output, options);
  }

  const durationMs = Date.now() - startTime;
  stopTimer();
  console.log(
    `[runner] Completed ${targets.length} site run(s) in ${formatDuration(
      durationMs
    )}.`
  );

  // Save rejected jobs log
  const rejectedLogPath = path.join(
    process.cwd(),
    "data",
    "rejected_jobs.xlsx"
  );
  rejectedLogger.save(rejectedLogPath);
}

function scheduleSites(
  siteFilter: Set<string> | undefined,
  options: RunOptions
): void {
  const config = loadConfig();
  if (config.schedule) {
    const filterLabel = siteFilter
      ? ` for sites [${[...siteFilter].join(", ")}]`
      : "";
    console.log(
      `Scheduling hourly runs${filterLabel} with cron pattern ${config.schedule.cron}`
    );
    cron.schedule(config.schedule.cron, () => {
      console.log(
        `[scheduler] Triggering scrape at ${new Date().toISOString()}`
      );
      runAllSites(siteFilter, options).catch((error) => {
        console.error("[scheduler] run failed", error);
      });
    });
  } else {
    console.warn(
      "[scheduler] No schedule configuration found. Skipping scheduled runs."
    );
  }
}

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

const siteFilter = parseSiteFilter();
const shouldSchedule = process.argv.includes("--schedule");
const runOptions: RunOptions = {
  skipBatchPause:
    process.argv.includes("--skip-batch-wait") ||
    process.argv.includes("--fast"),
  resumeSessionId: getArgValue("--resume-session") ?? getArgValue("--session"),
  keywords: parseKeywords(),
};

function parseKeywords(): string[] | undefined {
  const raw = getArgValue("--keywords");
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

if (runOptions.resumeSessionId && shouldSchedule) {
  console.warn(
    "[runner] Ignoring --resume-session when running on a schedule."
  );
}

if (shouldSchedule) {
  scheduleSites(siteFilter, runOptions);
} else {
  runAllSites(siteFilter, runOptions).catch((error) => {
    console.error("Manual run failed", error);
    process.exitCode = 1;
  });
}

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
