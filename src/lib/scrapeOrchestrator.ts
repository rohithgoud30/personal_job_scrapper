import fs from "fs";
import path from "path";
import { loadConfig, OutputConfig, SiteConfig } from "./config";
import { JobRow } from "./csv";
import { runKforceSite } from "../sites/kforce";
import { runRandstadSite } from "../sites/randstadusa";
import { runCorpToCorpSite } from "../sites/corptocorp";
import { runVanguardSite } from "../sites/vanguard";
import { runDiceSite } from "../sites/dice";
import { runNvoidsSite } from "../sites/nvoids";
import { RunOptions } from "../sites/types";
import { getEasternDateParts } from "./time";
import { rejectedLogger } from "./rejectedLogger";

const RETENTION_DAYS = 3;

export function siteMatchesFilter(
  site: SiteConfig,
  filter: Set<string>
): boolean {
  if (filter.has(site.key)) return true;
  const hostWithoutTld = site.host.replace(/\.\w+$/, "");
  if (filter.has(hostWithoutTld)) return true;
  if (filter.has(site.host)) return true;
  return false;
}

async function runSite(
  site: SiteConfig,
  output: OutputConfig,
  options: RunOptions
): Promise<JobRow[]> {
  switch (site.key) {
    case "kforce":
      return runKforceSite(site, output, options);
    case "randstadusa":
      return runRandstadSite(site, output, options);
    case "corptocorp":
      return runCorpToCorpSite(site, output, options);
    case "vanguard":
      return runVanguardSite(site, output, options);
    case "dice":
      return runDiceSite(site, output, options);
    case "nvoids":
      return runNvoidsSite(site, output, options);
    default:
      console.warn(`No runner implemented for site key: ${site.key}`);
      return [];
  }
}

/**
 * Auto-cleanup: silently delete data folders older than RETENTION_DAYS.
 * No interactive prompt — runs unattended.
 */
async function cleanupOldData(
  sites: SiteConfig[],
  output: OutputConfig,
  siteFilter: Set<string> | undefined
): Promise<void> {
  const now = new Date();
  const targetSites = siteFilter
    ? sites.filter((s) => siteFilter.has(s.key))
    : sites;

  for (const site of targetSites) {
    const siteDir = path.join(output.root, site.host);
    if (!fs.existsSync(siteDir)) continue;

    const entries = await fs.promises.readdir(siteDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/^\d{2}_\d{2}_\d{4}$/.test(entry.name)) continue;

      const [month, day, year] = entry.name.split("_").map(Number);
      const folderDate = new Date(year, month - 1, day);
      const ageDays = (now.getTime() - folderDate.getTime()) / (1000 * 60 * 60 * 24);

      if (ageDays > RETENTION_DAYS) {
        const folderPath = path.join(siteDir, entry.name);
        await fs.promises.rm(folderPath, { recursive: true, force: true });
        console.log(`[cleanup] Deleted ${folderPath} (${Math.floor(ageDays)} days old)`);
      }
    }
  }
}

export interface OrchestratorResult {
  jobs: JobRow[];
  durationMs: number;
  sitesRun: number;
}

export async function runAllSites(
  siteFilter: Set<string> | undefined,
  options: RunOptions
): Promise<OrchestratorResult> {
  const config = loadConfig();
  const targets = siteFilter
    ? config.sites.filter((site) => siteMatchesFilter(site, siteFilter))
    : config.sites;

  if (!targets.length) {
    console.warn("[runner] No sites matched the provided filter.");
    return { jobs: [], durationMs: 0, sitesRun: 0 };
  }

  await cleanupOldData(config.sites, config.output, siteFilter);

  const allJobs: JobRow[] = [];
  const startTime = Date.now();

  for (const site of targets) {
    const siteJobs = await runSite(site, config.output, options);
    allJobs.push(...siteJobs);
  }

  const durationMs = Date.now() - startTime;
  console.log(
    `[runner] Completed ${targets.length} site run(s) in ${formatDuration(durationMs)}.`
  );

  rejectedLogger.save();

  return { jobs: allJobs, durationMs, sitesRun: targets.length };
}

export function getAvailableSiteKeys(): string[] {
  const config = loadConfig();
  return config.sites.map((s) => s.key);
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
