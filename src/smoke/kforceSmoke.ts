import { chromium } from 'playwright';
import { getSiteConfig, loadConfig } from '../lib/config';
import { acceptCookieConsent } from '../lib/cookies';

async function runSmoke(): Promise<void> {
  const config = loadConfig();
  const site = getSiteConfig(config, 'kforce');

  console.log('[smoke] Launching Chromium in headful persistent mode...');
  const context = await chromium.launchPersistentContext(site.userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 720 }
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.bringToFront();

  console.log(`[smoke] Navigating to ${site.search.url}`);
  await page.goto(site.search.url, { waitUntil: 'domcontentloaded' });

  const cookieResult = await acceptCookieConsent(page, site.cookieConsent);
  if (cookieResult.clicked) {
    console.log(`[smoke] Cookie prompt accepted via ${cookieResult.via}`);
  } else {
    console.log('[smoke] No cookie prompt interacted with (may not be present).');
  }

  const selector = site.search.selectors.card ?? 'main';
  await page.waitForSelector(selector, { timeout: 45000 });
  console.log(`[smoke] Page loaded. Found selector: ${selector}`);

  console.log('[smoke] Keeping page visible for manual inspection (5s)...');
  await page.waitForTimeout(5000);

  await context.close();
  console.log('[smoke] Chromium closed successfully.');
}

runSmoke().catch((error) => {
  console.error('[smoke] Failed to load Kforce search page', error);
  process.exitCode = 1;
});
