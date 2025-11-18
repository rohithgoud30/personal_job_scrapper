import fs from 'fs';
import path from 'path';
import { BrowserContext, Locator, Page, chromium } from 'playwright';
import { OutputConfig, SiteConfig } from '../../lib/config';
import { acceptCookieConsent } from '../../lib/cookies';
import { appendJobRows, JobRow } from '../../lib/csv';
import { computeJobKey, loadSeenStore, saveSeenStore } from '../../lib/dedupe';
import { buildOutputPaths, buildSessionPaths, ensureDirectoryExists, OutputPaths, SessionPaths } from '../../lib/paths';
import { findSessionById, parseDateFolderLabel, readSessionCsv } from '../../lib/session';
import { getEasternDateLabel, getEasternTimeLabel } from '../../lib/time';
import { env, getRunDateOverride } from '../../lib/env';
import { sleep } from '../../lib/throttle';
import { evaluateJobDetail, findIrrelevantJobIds, TitleEntry, TitleFilterResult } from '../../lib/aiEvaluator';
import { RunOptions } from '../types';

interface SessionRole extends JobRow {
  session_id: string;
  keyword: string;
}

type RouteHit = {
  id?: string;
  title?: string;
  shortLocation?: string;
  location?: string | { city?: string; state?: string; stateAbbreviation?: string };
  city?: string;
  postedDate?: string;
  jobType?: string;
  url?: string;
  detailsUrl?: string;
  employmentType?: string;
  employmentTypes?: string[];
  createdDate?: number | string;
  startDate?: number | string;
  launchDate?: number | string;
};

