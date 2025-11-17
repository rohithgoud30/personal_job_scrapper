import fs from 'fs';
import path from 'path';
import { BrowserContext, Locator, Page, chromium } from 'playwright';
import { OutputConfig, SiteConfig } from '../../lib/config';
import { acceptCookieConsent } from '../../lib/cookies';
import { appendJobRows, JobRow } from '../../lib/csv';
import { computeJobKey, loadSeenStore, saveSeenStore } from '../../lib/dedupe';
import { buildOutputPaths, buildSessionPaths, ensureDirectoryExists, SessionPaths } from '../../lib/paths';
import { getEasternDateLabel, getEasternTimeLabel } from '../../lib/time';
import { env } from '../../lib/env';
import { evaluateJobDetail, findIrrelevantJobIds, TitleEntry } from '../../lib/aiEvaluator';

const FALLBACK_SELECTORS = {
  keywords: "input[placeholder='Search by Job Title or Skill']",
  card: '.data-jobs li',
  submit: '.submitIcon',
  next: '.data-job-pagination .btn-line-darkCerulean'
};

interface SessionRole extends JobRow {
  session_id: string;
  keyword: string;
}

export async function runKforceSite(site: SiteConfig, output: OutputConfig): Promise<void> {
  const keywords = normalizeKeywords(site.search.criteria.searchKeywords);
  if (!keywords.length) {
    console.warn('[kforce] No keywords configured. Skipping run.');
    return;
  }

  const outputPaths = buildOutputPaths(output, site);
  const sessionId = createSessionId();
  const sessionPaths = buildSessionPaths(outputPaths, sessionId);
  await ensureDirectoryExists(sessionPaths.rolesDir);

  const seen = await loadSeenStore(outputPaths.seenFile);
  const staged = new Map<string, SessionRole>();

  const userDataDir = path.resolve(site.userDataDir);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 800 }
  });

  try {
    await scrapeKeywordsInBatches(context, site, keywords, seen, staged, sessionId);

    if (!staged.size) {
      console.log('[kforce] No new roles detected for this session.');
      return;
    }

    await writeSessionRoles(sessionPaths, Array.from(staged.values()));

    const removalSet = await filterTitlesWithAi(Array.from(staged.values()));
    const filtered = Array.from(staged.values()).filter((row) => !removalSet.has(row.job_id ?? row.url));
    if (!filtered.length) {
      console.log('[kforce] AI filtered out all titles for this session.');
      await writeSessionRoles(sessionPaths, filtered);
      return;
    }

    await writeSessionRoles(sessionPaths, filtered);

    const acceptedRows = await evaluateDetailedJobs(context, filtered, seen);
    if (!acceptedRows.length) {
      console.log('[kforce] No jobs approved after detail evaluation.');
      return;
    }

    await appendJobRows(outputPaths.csvFile, acceptedRows);
    await saveSeenStore(outputPaths.seenFile, seen);
    console.log(`[kforce] Accepted ${acceptedRows.length} roles. Output: ${outputPaths.csvFile}`);
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
  sessionId: string
): Promise<void> {
  const batchSize = env.keywordBatchSize;
  for (let i = 0; i < keywords.length; i += batchSize) {
    const batch = keywords.slice(i, i + batchSize);
    await Promise.all(
      batch.map((keyword) => scrapeKeywordInNewPage(context, site, keyword, seen, staged, sessionId))
    );
  }
}

