import { loadConfig } from '../src/lib/config';
import { runKforceSite } from '../src/sites/kforce';

(async () => {
  const config = loadConfig();
  const site = config.sites.find((entry) => entry.key === 'kforce');
  if (!site) {
    throw new Error('Kforce site configuration not found');
  }

  const currentKeywords = site.search.criteria.keywords;
  const firstKeyword = Array.isArray(currentKeywords) ? currentKeywords.slice(0, 1) : [currentKeywords];

  site.search.criteria.keywords = firstKeyword;
  site.search.postedTodayOnly = false;
  site.run.maxPages = Math.min(1, site.run.maxPages);
  site.run.keywordDelaySeconds = 0;

  console.log(`[single-run] Running single keyword smoke for "${firstKeyword[0]}"`);
  await runKforceSite(site, config.output);
})();