export async function runRandstadSite(
  site: SiteConfig,
  output: OutputConfig,
  options: RunOptions = {}
): Promise<void> {
  const resumeSessionId = options.resumeSessionId?.trim();
  const skipBatchDelay = Boolean(options.skipBatchPause);
  const keywords = normalizeKeywords(site.search.criteria.searchKeywords);
  if (!resumeSessionId && !keywords.length) {
    console.warn('[randstad] No keywords configured. Skipping run.');
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
        `[randstad] Session ${resumeSessionId} not found under ${path.join(output.root, site.host)}.`
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
      scraped_at: row.scraped_at
    }));

    const parsedDate = parseDateFolderLabel(outputPaths.dateFolder);
    if (parsedDate) {
      runDate = parsedDate;
      isBackfill = false;
    }

    console.log(
      `[randstad] Resuming AI-only run for session ${resumeSessionId} (date folder ${outputPaths.dateFolder}).`
    );
  } else {
    const dateLabel = getEasternDateLabel(runDate);
    console.log(`[randstad] ${isBackfill ? 'Backfill' : 'Live'} run using date ${dateLabel}.`);

    outputPaths = buildOutputPaths(output, site, runDate);
    const sessionId = createSessionId();
    sessionPaths = buildSessionPaths(outputPaths, sessionId);
    await ensureDirectoryExists(sessionPaths.rolesDir);
  }

  const seen = await loadSeenStore(outputPaths.seenFile);
  const userDataDir = path.resolve(site.userDataDir);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 800 }
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
        console.log('[randstad] No new roles detected for this session.');
        return;
      }

      stagedArray = Array.from(staged.values());
    } else if (!stagedArray.length) {
      console.log(`[randstad] Session ${resumeSessionId} has no staged roles to evaluate.`);
      return;
    }

    console.log(`[randstad][AI] Running title filter on ${stagedArray.length} staged roles...`);
    await writeSessionRoles(sessionPaths, stagedArray);

    const { removalSet, reasons } = await filterTitlesWithAi(stagedArray);

    const filtered = stagedArray.filter((row) => !removalSet.has(row.job_id ?? row.url));
    if (removalSet.size) {
      console.log('[randstad][AI] Title rejections:');
      let rejectIndex = 1;
      for (const row of stagedArray) {
        const key = row.job_id ?? row.url;
        if (!removalSet.has(key)) continue;
        const reason = reasons.get(key) ?? 'Marked irrelevant.';
        console.log(`[randstad][AI][Title Reject #${rejectIndex}] "${row.title}" (${row.location}) – ${reason}`);
        rejectIndex += 1;
      }
    }

    if (!filtered.length) {
      console.log('[randstad] AI filtered out all titles for this session.');
      await writeSessionRoles(sessionPaths, filtered);
      return;
    }

    await writeSessionRoles(sessionPaths, filtered);
    console.log(
      `[randstad][AI] Title filter removed ${stagedArray.length - filtered.length} roles. ${filtered.length} remain for detail evaluation.`
    );

    const acceptedRows = await evaluateDetailedJobs(context, filtered, seen);
    if (!acceptedRows.length) {
      console.log('[randstad] No jobs approved after detail evaluation.');
      return;
    }

    await appendJobRows(outputPaths.csvFile, acceptedRows);
    await saveSeenStore(outputPaths.seenFile, seen);
    console.log(`[randstad] Accepted ${acceptedRows.length} roles. Output: ${outputPaths.csvFile}`);
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
    console.log('[randstad] Batch wait disabled; running keyword batches back-to-back.');
  }

  for (let i = 0; i < keywords.length; i += batchSize) {
    const batch = keywords.slice(i, i + batchSize);
    await Promise.all(
      batch.map((keyword) =>
        scrapeKeywordInNewPage(context, site, keyword, seen, staged, sessionId, runDate, isBackfill)
      )
    );

    const hasMoreBatches = i + batchSize < keywords.length;
    if (!isBackfill && hasMoreBatches && !skipBatchDelay) {
      console.log('[randstad] Sleeping 25s before next keyword batch (polite crawl).');
      await sleep(25);
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
    console.log(`[randstad] Searching for keyword "${keyword}"`);
    await prepareSearchPage(page, site, keyword);

    const roles = await collectRolesWithLoadMore(page, site, runDate);
    let added = 0;
    for (const role of roles) {
      const jobKey = computeJobKey(role);
      if (seen.has(jobKey) || staged.has(jobKey)) {
        continue;
      }
      staged.set(jobKey, {
        ...role,
        session_id: sessionId,
        keyword
      });
      added += 1;
    }
    console.log(`[randstad] Keyword "${keyword}": scraped ${roles.length}, staged ${added}`);
  } catch (error) {
    console.error(`[randstad] Failed keyword "${keyword}"`, error);
  } finally {
    await page.close();
  }
}

async function prepareSearchPage(page: Page, site: SiteConfig, keyword: string): Promise<void> {
  const base = new URL(site.search.url);
  const slug = keyword
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'jobs';
  const searchUrl = `${base.origin}/jobs/q-${slug}/`;

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
  await acceptCookieConsent(page, site.cookieConsent);
  await applyContractFilter(page);
  await ensureDateSort(page, site.search.selectors);
}

async function collectRolesWithLoadMore(page: Page, site: SiteConfig, runDate: Date): Promise<JobRow[]> {
  const roles: JobRow[] = [];
  const maxLoads = Math.max(1, site.run.maxPages);
  const todayLabel = getEasternDateLabel(runDate);
  const requireToday = Boolean(site.search.postedTodayOnly);

  let attempts = 0;
  let lastCount = 0;
  while (true) {
    const hits = await extractHits(page);
    const domRows = await extractDomRows(page, site);
    const mapped = hits
      .map((hit) => mapHitToJobRow(hit, site, runDate))
      .filter((row): row is JobRow => Boolean(row))
      .map((row) => applyPostedDateFilter(row, runDate, todayLabel, requireToday))
      .filter((row): row is JobRow => Boolean(row));
    const combined = [
      ...mapped,
      ...domRows
        .map((row) => applyPostedDateFilter(row, runDate, todayLabel, requireToday))
        .filter((row): row is JobRow => Boolean(row))
    ];

    const hasToday = combined.some((row) => row.posted === todayLabel);
    if (requireToday && !hasToday) {
      console.log('[randstad] No results dated today on this page; stopping pagination.');
      break;
    }

    const unique = combined.filter((row) => !roles.some((r) => r.url === row.url));
    roles.push(...unique);

    attempts += 1;
    if (attempts >= maxLoads) {
      break;
    }

    const before = hits.length || domRows.length;
    const loaded = await loadMore(page, before);
    if (!loaded) {
      break;
    }

    await page.waitForTimeout(site.run.pageDelaySeconds * 1000).catch(() => undefined);

    const afterHits = await extractHits(page);
    const afterDom = await extractDomRows(page, site);
    const nextCount = afterHits.length || afterDom.length;
    if (nextCount <= lastCount) {
      break;
    }
    lastCount = nextCount;
  }

  return roles;
}