async function scrapeKeywordInNewPage(
  context: BrowserContext,
  site: SiteConfig,
  keyword: string,
  seen: Set<string>,
  staged: Map<string, SessionRole>,
  sessionId: string
): Promise<void> {
  const page = await context.newPage();
  try {
    console.log(`[kforce] Searching for keyword "${keyword}"`);
    await prepareSearchPage(page, site);
    const rows = await scrapeKeyword(page, site, keyword);
    let added = 0;
    for (const row of rows) {
      const jobKey = computeJobKey(row);
      if (seen.has(jobKey) || staged.has(jobKey)) {
        continue;
      }
      staged.set(jobKey, {
        ...row,
        session_id: sessionId,
        keyword
      });
      added += 1;
    }
    console.log(`[kforce] Keyword "${keyword}": scraped ${rows.length}, staged ${added}`);
  } catch (error) {
    console.error(`[kforce] Failed keyword "${keyword}"`, error);
  } finally {
    await page.close();
  }
}

async function prepareSearchPage(page: Page, site: SiteConfig): Promise<void> {
  await page.goto(site.search.url, { waitUntil: 'domcontentloaded' });
  await acceptCookieConsent(page, site.cookieConsent);
  await ensureJobTypeFacet(page, site);
  await ensureNewestSort(page, site.search.selectors);
}

async function scrapeKeyword(page: Page, site: SiteConfig, keyword: string): Promise<JobRow[]> {
  const selectors = site.search.selectors;
  const keywordSelector = selectors.keywords ?? FALLBACK_SELECTORS.keywords;
  const keywordInput = page.locator(keywordSelector).first();

  if ((await keywordInput.count()) === 0) {
    throw new Error(`Keyword input not found using selector ${keywordSelector}`);
  }

  await keywordInput.fill('');
  await keywordInput.type(keyword, { delay: 20 });

  if (selectors.location && site.search.criteria.location) {
    await fillLocation(page, selectors.location, site.search.criteria.location);
  }

  const submitSelector = selectors.submit ?? FALLBACK_SELECTORS.submit;
  const submitButton = page.locator(submitSelector).first();
  if ((await submitButton.count()) === 0) {
    throw new Error(`Submit button not found using selector ${submitSelector}`);
  }

  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => undefined),
    submitButton.click({ delay: 50 })
  ]);

  const cardSelector = selectors.card ?? FALLBACK_SELECTORS.card;
  await page.waitForFunction(
    ({ selector }) => document.querySelectorAll(selector).length > 0,
    { selector: cardSelector },
    { timeout: 60000 }
  );

  await ensureNewestSort(page, selectors);
  return collectListingRows(page, site, keyword);
}

async function collectListingRows(page: Page, site: SiteConfig, keyword: string): Promise<JobRow[]> {
  const selectors = site.search.selectors;
  const cardSelector = selectors.card ?? FALLBACK_SELECTORS.card;
  const cards = page.locator(cardSelector);
  const rows: JobRow[] = [];
  let processedCount = 0;
  let pageIndex = 1;

  while (true) {
    let pageHasToday = !site.search.postedTodayOnly;
    const totalCards = await cards.count();
    for (let index = processedCount; index < totalCards; index += 1) {
      const card = cards.nth(index);
      const row = await extractJobRow(card, site);
      if (!row) {
        continue;
      }

      if (site.search.postedTodayOnly && !isPostedToday(row.posted)) {
        continue;
      }

      pageHasToday = true;
      rows.push(row);
    }

    if (site.search.postedTodayOnly && !pageHasToday) {
      console.log(
        `[kforce] No results dated today on page ${pageIndex}. Skipping pagination for keyword "${keyword}".`
      );
      break;
    }

    processedCount = totalCards;
    if (pageIndex >= site.run.maxPages) {
      break;
    }

    const nextSelector = selectors.next ?? FALLBACK_SELECTORS.next;
    const nextButton = page.locator(nextSelector).first();
    const canLoadMore = await nextButton.isVisible();
    if (!canLoadMore) {
      break;
    }

    await nextButton.click();
    await page
      .waitForFunction(
        ({ selector, previousCount }) => document.querySelectorAll(selector).length > previousCount,
        { selector: cardSelector, previousCount: processedCount },
        { timeout: 60000 }
      )
      .catch(() => {
        console.warn('[kforce] Load more button did not increase job count within timeout.');
      });

    pageIndex += 1;
  }

  return rows;
}

