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
import { RunOptions } from "../types";

interface SessionRole extends JobRow {
  session_id: string;
  keyword: string;
}

export async function runCorpToCorpSite(
  site: SiteConfig,
  output: OutputConfig,
  options: RunOptions = {}
): Promise<void> {
  const resumeSessionId = options.resumeSessionId?.trim();
  const skipBatchDelay = Boolean(options.skipBatchPause);
  const keywords = normalizeKeywords(site.search.criteria.searchKeywords);

  if (!resumeSessionId && !keywords.length) {
    console.warn("[corptocorp] No keywords configured. Skipping run.");
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
        `[corptocorp] Session ${resumeSessionId} not found under ${path.join(
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
      `[corptocorp] Resuming AI-only run for session ${resumeSessionId} (date folder ${outputPaths.dateFolder}).`
    );
  } else {
    const dateLabel = getEasternDateLabel(runDate);
    if (isBackfill) {
      console.log(
        `[corptocorp] Backfill mode enabled. Using run date ${dateLabel}.`
      );
    } else {
      console.log(`[corptocorp] Live run using current date ${dateLabel}.`);
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
        console.log("[corptocorp] No new roles detected for this session.");
        return;
      }

      stagedArray = Array.from(staged.values());
    } else if (!stagedArray.length) {
      console.log(
        `[corptocorp] Session ${resumeSessionId} has no staged roles to evaluate.`
      );
      return;
    }

    console.log(
      `[corptocorp][AI] Running title filter on ${stagedArray.length} staged roles...`
    );
    await writeSessionRoles(sessionPaths, stagedArray);

    const { removalSet, reasons } = await filterTitlesWithAi(stagedArray);
    if (removalSet.size) {
      console.log("[corptocorp][AI] Title rejections:");
      let rejectIndex = 1;
      for (const row of stagedArray) {
        const key = row.job_id ?? row.url;
        if (!removalSet.has(key)) continue;
        const reason = reasons.get(key) ?? "Marked irrelevant.";
        console.log(
          `[corptocorp][AI][Title Reject #${rejectIndex}] "${row.title}" (${row.location}) – ${reason}`
        );
        rejectIndex += 1;
      }
    }

    const filtered = stagedArray.filter(
      (row) => !removalSet.has(row.job_id ?? row.url)
    );
    if (!filtered.length) {
      console.log("[corptocorp] AI filtered out all titles for this session.");
      await writeSessionRoles(sessionPaths, filtered);
      return;
    }

    await writeSessionRoles(sessionPaths, filtered);
    console.log(
      `[corptocorp][AI] Title filter removed ${
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
      console.log("[corptocorp] No jobs approved after detail evaluation.");
      return;
    }

    await appendJobRows(outputPaths.csvFile, acceptedRows);
    await saveSeenStore(outputPaths.seenFile, seen);
    console.log(
      `[corptocorp] Accepted ${acceptedRows.length} roles. Output: ${outputPaths.csvFile}`
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
      "[corptocorp] Batch wait disabled; running keyword batches back-to-back."
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
        console.log(
          `[corptocorp] Sleeping ${delay}s before next keyword batch.`
        );
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
    console.log(`[corptocorp] Searching for keyword "${keyword}"`);
    await prepareSearchPage(page, site);
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
      `[corptocorp] Keyword "${keyword}": scraped ${rows.length}, staged ${added}`
    );
  } catch (error) {
    console.error(`[corptocorp] Failed keyword "${keyword}"`, error);
  } finally {
    await page.close();
  }
}

async function prepareSearchPage(page: Page, site: SiteConfig): Promise<void> {
  await page.goto(site.search.url, { waitUntil: "domcontentloaded" });
  // Initial popup check
  await dismissPopup(page);
}

async function dismissPopup(page: Page): Promise<void> {
  try {
    // 1. The specific modal causing issues: #ipt-popup-modal
    // We will try to click the close button if visible, but we will ALWAYS force hide it afterwards.
    const modal = page.locator("#ipt-popup-modal");
    if (await modal.isVisible()) {
      console.log(
        "[corptocorp] Detected #ipt-popup-modal. Attempting to dismiss..."
      );
      const closeBtn = modal
        .locator("button")
        .or(modal.locator(".close"))
        .or(modal.locator('[class*="close"]'))
        .or(modal.getByText("Okay"))
        .or(modal.getByText("Close"))
        .first();
      if (await closeBtn.isVisible()) {
        console.log("[corptocorp] Found close button. Clicking...");
        await closeBtn.click();
        await page.waitForTimeout(500);
      }
    }

    // ALWAYS force hide the modal and backdrop, just in case it's intercepting but "not visible" or animating out.
    await page.evaluate(() => {
      const el = document.querySelector("#ipt-popup-modal");
      if (el) {
        (el as HTMLElement).style.display = "none";
        (el as HTMLElement).style.visibility = "hidden";
        (el as HTMLElement).style.pointerEvents = "none";
      }
      const backdrop = document.querySelector(".modal-backdrop");
      if (backdrop) (backdrop as HTMLElement).remove();

      // Also remove any other potential blockers
      document
        .querySelectorAll('[id*="popup"], [class*="popup"], [class*="modal"]')
        .forEach((el) => {
          if (
            getComputedStyle(el).position === "fixed" &&
            getComputedStyle(el).zIndex !== "auto"
          ) {
            // Be careful not to hide the header/nav, but this is a specific scraper script.
            // Let's stick to the specific ID for now to be safe, plus the backdrop.
          }
        });
    });

    // 2. Notification Popup ("NOT YET")
    const notYetBtn = page
      .getByRole("button", { name: "NOT YET", exact: true })
      .or(page.getByText("NOT YET"));
    if (await notYetBtn.isVisible()) {
      console.log('[corptocorp] Dismissing notification popup ("NOT YET")...');
      await notYetBtn.click();
      await page.waitForTimeout(500);
    }

    // 3. Important Notice Popup ("Okay")
    const okayBtn = page
      .getByRole("button", { name: "Okay", exact: true })
      .or(page.getByText("Okay"));
    if (await okayBtn.isVisible()) {
      console.log('[corptocorp] Dismissing Important Notice popup ("Okay")...');
      await okayBtn.click();
      await page.waitForTimeout(500);
    }
  } catch (e) {
    console.warn("[corptocorp] Error in dismissPopup:", e);
  }
}

async function expectModalToVanish(locator: Locator) {
  try {
    await locator.waitFor({ state: "hidden", timeout: 3000 });
  } catch {
    console.warn("[corptocorp] Modal did not vanish quickly after dismissal.");
  }
}

async function scrapeKeyword(
  page: Page,
  site: SiteConfig,
  keyword: string,
  runDate: Date,
  isBackfill: boolean
): Promise<JobRow[]> {
  // CorpToCorp uses a DataTables search input
  const searchInput = page.locator('input[type="search"]').first();

  if ((await searchInput.count()) === 0) {
    console.warn(
      "[corptocorp] Search input not found. Scraping all visible jobs."
    );
  } else {
    await searchInput.fill(keyword);
    // Wait for table to update - DataTables usually updates on input
    await page.waitForTimeout(2000);
  }

  await ensureDateSort(page);

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
    // Wait for rows to be present
    await page
      .waitForSelector("table#ipt-posts-table tbody tr", { timeout: 10000 })
      .catch(() => {});

    const rowElements = page.locator("table#ipt-posts-table tbody tr");
    const count = await rowElements.count();

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
        `[corptocorp] No results dated today on page ${pageIndex}. Stopping pagination.`
      );
      break;
    }

    if (pageIndex >= site.run.maxPages) {
      break;
    }

    // Check for Next button
    const nextBtn = page.locator("#ipt-posts-table_next");
    if (
      (await nextBtn.isVisible()) &&
      !(await nextBtn.getAttribute("class"))?.includes("disabled")
    ) {
      await nextBtn.click();
      await page.waitForTimeout(2000); // Wait for next page load
      pageIndex++;
    } else {
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
    const url = new URL(href, site.search.url).toString();

    if (site.disallowPatterns.some((pattern) => url.includes(pattern))) {
      return null;
    }

    const dateCell = row.locator("td:nth-child(3)");
    // Use data-order if available for better precision, otherwise text
    const dateSortValue = await dateCell
      .getAttribute("data-order")
      .catch(() => null);
    const dateText = await dateCell.innerText().catch(() => "");

    // CorpToCorp doesn't have explicit company/location columns easily accessible in the table
    // Location is often in the title

    return {
      site: site.key,
      title: rawTitle,
      company: "CorpToCorp", // Aggregator
      location: "", // Often in title
      posted: dateSortValue || dateText,
      url,
      job_id: extractJobId(href) ?? undefined,
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
        `[corptocorp][AI] Detail candidate #${i + 1}/${roles.length} "${
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
          `[corptocorp][AI] Rejected "${role.title}" – Reason: ${
            detailResult.reasoning || "Model marked as not relevant."
          }`
        );
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
        `[corptocorp] Failed to evaluate detail for ${role.url}`,
        error
      );
    } finally {
      await page.close();
    }
  }

  console.log(
    `[corptocorp][AI] Detail evaluation accepted ${accepted.length} roles out of ${roles.length}.`
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
  // CorpToCorp data-order is YYYY-MM-DD HH:mm:ss
  // Or text is "November 18, 2025"

  const today = getEasternDateLabel(referenceDate); // MM/DD/YYYY

  // Try parsing YYYY-MM-DD
  const match = posted.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const [_, y, m, d] = match;
    const formatted = `${m}/${d}/${y}`;
    return formatted === today;
  }

  // Try parsing "Month DD, YYYY"
  const date = new Date(posted);
  if (!isNaN(date.getTime())) {
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const y = date.getFullYear();
    return `${m}/${d}/${y}` === today;
  }

  return false;
}

