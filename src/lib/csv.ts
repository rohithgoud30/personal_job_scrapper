import fs from 'fs';
import path from 'path';
import { format } from '@fast-csv/format';
import { parseString } from '@fast-csv/parse';

export interface JobRow {
  site: string;
  title: string;
  company: string;
  location: string;
  posted: string;
  url: string;
  job_id?: string;
  scraped_at: string;
}

const CSV_HEADERS = ['site', 'title', 'company', 'location', 'posted', 'url', 'job_id', 'scraped_at'] as const;

export async function appendJobRows(
  filePath: string,
  rows: JobRow[],
): Promise<void> {
  if (!rows.length) {
    return;
  }

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const sanitizedNewRows = rows.map(normalizeRow);
  const existingRows = await readExistingRows(filePath);
  const combined = [...sanitizedNewRows, ...existingRows];
  await writeRows(filePath, combined);
}

async function writeRows(filePath: string, rows: JobRow[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath, { flags: 'w' });
    const csvStream = format<JobRow, JobRow>({
      headers: CSV_HEADERS as unknown as string[],
      writeHeaders: true
    });

    writeStream.on('error', reject);
    csvStream.on('error', reject);
    writeStream.on('finish', resolve);

    csvStream.pipe(writeStream);
    rows.forEach((row) => csvStream.write(row));
    csvStream.end();
  });
}

async function readExistingRows(filePath: string): Promise<JobRow[]> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return parseExistingContent(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function parseExistingContent(content: string): Promise<JobRow[]> {
  return new Promise((resolve, reject) => {
    const rows: JobRow[] = [];
    parseString(content, { headers: true, trim: true })
      .on('error', reject)
      .on('data', (data: Record<string, string>) => {
        rows.push(normalizeParsedRow(data));
      })
      .on('end', () => resolve(rows));
  });
}

function normalizeRow(row: JobRow): JobRow {
  return {
    site: row.site ?? '',
    title: row.title ?? '',
    company: row.company ?? '',
    location: row.location ?? '',
    posted: row.posted ?? '',
    url: row.url ?? '',
    job_id: row.job_id ?? '',
    scraped_at: row.scraped_at ?? ''
  };
}

function normalizeParsedRow(row: Record<string, string>): JobRow {
  return {
    site: row.site ?? '',
    title: row.title ?? '',
    company: row.company ?? '',
    location: row.location ?? '',
    posted: row.posted ?? '',
    url: row.url ?? '',
    job_id: row.job_id ?? row.jobId ?? '',
    scraped_at: row.scraped_at ?? row.scrapedAt ?? ''
  };
}
