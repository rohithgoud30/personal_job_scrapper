import fs from "fs";
import path from "path";
import { BrowserContext, Page, chromium } from "playwright";
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

export async function runVanguardSite(
  site: SiteConfig,
  output: OutputConfig,
  options: RunOptions = {}
): Promise<void> {
  const resumeSessionId = options.resumeSessionId?.trim();
  const skipBatchDelay = Boolean(options.skipBatchPause);
  const rawKeywords = options.keywords?.length
    ? options.keywords
    : site.search.criteria.searchKeywords;
  const keywords = Array.isArray(rawKeywords)
    ? rawKeywords
    : rawKeywords
    ? [rawKeywords]
    : [];

  if (!resumeSessionId && !keywords.length) {
    console.warn("[vanguard] No keywords configured. Skipping run.");
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
        `[vanguard] Session ${resumeSessionId} not found under ${path.join(
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
      `[vanguard] Resuming AI-only run for session ${resumeSessionId} (date folder ${outputPaths.dateFolder}).`
    );
  } else {
    const dateLabel = getEasternDateLabel(runDate);
    if (isBackfill) {
      console.log(
        `[vanguard] Backfill mode enabled. Using run date ${dateLabel}.`
      );
    } else {
      console.log(`[vanguard] Live run using current date ${dateLabel}.`);
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
        console.log("[vanguard] No new roles detected for this session.");
        return;
      }

      stagedArray = Array.from(staged.values());
    } else if (!stagedArray.length) {
      console.log(
        `[vanguard] Session ${resumeSessionId} has no staged roles to evaluate.`
      );
      return;
    }

    console.log(
      `[vanguard][AI] Running title filter on ${stagedArray.length} staged roles...`
    );
    await writeSessionRoles(sessionPaths, stagedArray);

    const { removalSet, reasons } = await filterTitlesWithAi(stagedArray);
    if (removalSet.size) {
      console.log("[vanguard][AI] Title rejections:");
      let rejectIndex = 1;
      for (const row of stagedArray) {
        const key = row.job_id ?? row.url;
        if (!removalSet.has(key)) continue;
        const reason = reasons.get(key) ?? "Marked irrelevant.";
        console.log(
          `[vanguard][AI][Title Reject #${rejectIndex}] "${row.title}" (${row.location}) – ${reason}`
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
        // Add rejected job to seen so it's skipped in future sessions
        const jobKey = computeJobKey(row);
        seen.add(jobKey);
        rejectIndex += 1;
      }
    }

    const filtered = stagedArray.filter(
      (row) => !removalSet.has(row.job_id ?? row.url)
    );
    if (!filtered.length) {
      console.log("[vanguard] AI filtered out all titles for this session.");
      await writeSessionRoles(sessionPaths, filtered);
      await saveSeenStore(outputPaths.seenFile, seen);
      return;
    }

    await writeSessionRoles(sessionPaths, filtered);
    console.log(
      `[vanguard][AI] Title filter removed ${
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
      console.log("[vanguard] No jobs approved after detail evaluation.");
      await saveSeenStore(outputPaths.seenFile, seen);
      return;
    }

    await appendJobRows(outputPaths.csvFile, acceptedRows);
    await saveSeenStore(outputPaths.seenFile, seen);
    console.log(
      `[vanguard] Accepted ${acceptedRows.length} roles. Output: ${outputPaths.csvFile}`
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
      "[vanguard] Batch wait disabled; running keyword batches back-to-back."
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
      console.log(
        "[vanguard] Sleeping 30s before next keyword batch (robots crawl-delay)."
      );
      await sleep(30);
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
    console.log(`[vanguard][${keyword}] Searching for keyword "${keyword}"`);
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
      `[vanguard] Keyword "${keyword}": scraped ${rows.length}, staged ${added}`
    );
  } catch (error) {
    console.error(`[vanguard] Failed keyword "${keyword}"`, error);
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
  await acceptCookieConsent(page, site.cookieConsent);
}

async function scrapeKeyword(
  page: Page,
  site: SiteConfig,
  keyword: string,
  runDate: Date,
  isBackfill: boolean
): Promise<JobRow[]> {
  const selectors = site.search.selectors;
  const keywordInput = page.locator(selectors.keywords).first();

  if ((await keywordInput.count()) === 0) {
    throw new Error(
      `Keyword input not found using selector ${selectors.keywords}`
    );
  }

  await keywordInput.fill("");
  await keywordInput.type(keyword, { delay: 20 });

  const submitButton = page.locator(selectors.submit).first();
  if ((await submitButton.count()) === 0) {
    throw new Error(
      `Submit button not found using selector ${selectors.submit}`
    );
  }

  await submitButton.click({ delay: 50, noWaitAfter: true });
  await page.waitForLoadState("networkidle").catch(() => undefined);

  if (selectors.card) {
    await page.waitForFunction(
      ({ selector }) => document.querySelectorAll(selector).length > 0,
      { selector: selectors.card },
      { timeout: 60000 }
    );
  }

  await ensureNewestSort(page, site.search.selectors, keyword);

  return collectListingRows(page, site, keyword, runDate, isBackfill);
}

async function ensureNewestSort(
  page: Page,
  selectors: SiteConfig["search"]["selectors"],
  keyword: string
): Promise<void> {
  const { sortToggle, sortOptionText } = selectors;
  if (!sortToggle || !sortOptionText) {
    return;
  }

  const selectElement = page.locator(sortToggle).first();
  if ((await selectElement.count()) === 0) {
    console.warn(
      `[vanguard][${keyword}] Sort select not found using selector ${sortToggle}`
    );
    return;
  }

  // Check current value/text if possible, but for select it's easier to just select.
  // Vanguard "Newest" has value "open_date".
  // We can try selecting by label "Newest" as configured.
  try {
    await selectElement.selectOption({ label: sortOptionText });
    // Wait for reload/network idle
    await page.waitForLoadState("networkidle").catch(() => undefined);
  } catch (error) {
    console.warn(
      `[vanguard][${keyword}] Failed to select sort option "${sortOptionText}"`,
      error
    );
  }
}

async function collectListingRows(
  page: Page,
  site: SiteConfig,
  keyword: string,
  runDate: Date,
  isBackfill: boolean
): Promise<JobRow[]> {
  const selectors = site.search.selectors;
  if (!selectors.card) {
    return [];
  }
  const cards = page.locator(selectors.card);
  const rows: JobRow[] = [];
  let processedCount = 0;
  let pageIndex = 1;

  while (true) {
    const totalCards = await cards.count();
    for (let index = processedCount; index < totalCards; index += 1) {
      const card = cards.nth(index);
      const row = await extractJobRow(card, site);
      if (!row) {
        continue;
      }
      rows.push(row);
    }

    processedCount = totalCards;
    if (pageIndex >= site.run.maxPages) {
      break;
    }

    if (selectors.next) {
      const nextButton = page.locator(selectors.next).first();
      const canLoadMore = await nextButton.isVisible();
      if (!canLoadMore) {
        break;
      }

      // Check if button is active/clickable if needed, but isVisible is a good start
      // Sometimes "Next" exists but is disabled.
      // The selector `a[aria-label='Go to the next page of results.']` should be fine.

      await nextButton.click();
      await page.waitForFunction(
        ({ selector, previousCount: prev }) =>
          document.querySelectorAll(selector).length > 0, // Just wait for load, or maybe wait for count change if it's SPA?
        { selector: selectors.card, previousCount: processedCount },
        { timeout: 60000 }
      );
      // Vanguard seems to be a full page reload or at least significant DOM change.
      // Let's wait for network idle to be safe.
      await page.waitForLoadState("networkidle").catch(() => undefined);

      // Reset processedCount if it's a new page (pagination) vs infinite scroll
      // Vanguard looks like pagination (page 1, page 2...).
      // If it's pagination, we should process all cards on the new page.
      // So processedCount should be 0 for the new page loop?
      // Wait, `cards` locator is live. If the page changes, `cards` refers to new elements.
      // So yes, reset processedCount to 0.
      processedCount = 0;
    } else {
      break;
    }

    pageIndex += 1;
  }

  return rows;
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
      let description = await extractDescription(page, site);
      console.log(
        `[vanguard][AI] Detail candidate #${i + 1}/${roles.length} "${
          role.title
        }" (${role.location}) – description length ${description.length} chars.`
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
          `[vanguard][AI] Rejected "${role.title}" (${
            role.location
          }) – Reason: ${
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
        // Add rejected job to seen so it's skipped in future sessions
        const jobKey = computeJobKey(role);
        seen.add(jobKey);
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
        `[vanguard] Failed to evaluate detail for ${role.url}`,
        error
      );
    } finally {
      await page.close();
    }
  }

  console.log(
    `[vanguard][AI] Detail evaluation accepted ${accepted.length} roles out of ${roles.length}.`
  );
  return accepted;
}

export async function extractDescription(
  page: Page,
  site: SiteConfig
): Promise<string> {
  // Use a fallback if no specific description selector is configured,
  // but we know Vanguard has one in config.
  const selector = site.search.selectors.card
    ? "div.fusion-tabs div.fusion-tab-content" // Fallback/Default if not in config, but it IS in config.
    : "body";

  // Actually, let's just use what's in config or a hardcoded fallback for now
  // since SearchSelectors interface might not have 'description' explicitly typed
  // (it's not in the interface I saw earlier, wait let me check interface).
  // Interface SearchSelectors in config.ts does NOT have 'description'.
  // So I can't access site.search.selectors.description directly if typescript checks it.
  // I should add it to the interface or just use a hardcoded selector here since this is site-specific code.
  // But wait, I put it in config.json.
  // Let's check config.ts again.

  const descriptionSelector = "div.fusion-tabs div.fusion-tab-content";

  const locator = page.locator(descriptionSelector).first();
  if (await locator.count()) {
    try {
      const text = await locator.innerText({ timeout: 5000 });
      if (text.trim()) {
        return text.trim();
      }
    } catch (_) {
      // ignore
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
  if (!value) {
    return "";
  }
  if (!value.includes(",")) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function extractJobId(href: string): string | null {
  // Example: /job/22438637/android-technical-lead-ii-charlotte-nc...
  const match = href.match(/job\/(\d+)\//i);
  return match ? match[1] : null;
}

async function extractJobRow(
  card: Page["locator"] extends (...args: any[]) => infer R ? R : never,
  site: SiteConfig
): Promise<JobRow | null> {
  const selectors = site.search.selectors;
  if (!selectors.title) return null;

  const titleLink = card.locator(selectors.title).first();

  if ((await titleLink.count()) === 0) {
    return null;
  }

  const rawTitle = (await titleLink.innerText()).trim();
  const href = (await titleLink.getAttribute("href")) ?? "";
  const url = new URL(href, site.search.url).toString();
  if (site.disallowPatterns.some((pattern) => url.includes(pattern))) {
    return null;
  }

  let locationText = "";
  if (selectors.location) {
    locationText = (
      await card
        .locator(selectors.location)
        .first()
        .innerText()
        .catch(() => "")
    ).trim();
  }

  let postedText = "";
  if (selectors.posted) {
    postedText = (
      await card
        .locator(selectors.posted)
        .first()
        .innerText()
        .catch(() => "")
    ).trim();
  }

  return {
    site: site.key,
    title: rawTitle,
    company: "Vanguard",
    location: locationText,
    posted: postedText,
    url,
    job_id: extractJobId(href) ?? undefined,
    scraped_at: getEasternTimeLabel(),
  };
}

function createSessionId(): string {
  return `session_${Date.now()}`;
}