function extractJobId(href: string): string | null {
  // URL structure: https://corptocorp.org/job-title/
  // No clear ID in URL usually, so we might just return null and use URL as key
  return null;
}

function createSessionId(): string {
  return `session-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

async function ensureDateSort(page: Page): Promise<void> {
  try {
    // 3rd column is Date (index 2)
    const dateHeader = page.locator("table#ipt-posts-table thead th").nth(2);
    if ((await dateHeader.count()) === 0) return;

    // Check if already sorted descending (DataTables usually adds 'sorting_desc' class)
    const getClass = async () => (await dateHeader.getAttribute("class")) || "";

    if (!(await getClass()).includes("sorting_desc")) {
      console.log("[corptocorp] Sorting by Date (Newest First)...");

      // Retry loop for clicking
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await dismissPopup(page);
          await dateHeader.click({ timeout: 5000 });
          await page.waitForTimeout(1000);
          break; // Success
        } catch (err) {
          console.warn(
            `[corptocorp] Sort click attempt ${attempt} failed. Retrying...`
          );
          await page.waitForTimeout(1000);
        }
      }

      // If it became ascending, click again
      if ((await getClass()).includes("sorting_asc")) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await dismissPopup(page);
            await dateHeader.click({ timeout: 5000 });
            await page.waitForTimeout(1000);
            break;
          } catch (err) {
            console.warn(
              `[corptocorp] Sort (asc->desc) click attempt ${attempt} failed. Retrying...`
            );
            await page.waitForTimeout(1000);
          }
        }
      }
    }
  } catch (e) {
    console.warn("[corptocorp] Failed to sort table:", e);
  }
}
