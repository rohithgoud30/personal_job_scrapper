import { chromium, Locator, Page } from 'playwright';
import { getSiteConfig, loadConfig, SiteConfig } from '../lib/config';
import { getEasternDateLabel } from '../lib/time';
import { acceptCookieConsent } from '../lib/cookies';

const DEFAULT_KEYWORD = 'full stack developer';

async function pickFirstAvailable(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) {
      return locator;
    }
  }
  return null;
}

async function runSmoke(): Promise<void> {
  const config = loadConfig();
  const site = getSiteConfig(config, 'randstadusa');
  const todayLabel = getEasternDateLabel();

  console.log('[smoke] Launching Chromium in headful mode...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.bringToFront();

  const slug = DEFAULT_KEYWORD.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'jobs';
  const searchUrl = `${site.search.url}q-${slug}/`;
  console.log(`[smoke] Navigating to ${searchUrl}`);
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });

  const cookieResult = await acceptCookieConsent(page, site.cookieConsent);
  if (cookieResult.clicked) {
    console.log(`[smoke] Cookie prompt accepted via ${cookieResult.via}`);
  } else {
    console.log('[smoke] No cookie prompt interacted with (may not be present).');
  }

  // If the app still needs a manual search submit, try to interact.
  const keywordInput = await pickFirstAvailable(page, [
    'input[placeholder*="keyword" i]',
    'input[placeholder*="job" i]',
    'input[name*="keyword" i]',
    'input[type="search"]',
    site.search.selectors.keywords
  ]);
  if (keywordInput) {
    await keywordInput.fill('');
    await keywordInput.type(DEFAULT_KEYWORD, { delay: 10 }).catch(() => undefined);
    const searchSelectors = [
      'button:has-text("Search")',
      'button:has-text("search")',
      'button[type="submit"]',
      'button[aria-label*="search" i]',
      site.search.selectors.submit
    ].filter(Boolean) as string[];
    await clickFirstVisible(page, searchSelectors);
    await page.waitForLoadState('networkidle').catch(() => undefined);
  }
  await ensureDateSort(page, site.search.selectors);

  // Allow client-side search app to hydrate and pull results.
  await page.waitForTimeout(4000);

  const hitsHandle = await page
    .waitForFunction(
      () => {
        const data = (window as any).__ROUTE_DATA__;
        if (!data?.searchResults?.hits || !Array.isArray(data.searchResults.hits)) {
          return null;
        }
        const toUrl = (href: string) =>
          href.startsWith('http') ? href : `https://www.randstadusa.com${href}`;
        return data.searchResults.hits.slice(0, 10).map((hit: any) => ({
          title: hit.title,
          location: hit.shortLocation ?? hit.location ?? hit.city ?? '',
          posted: hit.postedDate ?? '',
          url: toUrl(hit.url ?? '')
        }));
      },
      { timeout: 20000 }
    )
    .catch(() => null);

  if (hitsHandle) {
    const hits = (await hitsHandle.jsonValue()) as
      | { title: string; location: string; posted: string; url: string }[]
      | null;
    if (hits && hits.length) {
      console.log(`[smoke] Top ${hits.length} results from route data:`);
      hits.forEach((hit, index) => {
        console.log(
          `[${index + 1}] ${hit.title} | ${hit.location} | posted: ${hit.posted} | ${hit.url}`
        );
      });
    } else {
      console.log('[smoke] Route data returned no hits.');
    }
  } else {
    console.log('[smoke] Route data not available; attempting DOM scrape for first page rows.');
    const debugCounts = await page.evaluate(() => {
      return {
        cards: document.querySelectorAll('ul.cards__list li.cards__item').length,
        anchors: document.querySelectorAll('a[href*="/jobs/"]').length,
        cardsList: !!document.querySelector('ul.cards__list')
      };
    });
    console.log(`[smoke] Debug counts: cards=${debugCounts.cards} anchors=${debugCounts.anchors} cardsList=${debugCounts.cardsList}`);
    const cards = page.locator(
      [
        'ul.cards__list li.cards__item',
        'main [data-testid*="search-result"]',
        'main article:has(a[href*="/jobs/"])',
        'main li:has(a[href*="/jobs/"])',
        'main div:has(a[href*="/jobs/"])'
      ].join(', ')
    );

    const cardCount = await cards.count().catch(() => 0);
    if (cardCount === 0) {
      console.log('[smoke] No result cards found in DOM; trying anchor scrape.');
      const anchors = await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('a[href*="/jobs/"]')) as HTMLAnchorElement[];
        return nodes
          .slice(0, 20)
          .map((a) => ({
            text: (a.textContent || '').trim().replace(/\s+/g, ' '),
            href: a.getAttribute('href') || ''
          }))
          .filter((x) => x.text);
      });
      if (!anchors.length) {
        console.log('[smoke] Anchor scrape also found nothing.');
      } else {
        anchors.forEach((a: any, index: number) => {
          const url = a.href.startsWith('http') ? a.href : new URL(a.href, site.search.url).toString();
          console.log(`[anchor ${index + 1}] ${a.text} | ${url}`);
        });
      }
    } else {
      const count = Math.min(cardCount, 10);
      for (let i = 0; i < count; i++) {
        const card = cards.nth(i);
        const link = card.locator('a[href*="/jobs/"]').first();
        const href = (await link.getAttribute('href').catch(() => '')) ?? '';
        const url = href.startsWith('http') ? href : new URL(href, site.search.url).toString();
        const title = (await link.innerText().catch(() => '')).trim().replace(/\s+/g, ' ');
        const posted =
          (
            await card
              .locator(
                '.cards__date, [data-automation-id*="posted"], .job-date, time, span:has-text("posted"), p:has-text("posted")'
              )
              .first()
              .innerText()
              .catch(() => '')
          )
            .trim()
            .replace(/\s+/g, ' ') || (await card.innerText().catch(() => '')).split('\n').find((line) => /posted/i.test(line)) || '';
        const normalized = normalizePostedDate(posted);
        if (normalized && normalized !== todayLabel) {
          continue;
        }
        console.log(`[${i + 1}] ${title} | posted: ${normalized || posted} | ${url}`);
      }
    }
  }

  console.log('[smoke] Keeping page visible for manual inspection (8s)...');
  await page.waitForTimeout(8000);

  await context.close();
  await browser.close();
  console.log('[smoke] Chromium closed successfully.');
}

