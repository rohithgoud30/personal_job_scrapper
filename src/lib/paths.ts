import fs from 'fs';
import path from 'path';
import { OutputConfig, SiteConfig } from './config';
import { getEasternDateParts } from './time';

export interface OutputPaths {
  directory: string;
  csvFile: string;
  seenFile: string;
  dateFolder: string;
}

export interface SessionPaths {
  sessionId: string;
  sessionDir: string;
  rolesDir: string;
  rolesFile: string;
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

  const directory = path.join(outputConfig.root, site.host, dateFolder);
  const csvFile = path.join(directory, `new_jobs_${dateFolder}.csv`);
  const seenFile = path.join(directory, 'seen.json');

  return {
    directory,
    csvFile,
    seenFile,
    dateFolder
  };
}

export async function ensureDirectoryExists(directory: string): Promise<void> {
  await fs.promises.mkdir(directory, { recursive: true });
}

export function buildSessionPaths(output: OutputPaths, sessionId: string): SessionPaths {
  const sessionDir = path.join(output.directory, 'sessions', sessionId);
  const rolesDir = path.join(sessionDir, 'roles');
  const rolesFile = path.join(rolesDir, 'new_roles.csv');
  return {
    sessionId,
    sessionDir,
    rolesDir,
    rolesFile
  };
}