async function loadMore(page: Page, previousCount: number): Promise<boolean> {
  const loadMoreSelector = [
    'button:has-text("view more")',
    'button:has-text("view")',
    'button:has-text("more")',
    'button.show-more',
    'button[data-testid*="view-more"]'
  ].join(', ');

  const button = page.locator(loadMoreSelector).first();
  if ((await button.count()) === 0 || !(await button.isVisible().catch(() => false))) {
    return false;
  }

  try {
    await button.click({ delay: 30 });
  } catch (error) {
    console.warn('[randstad] Load more click failed once.', error);
    return false;
  }

  try {
    await page.waitForFunction(
      ({ count }) => {
        const data = (window as any).__ROUTE_DATA__;
        if (!data?.searchResults?.hits) return false;
        return Array.isArray(data.searchResults.hits) && data.searchResults.hits.length > count;
      },
      { count: previousCount },
      { timeout: 12000 }
    );
    return true;
  } catch {
    console.warn('[randstad] Load more did not increase hit count; stopping pagination.');
    return false;
  }
}

async function extractHits(page: Page): Promise<RouteHit[]> {
  const result = await page
    .waitForFunction(
      () => {
        const data = (window as any).__ROUTE_DATA__;
        if (data?.searchResults?.hits && Array.isArray(data.searchResults.hits)) {
          return data.searchResults.hits as RouteHit[];
        }

        const scripts = Array.from(document.querySelectorAll('script'));
        for (const script of scripts) {
          const text = script.textContent || '';
          if (!text.includes('"hits"')) continue;
          const idx = text.indexOf('"hits"');
          const start = text.indexOf('[', idx);
          if (start === -1) continue;
          let depth = 0;
          for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (ch === '[') depth += 1;
            else if (ch === ']') depth -= 1;
            if (depth === 0) {
              try {
                const jsonText = text.slice(start, i + 1);
                const parsed = JSON.parse(jsonText);
                if (Array.isArray(parsed) && parsed.length) {
                  return parsed as RouteHit[];
                }
              } catch {
                // ignore and continue scanning
              }
              break;
            }
          }
        }

        return null;
      },
      { timeout: 20000 }
    )
    .catch(() => null);

  if (!result) {
    return [];
  }

  const hits = (await result.jsonValue().catch(() => [])) as RouteHit[];
  return hits || [];
}