runSmoke().catch((error) => {
  console.error('[smoke] Failed to load Randstad search page', error);
  process.exitCode = 1;
});

async function clickFirstVisible(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) {
      continue;
    }
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await locator.click({ delay: 30 }).catch(() => undefined);
    return true;
  }
  return false;
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
    console.log(`[smoke] Found sort select#sortBy (value="${currentValue || 'empty'}")`);
    if (currentValue !== target) {
      const changed = await select.selectOption({ value: target }).catch(async () => {
        const res = await select.selectOption({ label: target }).catch(() => undefined);
        return res;
      });
      if (!changed || (Array.isArray(changed) && !changed.length)) {
        console.warn('[smoke] Failed to change sort via selectOption; will try fallback toggle path.');
      } else {
        await page.waitForLoadState('networkidle').catch(() => undefined);
        return;
      }
    } else {
      return;
    }
  } else {
    console.warn('[smoke] sort select#sortBy not found within timeout; falling back to toggle options.');
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
    // If the page already shows sort date somewhere, accept it and move on.
    const sortLabel = await pickFirstAvailable(page, ['text=/sort\\s*:?.*date/i']);
    if (sortLabel) {
      return;
    }
    console.warn('[smoke] Sort toggle not found; skipping sort adjustment.');
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
    console.warn('[smoke] Sort option "date" not found after opening toggle.');
    return;
  }

  await option.click().catch(() => undefined);
  await page.waitForLoadState('networkidle').catch(() => undefined);
}

function normalizePostedDate(posted: string): string | null {
  const text = posted.trim().toLowerCase();
  if (!text) return null;

  const numeric = posted.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (numeric) {
    const [, m, d, y] = numeric;
    return `${m.padStart(2, '0')}/${d.padStart(2, '0')}/${y}`;
  }

  const namedMonth = posted.match(/posted\s+([a-z]+)\s+(\d{1,2}),\s+(\d{4})/i);
  if (namedMonth) {
    const [, month, day, year] = namedMonth;
    const parsed = new Date(`${month} ${day}, ${year}`);
    if (!Number.isNaN(parsed.getTime())) {
      return getEasternDateLabel(parsed);
    }
  }

  const parsed = new Date(posted);
  if (!Number.isNaN(parsed.getTime())) {
    return getEasternDateLabel(parsed);
  }

  return null;
}
