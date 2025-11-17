import { chromium } from 'playwright';
import { extractDescription } from '../src/sites/kforce/index';

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: ts-node scripts/fetchJobDetail.ts <job_url>');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  try {
    console.log(`[detail-test] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const description = await extractDescription(page);
    console.log('[detail-test] Extracted Description:');
    console.log(description);
  } catch (error) {
    console.error('[detail-test] Failed to fetch job detail:', error);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
