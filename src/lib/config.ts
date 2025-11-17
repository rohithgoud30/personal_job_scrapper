import fs from 'fs';
import path from 'path';

export interface ConfigFile {
  schedule: ScheduleConfig;
  output: OutputConfig;
  sites: SiteConfig[];
}

export interface ScheduleConfig {
  cron: string;
}

export interface OutputConfig {
  root: string;
  pattern: string;
}

export interface SiteConfig {
  key: string;
  host: string;
  userDataDir: string;
  login: LoginConfig;
  search: SearchConfig;
  run: RunConfig;
  disallowPatterns: string[];
  cookieConsent?: CookieConsentConfig;
}

export interface LoginConfig {
  required: boolean;
  url: string;
  email: string;
  password: string;
  selectors: LoginSelectors;
}

export interface LoginSelectors {
  openLogin?: string;
  email: string;
  password: string;
  submit: string;
}

export interface SearchConfig {
  url: string;
  criteria: SearchCriteria;
  selectors: SearchSelectors;
  postedTodayOnly?: boolean;
  jobTypeFilter?: string[];
}

export interface SearchCriteria {
  keywords: string | string[];
  location?: string;
}

export interface SearchSelectors {
  keywords: string;
  location?: string;
  submit: string;
  card?: string;
  title?: string;
  company?: string;
  locationText?: string;
  posted?: string;
  next?: string;
  sortToggle?: string;
  sortOption?: string;
  sortValueLabel?: string;
  sortOptionText?: string;
  jobType?: string;
  jobTypeFacetOption?: string;
  jobTypeFacetText?: string;
}

export interface RunConfig {
  maxPages: number;
  throttleSeconds: number;
  pageDelaySeconds: number;
  keywordDelaySeconds?: number;
}

export interface CookieConsentConfig {
  buttonSelectors?: string[];
  textMatches?: string[];
  waitForSeconds?: number;
}

const DEFAULT_CONFIG = path.resolve(process.cwd(), 'config.json');

export function loadConfig(customPath?: string): ConfigFile {
  const configPath = path.resolve(process.cwd(), customPath ?? DEFAULT_CONFIG);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found at ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const data = JSON.parse(raw) as ConfigFile;
  return data;
}

export function getSiteConfig(config: ConfigFile, key: string): SiteConfig {
  const site = config.sites.find((entry) => entry.key === key);
  if (!site) {
    throw new Error(`Site config for key "${key}" was not found.`);
  }
  return site;
}
