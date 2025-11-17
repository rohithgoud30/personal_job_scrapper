import { Page } from 'playwright';
import { CookieConsentConfig } from './config';

export interface CookieResult {
  clicked: boolean;
  via?: string;
}

export async function acceptCookieConsent(
  page: Page,
  cookieConfig?: CookieConsentConfig
): Promise<CookieResult> {
  if (!cookieConfig) {
    return { clicked: false };
  }

  if (cookieConfig.waitForSeconds && cookieConfig.waitForSeconds > 0) {
    await page.waitForTimeout(cookieConfig.waitForSeconds * 1000);
  }

  const selectors = cookieConfig.buttonSelectors ?? [];
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.isVisible({ timeout: 1500 })) {
        await locator.click({ timeout: 3000 });
        console.log(`[cookies] Accepted via selector: ${selector}`);
        return { clicked: true, via: selector };
      }
    } catch (error) {
      console.warn(`[cookies] Failed to interact with selector ${selector}`, error);
    }
  }

  const textMatches = cookieConfig.textMatches ?? [];
  if (textMatches.length > 0) {
    const buttons = page.locator('button, [role="button"]');
    for (const text of textMatches) {
      const locator = buttons.filter({ hasText: new RegExp(text, 'i') }).first();
      try {
        if (await locator.isVisible({ timeout: 1500 })) {
          await locator.click({ timeout: 3000 });
          console.log(`[cookies] Accepted via text match: ${text}`);
          return { clicked: true, via: text };
        }
      } catch (error) {
        console.warn(`[cookies] Failed to click button with text ${text}`, error);
      }
    }
  }

  return { clicked: false };
}