async function extractDomRows(page: Page, site: SiteConfig): Promise<JobRow[]> {
  const cardSelector = [
    'ul.cards__list li.cards__item',
    'main [data-testid*="search-result"]',
    'main article:has(a[href*="/jobs/"])',
    'section article:has(a[href*="/jobs/"])',
    'main li:has(a[href*="/jobs/"])',
    'main div:has(a[href*="/jobs/"])',
    'article[data-automation-id]'
  ].join(', ');
  const cards = page.locator(cardSelector);
  const count = await cards.count().catch(() => 0);
  const rows: JobRow[] = [];

  if (count > 0) {
    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      const link = card.locator('h3.cards__title a.cards__link, a[href*="/jobs/"]').first();
      if ((await link.count()) === 0) {
        continue;
      }
      const href = (await link.getAttribute('href').catch(() => '')) ?? '';
      if (!href) continue;
      const url = href.startsWith('http') ? href : new URL(href, site.search.url).toString();
      if (site.disallowPatterns.some((pattern) => url.includes(pattern))) {
        continue;
      }

      const title = (await link.innerText().catch(() => '')).trim();
      const location = (
        await card
          .locator(
            '.cards__meta-item:has(svg[aria-label*="location" i]), .cards__meta-item, [data-automation-id*="location"], .job-location, .job__location, [class*="location"]'
          )
          .first()
          .innerText()
          .catch(() => '')
      ).trim();
      const posted =
        (
          await card
            .locator(
              '.cards__date, [data-automation-id*="posted"], .job-date, time, span:has-text("posted"), p:has-text("posted")'
            )
            .first()
            .innerText()
            .catch(() => '')
        ).trim() ||
        (await parsePostedFromCard(card));

      rows.push({
        site: site.key,
        title,
        company: 'Randstad',
        location,
        posted,
        url,
        job_id: extractJobIdFromUrl(url),
        scraped_at: getEasternTimeLabel()
      });
    }
  } else {
    // Fallback: scrape anchor tags directly when cards are not locatable.
    const direct = (await page.evaluate(
      ({ baseUrl, disallow }: { baseUrl: string; disallow: string[] }) => {
        const anchors = Array.from(document.querySelectorAll('a[href*="/jobs/"]')) as HTMLAnchorElement[];
        const seen = new Set<string>();
        const rows: { title: string; url: string }[] = [];
        for (const a of anchors) {
          const href = a.getAttribute('href') || '';
          if (!href || seen.has(href)) continue;
          const absolute = href.startsWith('http') ? href : new URL(href, baseUrl).toString();
          if (disallow.some((pattern) => absolute.includes(pattern))) continue;
          const text = (a.textContent || '').trim();
          if (!text) continue;
          seen.add(href);
          rows.push({ title: text.replace(/\\s+/g, ' '), url: absolute });
        }
        return rows;
      },
      { baseUrl: site.search.url, disallow: site.disallowPatterns }
    )) as { title: string; url: string }[];

    for (const row of (direct || []).slice(0, 30)) {
      rows.push({
        site: site.key,
        title: row.title,
        company: 'Randstad',
        location: '',
        posted: '',
        url: row.url,
        job_id: extractJobIdFromUrl(row.url),
        scraped_at: getEasternTimeLabel()
      });
    }
  }
  return rows;
}

function mapHitToJobRow(hit: RouteHit, site: SiteConfig, referenceDate: Date): JobRow | null {
  if (!hit?.title || (!hit.url && !hit.detailsUrl)) {
    return null;
  }

  const resolvedUrl = hit.url || hit.detailsUrl || '';
  const url = resolvedUrl.startsWith('http')
    ? resolvedUrl
    : new URL(resolvedUrl, site.search.url).toString();

  if (site.disallowPatterns.some((pattern) => url.includes(pattern))) {
    return null;
  }

  const jobTypeFilters = site.search.jobTypeFilter || [];
  const jobTypeCandidates = [
    hit.jobType,
    hit.employmentType,
    ...(Array.isArray((hit as any).employmentTypes) ? (hit as any).employmentTypes : [])
  ]
    .filter(Boolean)
    .map((value) => value.toString().toLowerCase());

  if (jobTypeFilters.length && jobTypeCandidates.length) {
    const matchesType = jobTypeFilters.some((type) =>
      jobTypeCandidates.some((candidate) => candidate.includes(type.toLowerCase()))
    );
    if (!matchesType) {
      return null;
    }
  }

  const location =
    typeof hit.shortLocation === 'string'
      ? hit.shortLocation
      : typeof hit.location === 'string'
        ? hit.location
        : (hit as any).jobLocation?.city
            ? [
                (hit as any).jobLocation.city,
                (hit as any).jobLocation.stateAbbreviation || (hit as any).jobLocation.state
              ]
                .filter(Boolean)
                .join(', ')
            : '';

  const posted = normalizeHitPostedDate(hit, referenceDate);

  return {
    site: site.key,
    title: hit.title ?? '',
    company: 'Randstad',
    location,
    posted,
    url,
    job_id: hit.id ?? extractJobIdFromUrl(url) ?? undefined,
    scraped_at: getEasternTimeLabel()
  };
}

