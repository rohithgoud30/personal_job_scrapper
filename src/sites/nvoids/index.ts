import fs from "fs";
import path from "path";
import { BrowserContext, Locator, Page, chromium } from "playwright";
import { OutputConfig, SiteConfig } from "../../lib/config";
import { acceptCookieConsent } from "../../lib/cookies";
import { appendJobRows, JobRow } from "../../lib/csv";
import { computeJobKey, loadSeenStore, saveSeenStore } from "../../lib/dedupe";
import {
  buildOutputPaths,
  buildSessionPaths,
  ensureDirectoryExists,
  OutputPaths,
  SessionPaths,
} from "../../lib/paths";
import {
  findSessionById,
  parseDateFolderLabel,
  readSessionCsv,
} from "../../lib/session";
import { getEasternDateLabel, getEasternTimeLabel } from "../../lib/time";
import { env, getRunDateOverride } from "../../lib/env";
import { sleep } from "../../lib/throttle";
import {
  evaluateJobDetail,
  findIrrelevantJobIds,
  TitleEntry,
  TitleFilterResult,
} from "../../lib/aiEvaluator";
import { rejectedLogger } from "../../lib/rejectedLogger";
import { RunOptions } from "../types";

interface SessionRole extends JobRow {
  session_id: string;
  keyword: string;
}

export async function runNvoidsSite(
  site: SiteConfig,
  output: OutputConfig,
  options: RunOptions = {}
): Promise<void> {
  const resumeSessionId = options.resumeSessionId?.trim();
  const skipBatchDelay = Boolean(options.skipBatchPause);
  const keywords = normalizeKeywords(site.search.criteria.searchKeywords);

  if (!resumeSessionId && !keywords.length) {
    console.warn("[nvoids] No keywords configured. Skipping run.");
    return;
  }

  const runDateOverride = getRunDateOverride();
  let runDate = runDateOverride ?? new Date();
  let isBackfill = Boolean(runDateOverride);
  let outputPaths: OutputPaths;
  let sessionPaths: SessionPaths;
  let stagedArray: SessionRole[] = [];

  if (resumeSessionId) {
    const located = await findSessionById(output, site, resumeSessionId);
    if (!located) {
      console.warn(
        `[nvoids] Session ${resumeSessionId} not found under ${path.join(
          output.root,
          site.host
        )}.`
      );
      return;
    }

    outputPaths = located.outputPaths;
    sessionPaths = located.sessionPaths;
    stagedArray = (await readSessionCsv(sessionPaths.rolesFile)).map((row) => ({
      session_id: row.session_id,
      keyword: row.keyword,
      site: row.site,
      title: row.title,
      company: row.company,
      location: row.location,
      posted: row.posted,
      url: row.url,
      job_id: row.job_id || undefined,
      scraped_at: row.scraped_at,
    }));

    const parsedDate = parseDateFolderLabel(outputPaths.dateFolder);
    if (parsedDate) {
      runDate = parsedDate;
      isBackfill = false;
    }

    console.log(
      `[nvoids] Resuming AI-only run for session ${resumeSessionId} (date folder ${outputPaths.dateFolder}).`
    );
  } else {
    const dateLabel = getEasternDateLabel(runDate);
    if (isBackfill) {
      console.log(
        `[nvoids] Backfill mode enabled. Using run date ${dateLabel}.`
      );
    } else {
      console.log(`[nvoids] Live run using current date ${dateLabel}.`);
    }
    outputPaths = buildOutputPaths(output, site, runDate);
    const sessionId = createSessionId();
    sessionPaths = buildSessionPaths(outputPaths, sessionId);
    await ensureDirectoryExists(sessionPaths.rolesDir);
  }

  const seen = await loadSeenStore(outputPaths.seenFile);
  const userDataDir = path.resolve(site.userDataDir);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
  });

  try {
    if (!resumeSessionId) {
      const staged = new Map<string, SessionRole>();
      await scrapeKeywordsInBatches(
        context,
        site,
        keywords,
        seen,
        staged,
        sessionPaths.sessionId,
        runDate,
        isBackfill,
        skipBatchDelay
      );

      if (!staged.size) {
        console.log("[nvoids] No new roles detected for this session.");
        return;
      }

      stagedArray = Array.from(staged.values());
    } else if (!stagedArray.length) {
      console.log(
        `[nvoids] Session ${resumeSessionId} has no staged roles to evaluate.`
      );
      return;
    }

    console.log(
      `[nvoids][AI] Running title filter on ${stagedArray.length} staged roles...`
    );
    await writeSessionRoles(sessionPaths, stagedArray);

    const { removalSet, reasons } = await filterTitlesWithAi(stagedArray);
    if (removalSet.size) {
      console.log("[nvoids][AI] Title rejections:");
      let rejectIndex = 1;
      for (const row of stagedArray) {
        const key = row.job_id ?? row.url;
        if (!removalSet.has(key)) continue;
        const reason = reasons.get(key) ?? "Marked irrelevant.";
        console.log(
          `[nvoids][AI][Title Reject #${rejectIndex}] "${row.title}" (${row.location}) – ${reason}`
        );
        rejectedLogger.log({
          title: row.title,
          site: site.key,
          url: row.url,
          jd: "N/A",
          reason: reason,
          scraped_at: row.scraped_at,
          type: "title",
        });
        rejectIndex += 1;
      }
    }

    const filtered = stagedArray.filter(
      (row) => !removalSet.has(row.job_id ?? row.url)
    );
    if (!filtered.length) {
      console.log("[nvoids] AI filtered out all titles for this session.");
      await writeSessionRoles(sessionPaths, filtered);
      return;
    }

    await writeSessionRoles(sessionPaths, filtered);
    console.log(
      `[nvoids][AI] Title filter removed ${
        stagedArray.length - filtered.length
      } roles. ${filtered.length} remain for detail evaluation.`
    );

    const acceptedRows = await evaluateDetailedJobs(
      context,
      filtered,
      seen,
      site
    );
    if (!acceptedRows.length) {
      console.log("[nvoids] No jobs approved after detail evaluation.");
      return;
    }

    await appendJobRows(outputPaths.csvFile, acceptedRows);
    await saveSeenStore(outputPaths.seenFile, seen);
    console.log(
      `[nvoids] Accepted ${acceptedRows.length} roles. Output: ${outputPaths.csvFile}`
    );
    rejectedLogger.save(
      path.join(
        outputPaths.directory,
        `rejected_jobs_${outputPaths.dateFolder}.xlsx`
      )
    );
  } finally {
    await context.close();
  }
}

