import cron from 'node-cron';
import readline from 'readline';
import { loadConfig, OutputConfig, SiteConfig } from './lib/config';
import { runKforceSite } from './sites/kforce';

async function runSite(site: SiteConfig, output: OutputConfig): Promise<void> {
  switch (site.key) {
    case 'kforce':
      await runKforceSite(site, output);
      break;
    default:
      console.warn(`No runner implemented for site key: ${site.key}`);
      break;
  }
}

async function runAllSites(siteFilter?: Set<string>): Promise<void> {
  const config = loadConfig();
  const targets = siteFilter
    ? config.sites.filter((site) => siteFilter.has(site.key))
    : config.sites;

  if (!targets.length) {
    console.warn('[runner] No sites matched the provided --site filter.');
    return;
  }

  const startTime = Date.now();
  const stopTimer = startElapsedTimer();
  for (const site of targets) {
    await runSite(site, config.output);
  }

  const durationMs = Date.now() - startTime;
  stopTimer();
  console.log(`[runner] Completed ${targets.length} site run(s) in ${formatDuration(durationMs)}.`);
}

function scheduleSites(siteFilter?: Set<string>): void {
  const config = loadConfig();
  const filterLabel = siteFilter ? ` for sites [${[...siteFilter].join(', ')}]` : '';
  console.log(
    `Scheduling hourly runs${filterLabel} with cron pattern ${config.schedule.cron}`
  );
  cron.schedule(config.schedule.cron, () => {
    console.log(`[scheduler] Triggering scrape at ${new Date().toISOString()}`);
    runAllSites(siteFilter).catch((error) => {
      console.error('[scheduler] run failed', error);
    });
  });
}

function getArgValue(flag: string): string | undefined {
  const flagWithEquals = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (flagWithEquals) {
    return flagWithEquals.split('=')[1];
  }

  const flagIndex = process.argv.indexOf(flag);
  if (flagIndex !== -1 && process.argv.length > flagIndex + 1) {
    return process.argv[flagIndex + 1];
  }

  return undefined;
}

function parseSiteFilter(): Set<string> | undefined {
  const raw = getArgValue('--site');
  if (!raw) {
    return undefined;
  }

  const values = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return values.length ? new Set(values) : undefined;
}

const siteFilter = parseSiteFilter();
const shouldSchedule = process.argv.includes('--schedule');

if (shouldSchedule) {
  scheduleSites(siteFilter);
} else {
  runAllSites(siteFilter).catch((error) => {
    console.error('Manual run failed', error);
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

function startElapsedTimer(label = '[runner] Elapsed'): () => void {
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
