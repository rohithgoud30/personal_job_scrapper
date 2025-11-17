import fs from 'fs';
import path from 'path';
import { OutputConfig, SiteConfig } from './config';
import { getEasternDateParts } from './time';

export interface OutputPaths {
  directory: string;
  csvFile: string;
  seenFile: string;
  hour: number;
  dateFolder: string;
}

export function buildOutputPaths(
  outputConfig: OutputConfig,
  site: SiteConfig,
  runDate = new Date()
): OutputPaths {
  const eastern = getEasternDateParts(runDate);
  const month = String(eastern.month).padStart(2, '0');
  const day = String(eastern.day).padStart(2, '0');
  const year = eastern.year;
  const dateFolder = `${month}_${day}_${year}`;
  const hour = eastern.hour;

  const directory = path.join(outputConfig.root, site.host, dateFolder);
  const csvFile = path.join(directory, 'new_jobs.csv');
  const seenFile = path.join(directory, 'seen.json');

  return {
    directory,
    csvFile,
    seenFile,
    hour,
    dateFolder
  };
}

export async function ensureDirectoryExists(directory: string): Promise<void> {
  await fs.promises.mkdir(directory, { recursive: true });
}