async function scrapeKeywordsInBatches(
  context: BrowserContext,
  site: SiteConfig,
  keywords: string[],
  seen: Set<string>,
  staged: Map<string, SessionRole>,
  sessionId: string,
  runDate: Date,
  isBackfill: boolean,
  skipBatchDelay: boolean
): Promise<void> {
  const batchSize = env.keywordBatchSize;
  if (skipBatchDelay) {
    console.log(
      "[nvoids] Batch wait disabled; running keyword batches back-to-back."
    );
  }

  for (let i = 0; i < keywords.length; i += batchSize) {
    const batch = keywords.slice(i, i + batchSize);
    await Promise.all(
      batch.map((keyword) =>
        scrapeKeywordInNewPage(
          context,
          site,
          keyword,
          seen,
          staged,
          sessionId,
          runDate,
          isBackfill
        )
      )
    );

    const hasMoreBatches = i + batchSize < keywords.length;
    if (!isBackfill && hasMoreBatches && !skipBatchDelay) {
      const delay = site.run.keywordDelaySeconds ?? 0;
      if (delay > 0) {
        console.log(`[nvoids] Sleeping ${delay}s before next keyword batch.`);
        await sleep(delay);
      }
    }
  }
}

async function scrapeKeywordInNewPage(
  context: BrowserContext,
  site: SiteConfig,
  keyword: string,
  seen: Set<string>,
  staged: Map<string, SessionRole>,
  sessionId: string,
  runDate: Date,
  isBackfill: boolean
): Promise<void> {
  const page = await context.newPage();
  try {
    console.log(`[nvoids][${keyword}] Searching for keyword "${keyword}"`);
    await prepareSearchPage(page, site, keyword);
    const rows = await scrapeKeyword(page, site, keyword, runDate, isBackfill);
    let added = 0;
    for (const row of rows) {
      const jobKey = computeJobKey(row);
      if (seen.has(jobKey) || staged.has(jobKey)) {
        continue;
      }
      staged.set(jobKey, {
        ...row,
        session_id: sessionId,
        keyword,
      });
      added += 1;
    }
    console.log(
      `[nvoids] Keyword "${keyword}": scraped ${rows.length}, staged ${added}`
    );
  } catch (error) {
    console.error(`[nvoids] Failed keyword "${keyword}"`, error);
  } finally {
    await page.close();
  }
}