function applyPostedDateFilter(
  row: JobRow,
  referenceDate: Date,
  todayLabel: string,
  requireToday: boolean
): JobRow | null {
  const normalizedPosted = normalizeRandstadDate(row.posted, referenceDate);
  if (normalizedPosted) {
    row.posted = normalizedPosted;
  }
  if (requireToday && row.posted !== todayLabel) {
    return null;
  }
  return row;
}

function normalizeHitPostedDate(hit: RouteHit, referenceDate: Date): string {
  const candidates: Array<number | string | undefined> = [
    hit.postedDate,
    hit.createdDate,
    hit.startDate,
    hit.launchDate
  ];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;

    // Numeric timestamp (ms since epoch)
    if (typeof candidate === 'number' && !Number.isNaN(candidate)) {
      return getEasternDateLabel(new Date(candidate));
    }

    if (typeof candidate === 'string' && candidate.trim()) {
      const numeric = Number(candidate);
      if (!Number.isNaN(numeric)) {
        return getEasternDateLabel(new Date(numeric));
      }
      const parsed = new Date(candidate);
      if (!Number.isNaN(parsed.getTime())) {
        return getEasternDateLabel(parsed);
      }
    }
  }

  // No date info; let caller decide whether to keep.
  return '';
}

function normalizeRandstadDate(posted: string | number, referenceDate: Date): string | null {
  if (posted === undefined || posted === null) return null;

  if (typeof posted === 'number' && !Number.isNaN(posted)) {
    return getEasternDateLabel(new Date(posted));
  }

  const text = posted.toString().trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  if (lower.includes('today') || /just now|mins? ago|hours? ago/.test(lower)) {
    return getEasternDateLabel(referenceDate);
  }
  if (lower.includes('yesterday')) {
    const yesterday = new Date(referenceDate);
    yesterday.setDate(yesterday.getDate() - 1);
    return getEasternDateLabel(yesterday);
  }

  const numeric = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (numeric) {
    const [, m, d, y] = numeric;
    return `${m.padStart(2, '0')}/${d.padStart(2, '0')}/${y}`;
  }

  const cleaned = text.replace(/posted\s*:?/i, '').trim();
  const parsed = new Date(cleaned);
  if (!Number.isNaN(parsed.getTime())) {
    return getEasternDateLabel(parsed);
  }

  return null;
}

