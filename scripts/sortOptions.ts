import { chromium } from 'playwright';
import { getSiteConfig, loadConfig } from '../src/lib/config';
import { acceptCookieConsent } from '../src/lib/cookies';

(async () => {
  const config = loadConfig();
  const site = getSiteConfig(config, 'kforce');
  const context = await chromium.launchPersistentContext(site.userDataDir, {
    headless: true
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(site.search.url, { waitUntil: 'domcontentloaded' });
  await acceptCookieConsent(page, site.cookieConsent);
  const sortControl = page.locator('.facets .Select-control').first();
  await sortControl.click();
  await page.waitForSelector('.Select-menu-outer .Select-option', { timeout: 15000 });
  const options = await page.$$eval('.Select-menu-outer .Select-option', (elements) =>
    elements.map((el) => (el.textContent || '').trim())
  );
  console.log('sort options:', options);
  await context.close();
})();
