import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { JobRow } from './csv';

export async function loadSeenStore(filePath: string): Promise<Set<string>> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    const data = JSON.parse(raw) as string[];
    return new Set(data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Set();
    }
    throw error;
  }
}

export async function saveSeenStore(filePath: string, seen: Set<string>): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const payload = JSON.stringify(Array.from(seen).sort(), null, 2);
  await fs.promises.writeFile(filePath, payload, 'utf-8');
}

export function computeJobKey(row: Pick<JobRow, 'title' | 'company' | 'location' | 'url'> & { job_id?: string }): string {
  if (row.job_id && row.job_id.trim().length > 0) {
    return row.job_id;
  }

  const base = `${row.title}|${row.company}|${row.location}|${row.url}`;
  return crypto.createHash('sha1').update(base).digest('hex');
}

export function filterNewRows(rows: JobRow[], seen: Set<string>): JobRow[] {
  return rows.filter((row) => {
    const key = computeJobKey(row);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