async function parsePostedFromCard(card: Locator): Promise<string> {
  const text = await card.innerText().catch(() => '');
  if (!text) return '';
  const trimmed = text.trim();

  // Match patterns like "posted November 17, 2025"
  const namedMonth = trimmed.match(/posted[^\d]*([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/i);
  if (namedMonth) {
    const [, monthName, day, year] = namedMonth;
    const parsed = new Date(`${monthName} ${day}, ${year}`);
    if (!Number.isNaN(parsed.getTime())) {
      return `${String(parsed.getMonth() + 1).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`;
    }
  }

  // Match MM/DD/YYYY anywhere in the text.
  const numeric = trimmed.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (numeric) {
    const [, m, d, y] = numeric;
    return `${m.padStart(2, '0')}/${d.padStart(2, '0')}/${y}`;
  }

  return '';
}
function extractJobIdFromUrl(url: string): string | undefined {
  const match = url.match(/jobs\/(?:[^/]+\/)?([A-Za-z0-9-]+)\/?/);
  return match ? match[1] : undefined;
}

async function evaluateDetailedJobs(
  context: BrowserContext,
  roles: SessionRole[],
  seen: Set<string>
): Promise<JobRow[]> {
  const accepted: JobRow[] = [];
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i];
    const page = await context.newPage();
    try {
      await page.goto(role.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      let description = await extractDescription(page);
      if (description.length < 500) {
        await page.waitForTimeout(10000);
        description = await extractDescription(page);
      }
      if (description.length < 500) {
        await page.waitForTimeout(30000);
        description = await extractDescription(page);
      }
      console.log(
        `[randstad][AI] Detail candidate #${i + 1}/${roles.length} "${role.title}" (${role.location}) – description length ${description.length} chars.`
      );
      const detailResult = await evaluateJobDetail({
        title: role.title,
        company: role.company,
        location: role.location,
        url: role.url,
        description
      });

      if (!detailResult.accepted) {
        console.log(
          `[randstad][AI] Rejected "${role.title}" (${role.location}) – Reason: ${
            detailResult.reasoning || 'Model marked as not relevant.'
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
      console.error(`[randstad] Failed to evaluate detail for ${role.url}`, error);
    } finally {
      await page.close();
    }
  }

  console.log(`[randstad][AI] Detail evaluation accepted ${accepted.length} roles out of ${roles.length}.`);
  return accepted;
}

export async function extractDescription(page: Page): Promise<string> {
  const selectors = [
    '.job-detail',
    '.jobDescription',
    '.job-details',
    '.job__details',
    '.RichTextEditorClass',
    'main',
    'body'
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        const text = await locator.innerText({ timeout: 5000 });
        if (text.trim()) {
          return text.trim();
        }
      } catch {
        continue;
      }
    }
  }
  return await page.content();
}

async function filterTitlesWithAi(rows: SessionRole[]): Promise<TitleFilterResult> {
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

async function fillKeyword(page: Page, selector: string, keyword: string): Promise<void> {
  const input = await pickFirstAvailable(page, [
    selector,
    'input[placeholder*="keyword" i]',
    'input[placeholder*="job" i]',
    'input[name*="keyword" i]',
    'input[type="search"]'
  ]);
  if (!input) {
    throw new Error('Keyword input not found.');
  }
  await input.fill('');
  await input.type(keyword, { delay: 20 });
}

async function fillLocation(page: Page, selector: string | undefined, value: string): Promise<void> {
  if (!selector) return;
  const input = page.locator(selector).first();
  if ((await input.count()) === 0) {
    return;
  }
  await input.click({ delay: 20 });
  await page.keyboard.press('Meta+a').catch(() => page.keyboard.press('Control+a'));
  await page.keyboard.press('Backspace');
  await input.type(value, { delay: 20 });
  await page.keyboard.press('Enter');
}

async function applyContractFilter(page: Page): Promise<void> {
  const trigger = await pickFirstAvailable(page, [
    'button[data-rs-popover-trigger="jobType"]',
    'li.filter-bar__menu-item button:has-text("job types")',
    'button:has-text("job types")'
  ]);

  if (!trigger) {
    const waited = await page
      .waitForSelector('button[data-rs-popover-trigger="jobType"], button:has-text("job types")', {
        timeout: 8000
      })
      .catch(() => null);
    if (!waited) {
      console.warn('[randstad] Job type trigger not found; skipping contract filter.');
      return;
    }
  }

  await trigger?.scrollIntoViewIfNeeded().catch(() => undefined);
  await trigger?.click({ delay: 30 }).catch(() => undefined);

  const popover = page.locator('[data-rs-popover="jobType"]').first();
  await popover.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);

  const contractCheckbox = popover
    .locator('label:has-text("contract") input[type="checkbox"]')
    .first();
  if ((await contractCheckbox.count()) > 0) {
    const checked = await contractCheckbox.isChecked().catch(() => false);
    if (!checked) {
      await contractCheckbox.check({ force: true }).catch(async () => {
        const label = popover.locator('label:has-text("contract")').first();
        await label.click().catch(() => undefined);
      });
    }
  } else {
    console.warn('[randstad] Contract checkbox not found in job types popover.');
  }

  const applyButton = popover
    .locator('button.show-jobs, .popover__action button:has-text("show")')
    .first();
  if ((await applyButton.count()) > 0) {
    await applyButton.click().catch(() => undefined);
    await page.waitForLoadState('networkidle').catch(() => undefined);
  } else {
    console.warn('[randstad] Show jobs button not found in job types popover.');
  }
}

async function ensureDateSort(page: Page, selectors: SiteConfig['search']['selectors']): Promise<void> {
  const { sortToggle, sortOption, sortOptionText } = selectors;
  const target = sortOptionText || 'date';

  // Prefer native select if present.
  const selectWait = await page
    .waitForSelector('select#sortBy, select[name="sortBy"]', { timeout: 12000 })
    .catch(() => null);
  if (selectWait) {
    const select = page.locator('select#sortBy, select[name="sortBy"]').first();
    const currentValue = (await select.inputValue().catch(() => '')).toLowerCase();
    console.log(`[randstad] Found sort select#sortBy (value="${currentValue || 'empty'}")`);
    if (currentValue !== target) {
      const changed = await select.selectOption({ value: target }).catch(async () => {
        const res = await select.selectOption({ label: target }).catch(() => undefined);
        return res;
      });
      if (!changed || (Array.isArray(changed) && !changed.length)) {
        console.warn('[randstad] Failed to change sort via selectOption; will try fallback toggle path.');
      } else {
        await page.waitForLoadState('networkidle').catch(() => undefined);
        return;
      }
    } else {
      return;
    }
  } else {
    console.warn('[randstad] sort select#sortBy not found within timeout; falling back to toggle options.');
  }

  // If already on date, bail.
  const current = await pickFirstAvailable(page, [
    selectors.sortValueLabel ?? '',
    'text=/sort\\s*:?.*date/i',
    'button:has-text("date")'
  ].filter(Boolean));
  if (current) {
    const text = (await current.innerText().catch(() => '')).trim().toLowerCase();
    if (text.includes('date')) {
      return;
    }
  }

  const toggle = await pickFirstAvailable(page, [
    sortToggle ?? '',
    'button:has-text("sort")',
    'button:has-text("sort:")',
    'button[aria-label*="sort" i]'
  ].filter(Boolean));
  if (!toggle) {
    const sortLabel = await pickFirstAvailable(page, ['text=/sort\\s*:?.*date/i']);
    if (sortLabel) {
      return;
    }
    console.warn('[randstad] Sort toggle not found; skipping sort adjustment.');
    return;
  }

  await toggle.click().catch(() => undefined);

  const option = await pickFirstAvailable(page, [
    sortOption ?? '',
    'button:has-text("date")',
    'li:has-text("date")',
    '[role="option"]:has-text("date")',
    '[role="menuitem"]:has-text("date")',
    '.filters__sort li:has-text("date")'
  ].filter(Boolean));

  if (!option) {
    console.warn('[randstad] Sort option "date" not found after opening toggle.');
    return;
  }

  await option.click().catch(() => undefined);
  await page.waitForLoadState('networkidle').catch(() => undefined);
}

async function pickFirstAvailable(page: Page, selectors: (string | undefined)[]): Promise<Locator | null> {
  for (const selector of selectors) {
    if (!selector) continue;
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) {
      return locator;
    }
  }
  return null;
}

function normalizeKeywords(raw: string | string[]): string[] {
  const candidates = Array.isArray(raw) ? raw : [raw];
  return Array.from(new Set(candidates.map((keyword) => keyword.trim()).filter(Boolean)));
}

function createSessionId(): string {
  return `session-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}
