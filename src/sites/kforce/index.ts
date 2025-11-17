import path from 'path';
import { BrowserContext, Locator, Page, chromium } from 'playwright';
import { OutputConfig, SearchSelectors, SiteConfig } from '../../lib/config';
import { acceptCookieConsent } from '../../lib/cookies';
import { appendJobRows, JobRow } from '../../lib/csv';
import { filterNewRows, loadSeenStore, saveSeenStore } from '../../lib/dedupe';
import { buildOutputPaths } from '../../lib/paths';
import { sleep } from '../../lib/throttle';
import { getEasternDateLabel, getEasternTimeLabel } from '../../lib/time';

const FALLBACK_SELECTORS = {
  keywords: "input[placeholder='Search by Job Title or Skill']",
  card: '.data-jobs li',
  submit: '.submitIcon',
  next: '.data-job-pagination .btn-line-darkCerulean'
};

export async function runKforceSite(site: SiteConfig, output: OutputConfig): Promise<void> {
  const keywords = normalizeKeywords(site.search.criteria.searchKeywords);
  if (!keywords.length) {
    console.warn('[kforce] No keywords configured. Skipping run.');
    return;
  }

  const outputPaths = buildOutputPaths(output, site);
  const seen = await loadSeenStore(outputPaths.seenFile);

  let context: BrowserContext | null = null;
  try {
    const userDataDir = path.resolve(site.userDataDir);
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      viewport: { width: 1280, height: 800 }
    });

    const page = context.pages()[0] ?? (await context.newPage());
    await page.bringToFront();

    console.log(`[kforce] Navigating to ${site.search.url}`);
    await page.goto(site.search.url, { waitUntil: 'domcontentloaded' });
    await acceptCookieConsent(page, site.cookieConsent);
    await ensureJobTypeFacet(page, site);
    await ensureInitialSort(page, site.search.selectors);

    const keywordSelector = site.search.selectors.keywords ?? FALLBACK_SELECTORS.keywords;
    await page.waitForSelector(keywordSelector, { timeout: 45000 });

    let totalScraped = 0;
    let totalNew = 0;
    const pendingRows: JobRow[] = [];

    for (const keyword of keywords) {
      console.log(`[kforce] Searching for keyword "${keyword}"`);
      let rows: JobRow[] = [];
      try {
        rows = await scrapeKeyword(page, site, keyword);
        totalScraped += rows.length;
        const newRows = filterNewRows(rows, seen);

        if (newRows.length) {
          await saveSeenStore(outputPaths.seenFile, seen);
          totalNew += newRows.length;
          for (const row of newRows) {
            pendingRows.unshift(row);
          }
        }

        console.log(
          `[kforce] Keyword "${keyword}": scraped ${rows.length}, new ${newRows.length}, cumulative new ${totalNew}`
        );
      } catch (error) {
        console.error(`[kforce] Failed to scrape keyword "${keyword}"`, error);
      }

      if (
        site.run.keywordDelaySeconds &&
        site.run.keywordDelaySeconds > 0 &&
        rows.length > 0
      ) {
        console.log(`[kforce] Waiting ${site.run.keywordDelaySeconds}s before next keyword...`);
        await sleep(site.run.keywordDelaySeconds);
      }
    }

    if (pendingRows.length) {
      await appendJobRows(outputPaths.csvFile, pendingRows);
    }

    console.log(
      `[kforce] Completed run. Total scraped: ${totalScraped}, total new: ${totalNew}. Output: ${outputPaths.csvFile}`
    );
  } finally {
    if (context) {
      await context.close();
    }
  }
}

async function scrapeKeyword(page: Page, site: SiteConfig, keyword: string): Promise<JobRow[]> {
  const selectors = site.search.selectors;
  const keywordSelector = selectors.keywords ?? FALLBACK_SELECTORS.keywords;
  const keywordInput = page.locator(keywordSelector).first();

  if ((await keywordInput.count()) === 0) {
    throw new Error(`Keyword input not found using selector ${keywordSelector}`);
  }

  await keywordInput.fill('');
  await keywordInput.type(keyword, { delay: 35 });

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

  if (site.run.throttleSeconds > 0) {
    await sleep(site.run.throttleSeconds);
  }

  const cardSelector = selectors.card ?? FALLBACK_SELECTORS.card;
  await page.waitForFunction(
    ({ selector }) => document.querySelectorAll(selector).length > 0,
    { selector: cardSelector },
    { timeout: 60000 }
  );

  const sortApplied = await ensureNewestSort(page, selectors);
  if (sortApplied) {
    await page.waitForLoadState('networkidle').catch(() => undefined);
  }

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

    console.log(`[kforce] Loading additional results (page ${pageIndex + 1}) for keyword "${keyword}"`);
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
    if (site.run.pageDelaySeconds > 0) {
      await sleep(site.run.pageDelaySeconds);
    }
  }

  return rows;
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
    console.log(`[kforce] Skipping disallowed URL ${url}`);
    return null;
  }

  const locationText = selectors.locationText
    ? (await card.locator(selectors.locationText).first().innerText().catch(() => '')).trim()
    : '';
  const jobTypeText = selectors.jobType
    ? (await card.locator(selectors.jobType).first().innerText().catch(() => '')).trim()
    : '';

  if (site.search.jobTypeFilter?.length) {
    if (!jobTypeMatches(jobTypeText, site.search.jobTypeFilter)) {
      return null;
    }
  }
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

async function ensureNewestSort(page: Page, selectors: SearchSelectors): Promise<boolean> {
  const { sortToggle, sortOptionText } = selectors;
  if (!sortToggle || !sortOptionText) {
    return false;
  }

  const currentLabelSelector = selectors.sortValueLabel;
  if (currentLabelSelector) {
    const currentLabel = page.locator(currentLabelSelector).first();
    if ((await currentLabel.count()) > 0) {
      const currentText = (await currentLabel.innerText().catch(() => '')).trim();
      if (normalizeString(currentText) === normalizeString(sortOptionText)) {
        return false;
      }
    }
  }

  const toggle = page.locator(sortToggle).first();
  if ((await toggle.count()) === 0) {
    console.warn(`[kforce] Sort toggle not found using selector ${sortToggle}`);
    return false;
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
    return false;
  }

  await option.click();
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(500);
  return true;
}

function normalizeString(value: string): string {
  return value.trim().toLowerCase();
}

function buildTextMatcher(input: string): RegExp {
  const escaped = input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'i');
}

function jobTypeMatches(value: string, filters: string[]): boolean {
  if (!value) {
    return false;
  }
  const normalizedValue = normalizeString(value);
  return filters.some((filter) => normalizeString(filter) === normalizedValue);
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
  await page.waitForTimeout(500);
}

async function isFacetSelected(option: Locator): Promise<boolean> {
  return option.evaluate((node) => {
    const classAttr = (node.getAttribute('class') || '').toLowerCase();
    if (classAttr.includes('active') || classAttr.includes('selected') || classAttr.includes('checked')) {
      return true;
    }

    const checkbox = node.querySelector('input[type=\"checkbox\"]') as HTMLInputElement | null;
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

async function ensureInitialSort(page: Page, selectors: SearchSelectors): Promise<void> {
  const cardSelector = selectors.card ?? FALLBACK_SELECTORS.card;
  try {
    await page.waitForSelector(cardSelector, { timeout: 15000 });
  } catch (error) {
    console.warn('[kforce] Initial job cards not ready for sorting.', error);
    return;
  }

  await ensureNewestSort(page, selectors);
}
