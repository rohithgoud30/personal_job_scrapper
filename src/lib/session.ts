import fs from 'fs';
import path from 'path';
import { OutputConfig, SiteConfig } from './config';
import { buildSessionPaths, OutputPaths, SessionPaths } from './paths';

export interface SessionCsvRow {
  session_id: string;
  keyword: string;
  site: string;
  title: string;
  company: string;
  location: string;
  posted: string;
  url: string;
  job_id?: string;
  scraped_at: string;
}

export interface LocatedSession {
  outputPaths: OutputPaths;
  sessionPaths: SessionPaths;
}

export async function findSessionById(
  output: OutputConfig,
  site: SiteConfig,
  sessionId: string
): Promise<LocatedSession | null> {
  const siteRoot = path.join(output.root, site.host);
  const dateFolders = await fs.promises.readdir(siteRoot).catch(() => []);

  for (const folder of dateFolders) {
    const rolesFile = path.join(siteRoot, folder, 'sessions', sessionId, 'roles', 'new_roles.csv');
    const exists = await fs.promises
      .access(rolesFile)
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      continue;
    }

    const datedCsv = path.join(siteRoot, folder, `new_jobs_${folder}.csv`);
    const legacyCsv = path.join(siteRoot, folder, 'new_jobs.csv');
    const csvFile = await fs.promises
      .access(datedCsv)
      .then(() => datedCsv)
      .catch(async () => {
        const hasLegacy = await fs.promises
          .access(legacyCsv)
          .then(() => true)
          .catch(() => false);
        return hasLegacy ? legacyCsv : datedCsv;
      });

    const outputPaths: OutputPaths = {
      directory: path.join(siteRoot, folder),
      csvFile,
      seenFile: path.join(siteRoot, folder, 'seen.json'),
      dateFolder: folder
    };

    return {
      outputPaths,
      sessionPaths: buildSessionPaths(outputPaths, sessionId)
    };
  }

  return null;
}

export async function readSessionCsv(filePath: string): Promise<SessionCsvRow[]> {
  const contents = await fs.promises.readFile(filePath, 'utf-8').catch(() => '');
  if (!contents.trim()) {
    return [];
  }

  const lines = contents
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const rows: SessionCsvRow[] = [];
  for (const line of lines) {
    if (line.toLowerCase().startsWith('session_id,')) {
      continue;
    }
    const cells = parseCsvLine(line);
    if (cells.length < 10) {
      continue;
    }

    const [session_id, keyword, site, title, company, location, posted, url, job_id, scraped_at] = cells;
    if (!url) {
      continue;
    }

    rows.push({
      session_id,
      keyword,
      site,
      title,
      company,
      location,
      posted,
      url,
      job_id: job_id || undefined,
      scraped_at
    });
  }

  return rows;
}

export function parseDateFolderLabel(label: string): Date | null {
  const match = label.match(/^(\d{2})_(\d{2})_(\d{4})$/);
  if (!match) {
    return null;
  }

  const [, month, day, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0));
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}
