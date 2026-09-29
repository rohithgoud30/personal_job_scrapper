import { Page } from 'playwright';
import { CookieConsentConfig } from './config';

export interface CookieResult {
  clicked: boolean;
  via?: string;
}

// How long to wait for a consent banner to appear before assuming there is none.
const BANNER_TIMEOUT_MS = 3000;

export async function acceptCookieConsent(
  page: Page,
  cookieConfig?: CookieConsentConfig
): Promise<CookieResult> {
  const buttons = page.locator('button, [role="button"]');
  const candidates = [
    ...(cookieConfig?.buttonSelectors ?? []).map((selector) => ({
      via: selector,
      locator: page.locator(selector).first(),
    })),
    ...(cookieConfig?.textMatches ?? []).map((text) => ({
      via: text,
      locator: buttons.filter({ hasText: new RegExp(text, 'i') }).first(),
    })),
  ];
  if (!candidates.length) {
    return { clicked: false };
  }

  // Resolves as soon as any consent button is visible.
  const any = candidates.map((c) => c.locator).reduce((a, b) => a.or(b));
  const appeared = await any
    .first()
    .waitFor({ state: 'visible', timeout: BANNER_TIMEOUT_MS })
    .then(() => true, () => false);
  if (!appeared) {
    return { clicked: false };
  }

  for (const { via, locator } of candidates) {
    if (!(await locator.isVisible())) continue;
    try {
      await locator.click({ timeout: 3000 });
      console.log(`[cookies] Accepted via: ${via}`);
      return { clicked: true, via };
    } catch (error) {
      console.warn(`[cookies] Failed to click consent button (${via})`, error);
    }
  }
  return { clicked: false };
}