async function prepareSearchPage(
  page: Page,
  site: SiteConfig,
  keyword: string
): Promise<void> {
  await page.goto(site.search.url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
}

async function scrapeKeyword(
  page: Page,
  site: SiteConfig,
  keyword: string,
  runDate: Date,
  isBackfill: boolean
): Promise<JobRow[]> {
  const searchInput = page.locator(site.search.selectors.keywords);
  const submitButton = page.locator(site.search.selectors.submit);

  if ((await searchInput.count()) === 0) {
    console.warn(
      `[nvoids][${keyword}] Search input not found. Skipping keyword.`
    );
    return [];
  }

  await searchInput.fill(keyword);
  await submitButton.click();
  await page.waitForTimeout(2000);

  return collectListingRows(page, site, keyword, runDate, isBackfill);
}

async function collectListingRows(
  page: Page,
  site: SiteConfig,
  keyword: string,
  runDate: Date,
  isBackfill: boolean
): Promise<JobRow[]> {
  const rows: JobRow[] = [];
  let pageIndex = 1;

  while (true) {
    await page
      .waitForSelector("table tbody tr", { timeout: 10000 })
      .catch(() => {});

    const rowElements = page.locator("table tbody tr");
    const count = await rowElements.count();

    if (count === 0) {
      console.log(
        `[nvoids][${keyword}] No results found on page ${pageIndex}. Stopping.`
      );
      break;
    }

    let pageHasToday = !site.search.postedTodayOnly;

    for (let i = 0; i < count; i++) {
      const rowEl = rowElements.nth(i);
      const row = await extractJobRow(rowEl, site);

      if (!row) continue;

      if (site.search.postedTodayOnly && !isPostedToday(row.posted, runDate)) {
        continue;
      }

      pageHasToday = true;
      rows.push(row);
    }

    if (!isBackfill && site.search.postedTodayOnly && !pageHasToday) {
      console.log(
        `[nvoids][${keyword}] No results dated today on page ${pageIndex}. Stopping pagination.`
      );
      break;
    }

    if (pageIndex >= site.run.maxPages) {
      console.log(
        `[nvoids][${keyword}] Reached max pages (${site.run.maxPages}). Stopping.`
      );
      break;
    }

    // Check for Next button
    const nextSelector = site.search.selectors.next ?? "a:has-text('Next')";
    const nextBtn = page.locator(nextSelector);
    if (await nextBtn.isVisible()) {
      await nextBtn.click();
      await page.waitForTimeout(2000);
      pageIndex++;
    } else {
      console.log(
        `[nvoids][${keyword}] No more pages available. Stopping pagination.`
      );
      break;
    }
  }

  return rows;
}

async function extractJobRow(
  row: Locator,
  site: SiteConfig
): Promise<JobRow | null> {
  try {
    const titleLink = row.locator("td:nth-child(1) a").first();
    if ((await titleLink.count()) === 0) return null;

    const rawTitle = (await titleLink.innerText()).trim();
    const href = (await titleLink.getAttribute("href")) ?? "";
    const url = href ? new URL(href, site.search.url).toString() : "";

    if (site.disallowPatterns.some((pattern) => url.includes(pattern))) {
      return null;
    }

    const locationCell = row.locator("td:nth-child(2)");
    const locationText = await locationCell.innerText().catch(() => "");

    const postedCell = row.locator("td:nth-child(3)");
    const postedText = await postedCell.innerText().catch(() => "");

    // Extract job ID from URL
    const jobId = extractJobId(url);

    return {
      site: site.key,
      title: rawTitle,
      company: "Nvoids", // Aggregator
      location: locationText.trim(),
      posted: postedText.trim(),
      url,
      job_id: jobId ?? undefined,
      scraped_at: getEasternTimeLabel(),
    };
  } catch (e) {
    return null;
  }
}

async function evaluateDetailedJobs(
  context: BrowserContext,
  roles: SessionRole[],
  seen: Set<string>,
  site: SiteConfig
): Promise<JobRow[]> {
  const accepted: JobRow[] = [];
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i];
    const page = await context.newPage();
    try {
      await page.goto(role.url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      let description = await extractDescription(page);

      console.log(
        `[nvoids][AI] Detail candidate #${i + 1}/${roles.length} "${
          role.title
        }" – description length ${description.length} chars.`
      );

      const detailResult = await evaluateJobDetail(
        {
          title: role.title,
          company: role.company,
          location: role.location,
          url: role.url,
          description,
        },
        site
      );

      if (!detailResult.accepted) {
        console.log(
          `[nvoids][AI] Rejected "${role.title}" – Reason: ${
            detailResult.reasoning || "Model marked as not relevant."
          }`
        );
        rejectedLogger.log({
          title: role.title,
          site: site.key,
          url: role.url,
          jd: description,
          reason: detailResult.reasoning || "Model marked as not relevant.",
          scraped_at: role.scraped_at,
          type: "detail",
        });
        continue;
      }

      const jobKey = computeJobKey(role);
      if (seen.has(jobKey)) {
        continue;
      }

      seen.add(jobKey);
      accepted.push(role);
    } catch (error) {
      console.error(
        `[nvoids] Failed to evaluate detail for ${role.url}`,
        error
      );
    } finally {
      await page.close();
    }
  }

  console.log(
    `[nvoids][AI] Detail evaluation accepted ${accepted.length} roles out of ${roles.length}.`
  );
  return accepted;
}