async function evaluateDetailedJobs(
  context: BrowserContext,
  roles: SessionRole[],
  seen: Set<string>
): Promise<JobRow[]> {
  const accepted: JobRow[] = [];
  for (const role of roles) {
    const page = await context.newPage();
    try {
      await page.goto(role.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const description = await extractDescription(page);
      const acceptedByAi = await evaluateJobDetail({
        title: role.title,
        company: role.company,
        location: role.location,
        url: role.url,
        description
      });

      if (!acceptedByAi) {
        continue;
      }

      const jobKey = computeJobKey(role);
      if (seen.has(jobKey)) {
        continue;
      }

      seen.add(jobKey);
      accepted.push(role);
    } catch (error) {
      console.error(`[kforce] Failed to evaluate detail for ${role.url}`, error);
    } finally {
      await page.close();
    }
  }

  return accepted;
}

async function extractDescription(page: Page): Promise<string> {
  const selectors = ['main', '.job-detail', '.jobDescription', 'body'];
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

async function filterTitlesWithAi(rows: SessionRole[]): Promise<Set<string>> {
  const entries: TitleEntry[] = rows.map((row) => ({
    title: row.title,
    company: row.company,
    location: row.location,
    url: row.url,
    job_id: row.job_id ?? row.url
  }));
  return findIrrelevantJobIds(entries);
}

async function writeSessionRoles(sessionPaths: SessionPaths, rows: SessionRole[]): Promise<void> {
  const headers = ['session_id', 'keyword', 'site', 'title', 'company', 'location', 'posted', 'url', 'job_id', 'scraped_at'];
  const lines = rows.map((row) => [
    row.session_id,
    row.keyword,
    row.site,
    escapeCsv(row.title),
    escapeCsv(row.company),
    escapeCsv(row.location),
    escapeCsv(row.posted),
    row.url,
    row.job_id ?? '',
    row.scraped_at
  ].join(','));

  const payload = [headers.join(','), ...lines].join('\n') + '\n';
  await ensureDirectoryExists(sessionPaths.rolesDir);
  await fs.promises.writeFile(sessionPaths.rolesFile, payload, 'utf-8');
}

function escapeCsv(value: string): string {
  if (!value) {
    return '';
  }
  if (!value.includes(',')) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

async function ensureJobTypeFacet(page: Page, site: SiteConfig): Promise<void> {
  const filters = site.search.jobTypeFilter;
  const facetSelector = site.search.selectors.jobTypeFacetOption;
  if (!filters || !filters.length || !facetSelector) {
    return;
  }

  const targetLabel = site.search.selectors.jobTypeFacetText ?? filters[0];
  const option = page.locator(facetSelector).filter({ hasText: buildTextMatcher(targetLabel) }).first();

  try {
    await option.waitFor({ state: 'visible', timeout: 10000 });
  } catch (error) {
    console.warn(`[kforce] Job type facet option "${targetLabel}" not found.`, error);
    return;
  }

  if (await isFacetSelected(option)) {
    return;
  }

  await option.click();
  await page.waitForLoadState('networkidle').catch(() => undefined);
}

async function isFacetSelected(option: Locator): Promise<boolean> {
  return option.evaluate((node) => {
    const classAttr = (node.getAttribute('class') || '').toLowerCase();
    if (classAttr.includes('active') || classAttr.includes('selected') || classAttr.includes('checked')) {
      return true;
    }

    const checkbox = node.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    if (checkbox && checkbox.checked) {
      return true;
    }

    const ariaChecked = node.getAttribute('aria-checked');
    if (ariaChecked && ariaChecked.toLowerCase() === 'true') {
      return true;
    }

    return false;
  });
}

async function ensureNewestSort(page: Page, selectors: SiteConfig['search']['selectors']): Promise<void> {
  const { sortToggle, sortOptionText } = selectors;
  if (!sortToggle || !sortOptionText) {
    return;
  }

  const currentLabelSelector = selectors.sortValueLabel;
  if (currentLabelSelector) {
    const currentLabel = page.locator(currentLabelSelector).first();
    if ((await currentLabel.count()) > 0) {
      const currentText = (await currentLabel.innerText().catch(() => '')).trim();
      if (normalizeString(currentText) === normalizeString(sortOptionText)) {
        return;
      }
    }
  }

  const toggle = page.locator(sortToggle).first();
  if ((await toggle.count()) === 0) {
    console.warn(`[kforce] Sort toggle not found using selector ${sortToggle}`);
    return;
  }

  await toggle.click();

  const optionSelector = selectors.sortOption ?? '.Select-option';
  const option = page
    .locator(optionSelector)
    .filter({ hasText: buildTextMatcher(sortOptionText) })
    .first();

  try {
    await option.waitFor({ state: 'visible', timeout: 5000 });
  } catch (error) {
    console.warn(`[kforce] Sort option "${sortOptionText}" did not appear.`, error);
    return;
  }

  await option.click();
  await page.waitForLoadState('networkidle').catch(() => undefined);
}

async function fillLocation(page: Page, selector: string, value: string): Promise<void> {
  const locationInput = page.locator(selector).first();
  if ((await locationInput.count()) === 0) {
    console.warn(`[kforce] Location input not found for selector ${selector}`);
    return;
  }

  await locationInput.click();
  await page.keyboard.press('Meta+a').catch(() => page.keyboard.press('Control+a'));
  await page.keyboard.press('Backspace');
  await locationInput.type(value, { delay: 30 });
  await page.keyboard.press('Enter');
}

function extractJobId(href: string): string | null {
  const match = href.match(/detail\/([^/]+)/i);
  return match ? match[1] : null;
}

async function extractJobRow(card: Locator, site: SiteConfig): Promise<JobRow | null> {
  const selectors = site.search.selectors;
  const titleSelector = selectors.title ?? 'h2 a';
  const titleLink = card.locator(titleSelector).first();

  if ((await titleLink.count()) === 0) {
    return null;
  }

  const rawTitle = (await titleLink.innerText()).trim();
  const href = (await titleLink.getAttribute('href')) ?? '';
  const url = new URL(href, site.search.url).toString();
  if (site.disallowPatterns.some((pattern) => url.includes(pattern))) {
    return null;
  }

  const locationText = selectors.locationText
    ? (await card.locator(selectors.locationText).first().innerText().catch(() => '')).trim()
    : '';
  const postedText = selectors.posted
    ? (await card.locator(selectors.posted).first().innerText().catch(() => '')).trim()
    : '';

  return {
    site: site.key,
    title: rawTitle,
    company: 'Kforce',
    location: locationText,
    posted: postedText,
    url,
    job_id: extractJobId(href) ?? undefined,
    scraped_at: getEasternTimeLabel()
  };
}

function normalizeKeywords(raw: string | string[]): string[] {
  const candidates = Array.isArray(raw) ? raw : [raw];
  return Array.from(new Set(candidates.map((keyword) => keyword.trim()).filter(Boolean)));
}

function isPostedToday(posted: string): boolean {
  const normalized = normalizeDate(posted);
  if (!normalized) {
    return false;
  }

  const today = getEasternDateLabel();
  return normalized === today;
}

function normalizeDate(input: string): string | null {
  const match = input.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) {
    return null;
  }

  const [, rawMonth, rawDay, year] = match;
  return `${rawMonth.padStart(2, '0')}/${rawDay.padStart(2, '0')}/${year}`;
}

function normalizeString(value: string): string {
  return value.trim().toLowerCase();
}

function buildTextMatcher(input: string): RegExp {
  const escaped = input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'i');
}

function createSessionId(): string {
  return `session-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}
