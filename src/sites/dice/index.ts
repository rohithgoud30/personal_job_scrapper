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

export async function runDiceSite(
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
    console.warn("[dice] No keywords configured. Skipping run.");
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
        `[dice] Session ${resumeSessionId} not found under ${path.join(
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
      `[dice] Resuming AI-only run for session ${resumeSessionId} (date folder ${outputPaths.dateFolder}).`
    );
  } else {
    const dateLabel = getEasternDateLabel(runDate);
    if (isBackfill) {
      console.log(`[dice] Backfill mode enabled. Using run date ${dateLabel}.`);
    } else {
      console.log(`[dice] Live run using current date ${dateLabel}.`);
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
        console.log("[dice] No new roles detected for this session.");
        return;
      }

      stagedArray = Array.from(staged.values());
    } else if (!stagedArray.length) {
      console.log(
        `[dice] Session ${resumeSessionId} has no staged roles to evaluate.`
      );
      return;
    }

    console.log(
      `[dice][AI] Running title filter on ${stagedArray.length} staged roles...`
    );
    await writeSessionRoles(sessionPaths, stagedArray);

    const { removalSet, reasons } = await filterTitlesWithAi(stagedArray);
    if (removalSet.size) {
      console.log("[dice][AI] Title rejections:");
      let rejectIndex = 1;
      for (const row of stagedArray) {
        const key = row.job_id ?? row.url;
        if (!removalSet.has(key)) continue;
        const reason = reasons.get(key) ?? "Marked irrelevant.";
        console.log(
          `[dice][AI][Title Reject #${rejectIndex}] "${row.title}" (${row.location}) – ${reason}`
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
      console.log("[dice] AI filtered out all titles for this session.");
      await writeSessionRoles(sessionPaths, filtered);
      await saveSeenStore(outputPaths.seenFile, seen);
      return;
    }

    await writeSessionRoles(sessionPaths, filtered);
    console.log(
      `[dice][AI] Title filter removed ${
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
      console.log("[dice] No jobs approved after detail evaluation.");
      await saveSeenStore(outputPaths.seenFile, seen);
      return;
    }

    await appendJobRows(outputPaths.csvFile, acceptedRows);
    await saveSeenStore(outputPaths.seenFile, seen);
    console.log(
      `[dice] Accepted ${acceptedRows.length} roles. Output: ${outputPaths.csvFile}`
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
      "[dice] Batch wait disabled; running keyword batches back-to-back."
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
        "[dice] Sleeping 30s before next keyword batch (robots crawl-delay)."
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
    console.log(`[dice][${keyword}] Searching for keyword "${keyword}"`);
    const shouldProceed = await prepareSearchPage(page, site, keyword);
    if (!shouldProceed) {
      console.log(
        `[dice][${keyword}] Skipping keyword "${keyword}" (0 results for Today).`
      );
      return;
    }

    const rows = await collectListingRows(
      page,
      site,
      keyword,
      runDate,
      isBackfill
    );
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
      `[dice] Keyword "${keyword}": scraped ${rows.length}, staged ${added}`
    );
  } catch (error) {
    console.error(`[dice] Failed keyword "${keyword}"`, error);
  } finally {
    await page.close();
  }
}

async function prepareSearchPage(
  page: Page,
  site: SiteConfig,
  keyword: string
): Promise<boolean> {
  await page.goto(site.search.url, { waitUntil: "domcontentloaded" });
  await acceptCookieConsent(page, site.cookieConsent);

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

  await submitButton.click({ delay: 50 });
  await page.waitForLoadState("networkidle").catch(() => undefined);

  // Apply filters
  if (selectors.allFilters) {
    const allFiltersBtn = page.locator(selectors.allFilters).first();
    if (await allFiltersBtn.isVisible()) {
      await allFiltersBtn.click();
      await page.waitForTimeout(3000); // Wait for drawer/modal

      // Posted Date: Today
      if (selectors.postedDateRadio) {
        // Check for "Today (0)" case
        const todayLabel = page
          .locator("label")
          .filter({ hasText: "Today" })
          .first();

        if (await todayLabel.isVisible()) {
          const labelText = await todayLabel.innerText();
          // Check for "Today (0)"
          if (labelText.includes("(0)")) {
            console.log(
              `[dice][${keyword}] "Today" filter shows 0 results: "${labelText}".`
            );
            return false;
          }

          // Click "Today"
          // Try clicking the label as it's often more reliable for custom radios
          await todayLabel.scrollIntoViewIfNeeded();
          await todayLabel.click({ force: true });
          console.log(`[dice][${keyword}] Clicked 'Today' filter.`);
          await page.waitForTimeout(500);
        } else {
          console.warn(`[dice][${keyword}] 'Today' filter label not visible.`);
        }
      }

      // Employment Type: Contract
      if (selectors.employmentTypeCheckbox) {
        await page.waitForTimeout(1000);
        const contractLabel = page
          .locator("label")
          .filter({ hasText: "Contract" })
          .first();

        if (await contractLabel.isVisible()) {
          const labelText = await contractLabel.innerText();
          if (labelText.includes("(0)")) {
            console.log(
              `[dice][${keyword}] "Contract" filter shows 0 results: "${labelText}".`
            );
            return false;
          }
        }

        try {
          await contractLabel.waitFor({ state: "visible", timeout: 5000 });
          await contractLabel.scrollIntoViewIfNeeded();
          await contractLabel.click({ force: true });
          console.log(`[dice][${keyword}] Clicked 'Contract' filter.`);
        } catch (e) {
          console.warn(
            `[dice][${keyword}] Failed to click 'Contract' label.`,
            e
          );
          const contractCheckbox = page
            .locator(selectors.employmentTypeCheckbox)
            .first();
          if (await contractCheckbox.count()) {
            await contractCheckbox
              .click({ force: true })
              .catch((err) =>
                console.warn("Fallback checkbox click failed", err)
              );
          }
        }
      }

      // Apply
      if (selectors.applyFilters) {
        await page.waitForTimeout(2000); // Ensure previous clicks are registered
        const applyBtn = page.locator(selectors.applyFilters).first();
        // Ensure drawer is open
        if (!(await applyBtn.isVisible())) {
          console.log(
            `[dice][${keyword}] Apply button not visible. Re-opening drawer...`
          );
          const allFiltersBtn = page.locator(selectors.allFilters).first();
          await allFiltersBtn.click();
          await page.waitForTimeout(2000);
        }

        await applyBtn.scrollIntoViewIfNeeded();
        // Use evaluate click to avoid viewport issues
        await applyBtn.evaluate((el) => (el as HTMLElement).click());

        // Wait for URL to update with filters
        // Wait for URL to update with filters
        try {
          await page.waitForURL(
            (url) => {
              const s = url.toString();
              // Check for presence of filters, allow CONTRACTS (plural)
              return (
                s.includes("filters.postedDate=ONE") &&
                s.includes("filters.employmentType")
              );
            },
            { timeout: 30000 }
          );
          console.log(
            `[dice][${keyword}] Filters applied successfully (verified via URL).`
          );
        } catch (e) {
          console.warn(
            `[dice][${keyword}] Warning: URL did not update with expected filters within 30s. Checking if Apply button is still visible...`,
            e
          );
          if (await applyBtn.isVisible()) {
            console.log(
              `[dice][${keyword}] Apply button still visible. Clicking again...`
            );
            try {
              await applyBtn.scrollIntoViewIfNeeded();
              await applyBtn.evaluate((el) => (el as HTMLElement).click());
              await page.waitForTimeout(2000);
            } catch (retryErr) {
              console.warn(`[dice][${keyword}] Retry click failed:`, retryErr);
            }
          }
        }

        await page.waitForLoadState("networkidle").catch(() => undefined);
      }
    }
  }

  return true;
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

  // Wait for results
  try {
    await page.waitForSelector(selectors.card, { timeout: 30000 });

    // Retry logic removed as per user request (was causing useless delays)
    // We rely on the card selector wait and the text fallback below.
  } catch {
    console.log(`[dice][${keyword}] No results found for "${keyword}"`);
    return [];
  }

  const rows: JobRow[] = [];
  let pageIndex = 1;

  while (true) {
    // Use evaluate to extract all data at once
    // We pass the selectors object to the browser context
    const rawJobs = await page.evaluate((selectors) => {
      const allMatches = Array.from(document.querySelectorAll(selectors.card!));

      // Filter logic:
      // 1. Identify "candidates" that contain a reasonable number of other matches (e.g. 1-10).
      //    - Excludes the main List (contains too many).
      //    - Excludes leaf fragments (contain 0).
      // 2. From candidates, keep only the outermost ones.

      const candidates = allMatches.filter((el) => {
        const count = allMatches.filter(
          (other) => el !== other && el.contains(other)
        ).length;
        return count > 0;
      });

      // Keep innermost: Filter out elements that contain another candidate
      const cards = candidates.filter(
        (el) => !candidates.some((child) => child !== el && el.contains(child))
      );

      return cards.map((card) => {
        const titleEl = selectors.title
          ? Array.from(card.querySelectorAll(selectors.title)).find(
              (el) =>
                !(el as HTMLElement).innerText.toLowerCase().includes("apply")
            )
          : null;
        const companyEl = selectors.company
          ? card.querySelector(selectors.company)
          : null;
        const locationEl = selectors.locationText
          ? card.querySelector(selectors.locationText)
          : null;
        const postedEl = selectors.posted
          ? card.querySelector(selectors.posted)
          : null;

        const title = titleEl ? (titleEl as HTMLElement).innerText.trim() : "";
        const href = titleEl ? titleEl.getAttribute("href") : "";
        const company = companyEl
          ? (companyEl as HTMLElement).innerText.trim()
          : "";
        let location = locationEl
          ? (locationEl as HTMLElement).innerText.trim()
          : "";
        let posted = postedEl ? (postedEl as HTMLElement).innerText.trim() : "";

        const text = (card as HTMLElement).innerText;

        // Fallback: Check text content if selector failed
        if (!posted) {
          // Check for common patterns in the full text
          if (text.match(/Today/i)) {
            posted = "Today";
          } else if (text.match(/Just now/i)) {
            posted = "Just now";
          } else {
            const agoMatch = text.match(
              /(\d+\s+(?:minute|hour|day|week)s?\s+ago)/i
            );
            if (agoMatch) {
              posted = agoMatch[1];
            }
          }
        }

        // Location fallback
        if (!location && text) {
          // Try to find a pattern like "City, State" or look for text near the date
          // This is heuristic and might need tuning
          const locMatch = text.match(/([A-Z][a-zA-Z\s]+, [A-Z]{2})/);
          if (locMatch) {
            location = locMatch[1];
          }
        }

        return { title, href, company, location, posted, html: card.outerHTML };
      });
    }, selectors);

    console.log(
      `[dice][${keyword}] Found ${rawJobs.length} cards on page ${pageIndex}`
    );

    for (const raw of rawJobs) {
      if (!raw.title || !raw.href) {
        continue;
      }

      // Construct full URL
      // raw.href might be relative or absolute
      const url = new URL(raw.href, site.search.url).toString();

      if (site.disallowPatterns.some((pattern) => url.includes(pattern))) {
        continue;
      }

      const row: JobRow = {
        site: site.key,
        title: raw.title,
        company: raw.company || "Dice",
        location: raw.location,
        posted: raw.posted,
        url: url,
        job_id: extractJobId(raw.href) ?? undefined,
        scraped_at: getEasternTimeLabel(),
      };
      rows.push(row);
    }

    // Check if the last *valid* job is from today
    if (rows.length > 0) {
      // Find the last row that has a non-empty posted date
      const lastValidRow = [...rows]
        .reverse()
        .find((r) => r.posted && r.posted.length > 0);

      if (lastValidRow) {
        if (!isPostedToday(lastValidRow.posted)) {
          console.log(
            `[dice][${keyword}] Last valid job posted "${lastValidRow.posted}" is not from today. Stopping pagination.`
          );
          break;
        }
      } else {
        console.warn(
          `[dice][${keyword}] Warning: All jobs in this batch have empty posted dates. Cannot determine if we should stop. Proceeding...`
        );
      }
    }

    if (pageIndex >= site.run.maxPages) {
      break;
    }

    if (selectors.next) {
      const nextButton = page.locator(selectors.next).first();
      // Check if visible and enabled
      if (await nextButton.isVisible()) {
        await nextButton.click();
        await page.waitForLoadState("networkidle").catch(() => undefined);
        await page.waitForTimeout(2000); // Extra wait for SPA update
      } else {
        break;
      }
    } else {
      break;
    }

    pageIndex += 1;
  }

  return rows;
}

function isPostedToday(postedText: string): boolean {
  const lower = postedText.toLowerCase();
  if (
    lower.includes("hour") ||
    lower.includes("minute") ||
    lower.includes("second") ||
    lower.includes("today") ||
    lower.includes("just now")
  ) {
    return true;
  }
  return false;
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

      // Validate Employment Type if selector is present
      if (site.search.selectors.jobType) {
        const jobTypeElements = page.locator(site.search.selectors.jobType);
        const count = await jobTypeElements.count();
        if (count > 0) {
          // Collect text from ALL job type elements, not just the first one
          const allTexts: string[] = [];
          for (let j = 0; j < count; j++) {
            const text = (await jobTypeElements.nth(j).innerText()) || "";
            if (text.trim()) {
              allTexts.push(text.trim());
            }
          }
          const typeText = allTexts.join(" | ");

          // Strict No-W2/Full Time/Part Time Check: Reject if found in Title, Description, or Type
          const w2Regex = /\bW2\b/i;
          const fullTimeRegex = /Full\s*Time/i;
          const partTimeRegex = /Part\s*Time/i;

          if (
            w2Regex.test(role.title) ||
            w2Regex.test(description) ||
            w2Regex.test(typeText) ||
            fullTimeRegex.test(typeText) ||
            partTimeRegex.test(typeText)
          ) {
            console.log(
              `[dice][${role.keyword}] Rejected "${role.title}" (${role.location}) – Reason: "W2", "Full Time", or "Part Time" found.`
            );
            rejectedLogger.log({
              title: role.title,
              site: site.key,
              url: role.url,
              jd: description,
              reason: `"W2", "Full Time", or "Part Time" found in job details.`,
              scraped_at: role.scraped_at,
              type: "detail",
            });
            // Add rejected job to seen so it's skipped in future sessions
            const jobKey = computeJobKey(role);
            seen.add(jobKey);
            continue;
          }

          // Strict C2C Check: Must contain "Corp-to-Corp", "Corp To Corp", or "C2C"
          const hasC2C =
            typeText.match(/Corp-to-Corp/i) ||
            typeText.match(/Corp To Corp/i) ||
            typeText.match(/C2C/i);

          if (!hasC2C) {
            console.log(
              `[dice][${role.keyword}] Rejected "${role.title}" (${role.location}) – Reason: Employment type "${typeText}" does not include C2C.`
            );
            rejectedLogger.log({
              title: role.title,
              site: site.key,
              url: role.url,
              jd: description,
              reason: `Employment type "${typeText}" does not include C2C.`,
              scraped_at: role.scraped_at,
              type: "detail",
            });
            // Add rejected job to seen so it's skipped in future sessions
            const jobKey = computeJobKey(role);
            seen.add(jobKey);
            continue;
          }
        }
      }

      // Validate Posted Date if selector is present
      if (site.search.selectors.postedDateDetail) {
        const postedDateEl = page
          .locator(site.search.selectors.postedDateDetail)
          .first();
        if (await postedDateEl.isVisible()) {
          const text = (await postedDateEl.innerText()) || "";

          // Parse "Posted X days ago"
          const postedMatch = text.match(/Posted\s+(\d+)\s+days?\s+ago/i);
          const postedDaysAgo = postedMatch ? parseInt(postedMatch[1], 10) : 0; // Default to 0 (today) if not found or "moments ago"

          // Parse "Updated X days ago" or "Updated X hours ago"
          // "Updated 2 hours ago", "Updated moments ago", "Updated 1 day ago"
          let updatedDaysAgo = -1; // -1 means not updated or not found

          if (text.toLowerCase().includes("updated")) {
            if (
              text.match(/updated\s+moments\s+ago/i) ||
              text.match(/updated\s+just\s+now/i) ||
              text.match(/updated\s+\d+\s+hours?\s+ago/i) ||
              text.match(/updated\s+\d+\s+minutes?\s+ago/i)
            ) {
              updatedDaysAgo = 0;
            } else {
              const updatedMatch = text.match(/updated\s+(\d+)\s+days?\s+ago/i);
              if (updatedMatch) {
                updatedDaysAgo = parseInt(updatedMatch[1], 10);
              }
            }
          }

          // Logic:
          // 1. If Posted > 15 days -> REJECT
          if (postedDaysAgo > 15) {
            console.log(
              `[dice][${role.keyword}] Rejected "${role.title}" (${role.location}) – Reason: Posted ${postedDaysAgo} days ago (> 15 days).`
            );
            rejectedLogger.log({
              title: role.title,
              site: site.key,
              url: role.url,
              jd: description,
              reason: `Posted ${postedDaysAgo} days ago (> 15 days).`,
              scraped_at: role.scraped_at,
              type: "detail",
            });
            // Add rejected job to seen so it's skipped in future sessions
            const jobKey = computeJobKey(role);
            seen.add(jobKey);
            continue;
          }

          // 2. If Posted > 1 day (i.e., 2 days or more)
          if (postedDaysAgo > 1) {
            // MUST be updated recently (<= 1 day)
            const isUpdatedRecently =
              updatedDaysAgo !== -1 && updatedDaysAgo <= 1;

            if (!isUpdatedRecently) {
              console.log(
                `[dice] Rejected "${role.title}" (${
                  role.location
                }) – Reason: Posted ${postedDaysAgo} days ago and not updated recently (Updated: ${
                  updatedDaysAgo === -1 ? "Never" : updatedDaysAgo + " days ago"
                }).`
              );
              rejectedLogger.log({
                title: role.title,
                site: site.key,
                url: role.url,
                jd: description,
                reason: `Posted ${postedDaysAgo} days ago and not updated recently`,
                scraped_at: role.scraped_at,
                type: "detail",
              });
              // Add rejected job to seen so it's skipped in future sessions
              const jobKey = computeJobKey(role);
              seen.add(jobKey);
              continue;
            }
          }

          // If Posted <= 1 day, we accept (it's recent enough)
        }
      }

      console.log(
        `[dice][AI] Detail candidate #${i + 1}/${roles.length} "${
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
          `[dice][AI] Rejected "${role.title}" (${role.location}) – Reason: ${
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
      console.error(`[dice] Failed to evaluate detail for ${role.url}`, error);
    } finally {
      await page.close();
    }
  }

  console.log(
    `[dice][AI] Detail evaluation accepted ${accepted.length} roles out of ${roles.length}.`
  );
  return accepted;
}

export async function extractDescription(
  page: Page,
  site: SiteConfig
): Promise<string> {
  const selector =
    site.search.selectors.description || "div[data-cy='job-description']";
  const locator = page.locator(selector).first();
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
  // Example: /job-detail/00000000-0000-0000-0000-000000000000/12345678-1234-1234-1234-123456789012
  // Or just the last part?
  // Dice IDs are usually UUIDs in the URL.
  const match = href.match(/\/job-detail\/([^/]+)\/([^/?]+)/);
  if (match) {
    return match[2]; // The second UUID is usually the specific job ID
  }
  const simpleMatch = href.match(/\/job-detail\/([^/?]+)/);
  return simpleMatch ? simpleMatch[1] : null;
}

function createSessionId(): string {
  return `session_${Date.now()}`;
}