export async function extractDescription(page: Page): Promise<string> {
  // Generic selectors for job description
  const selectors = [
    ".entry-content",
    ".job-content",
    "article",
    "main",
    "body",
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        const text = await locator.innerText({ timeout: 5000 });
        if (text.trim()) {
          return text.trim();
        }
      } catch (_) {
        continue;
      }
    }
  }
  return await page.content();
}

async function filterTitlesWithAi(
  rows: SessionRole[]
): Promise<TitleFilterResult> {
  const entries: TitleEntry[] = rows.map((row) => ({
    title: row.title,
    company: row.company,
    location: row.location,
    url: row.url,
    job_id: row.job_id ?? row.url,
  }));
  return findIrrelevantJobIds(entries);
}

async function writeSessionRoles(
  sessionPaths: SessionPaths,
  rows: SessionRole[]
): Promise<void> {
  const headers = [
    "session_id",
    "keyword",
    "site",
    "title",
    "company",
    "location",
    "posted",
    "url",
    "job_id",
    "scraped_at",
  ];
  const lines = rows.map((row) =>
    [
      row.session_id,
      row.keyword,
      row.site,
      escapeCsv(row.title),
      escapeCsv(row.company),
      escapeCsv(row.location),
      escapeCsv(row.posted),
      row.url,
      row.job_id ?? "",
      row.scraped_at,
    ].join(",")
  );

  const payload = [headers.join(","), ...lines].join("\n") + "\n";
  await ensureDirectoryExists(sessionPaths.rolesDir);
  await fs.promises.writeFile(sessionPaths.rolesFile, payload, "utf-8");
}

