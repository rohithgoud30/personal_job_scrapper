import { chromium } from "playwright";
import { getSiteConfig, loadConfig } from "../src/lib/config";
import { acceptCookieConsent } from "../src/lib/cookies";

(async () => {
  const config = loadConfig();
  const site = getSiteConfig(config, "kforce");
  const context = await chromium.launchPersistentContext(site.userDataDir, {
    headless: true,
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(site.search.url, { waitUntil: "domcontentloaded" });
  await acceptCookieConsent(page, site.cookieConsent);
  await page.waitForTimeout(5000);

  const selectors = [
    "li.job-item",
    ".job-card",
    ".jobs-list li",
    "article",
    ".data-jobs li",
  ];

  for (const selector of selectors) {
    const count = await page.locator(selector).count();
    console.log(`Selector ${selector}: ${count}`);
  }

  const sample = await page
    .locator(".data-jobs li")
    .first()
    .evaluate((el) => (el as HTMLElement).outerHTML)
    .catch(() => "");
  console.log("Sample snippet:", sample);

  const searchInputs = [
    "input[name=keywords]",
    "#keywords",
    "input[name=location]",
    "#location",
    "button[type=submit]",
  ];
  for (const selector of searchInputs) {
    const count = await page.locator(selector).count();
    console.log(`Input ${selector}: ${count}`);
  }

  const html = await page.content();
  await import("fs").then(({ writeFileSync }) => {
    writeFileSync("scripts/kforce-page.html", html, "utf-8");
  });
  console.log("Saved full page HTML to scripts/kforce-page.html");

  await context.close();
})();