function escapeCsv(value: string): string {
  if (!value) return "";
  if (!value.includes(",")) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function normalizeKeywords(raw: string | string[]): string[] {
  const candidates = Array.isArray(raw) ? raw : [raw];
  return Array.from(
    new Set(candidates.map((keyword) => keyword.trim()).filter(Boolean))
  );
}

function isPostedToday(posted: string, referenceDate: Date): boolean {
  // Nvoids uses IST (India Standard Time) timezone with format: "HH:MM AM/PM DD-Mon-YY"
  // Examples: "03:18 AM 02-Dec-25", "11:54 PM 01-Dec-25"

  // Helper to check if a Date matches "Today" in a specific timezone
  const isTodayInZone = (jobDate: Date, zone: string): boolean => {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    });

    // Get Reference Date (Now) parts in Zone
    const refParts = formatter.formatToParts(referenceDate);
    const refYear = parseInt(
      refParts.find((p) => p.type === "year")?.value || "0"
    );
    const refMonth = parseInt(
      refParts.find((p) => p.type === "month")?.value || "0"
    );
    const refDay = parseInt(
      refParts.find((p) => p.type === "day")?.value || "0"
    );

    // Get Job Date parts in Zone
    const jobParts = formatter.formatToParts(jobDate);
    const jobYear = parseInt(
      jobParts.find((p) => p.type === "year")?.value || "0"
    );
    const jobMonth = parseInt(
      jobParts.find((p) => p.type === "month")?.value || "0"
    );
    const jobDay = parseInt(
      jobParts.find((p) => p.type === "day")?.value || "0"
    );

    return refYear === jobYear && refMonth === jobMonth && refDay === jobDay;
  };

  // Parse the job's posted date string
  // Format: "HH:MM AM/PM DD-Mon-YY" -> e.g. "11:54 PM 01-Dec-25"
  const dateMatch = posted.match(
    /(\d{2}):(\d{2})\s+(AM|PM)\s+(\d{2})-([A-Za-z]{3})-(\d{2})/
  );

  if (dateMatch) {
    const [_, hourStr, minStr, ampm, dayStr, monthStr, yearStr] = dateMatch;

    const monthMap: { [key: string]: number } = {
      Jan: 0,
      Feb: 1,
      Mar: 2,
      Apr: 3,
      May: 4,
      Jun: 5,
      Jul: 6,
      Aug: 7,
      Sep: 8,
      Oct: 9,
      Nov: 10,
      Dec: 11,
    };

    let hour = parseInt(hourStr);
    const minute = parseInt(minStr);
    const day = parseInt(dayStr);
    const month = monthMap[monthStr];
    const year = 2000 + parseInt(yearStr);

    if (ampm === "PM" && hour < 12) hour += 12;
    if (ampm === "AM" && hour === 12) hour = 0;

    // Construct Date object treating the parsed time as IST (UTC+5:30)
    // 1. Create UTC timestamp for the parsed components
    const utcTimestamp = Date.UTC(year, month, day, hour, minute);
    // 2. Subtract 5.5 hours (in ms) to get the actual UTC timestamp
    //    because "11:00 PM IST" is "5:30 PM UTC" (earlier)
    const istOffsetMs = (5 * 60 + 30) * 60 * 1000;
    const jobDate = new Date(utcTimestamp - istOffsetMs);

    // Check if it's Today in IST OR Today in EST (New York)
    const isTodayIST = isTodayInZone(jobDate, "Asia/Kolkata");
    const isTodayEST = isTodayInZone(jobDate, "America/New_York");

    return isTodayIST || isTodayEST;
  }

  // Fallback: try parsing as MM/DD/YYYY format (legacy support)
  const slashMatch = posted.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashMatch) {
    const [_, m, d, y] = slashMatch;
    const jobDateStr = `${parseInt(m)}/${parseInt(d)}/${y}`;

    const getZoneDateStr = (zone: string) => {
      const f = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
      });
      const p = f.formatToParts(referenceDate);
      const year = p.find((x) => x.type === "year")?.value;
      const month = p.find((x) => x.type === "month")?.value;
      const day = p.find((x) => x.type === "day")?.value;
      return `${month}/${day}/${year}`;
    };

    return (
      jobDateStr === getZoneDateStr("Asia/Kolkata") ||
      jobDateStr === getZoneDateStr("America/New_York")
    );
  }

  return false;
}

function extractJobId(url: string): string | null {
  // URL structure: https://jobs.nvoids.com/job_details.jsp?id=2961497&uid=...
  const match = url.match(/[?&]id=(\d+)/);
  return match ? match[1] : null;
}

function createSessionId(): string {
  return `session-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}
