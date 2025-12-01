import * as XLSX from "xlsx";
import fs from "fs";
import path from "path";

export interface RejectedJob {
  title: string;
  site: string;
  url: string;
  jd: string;
  reason: string;
  scraped_at: string;
  type: "title" | "detail";
}

class RejectedLogger {
  private rejectedJobs: RejectedJob[] = [];

  public log(entry: RejectedJob): void {
    this.rejectedJobs.push(entry);
  }

  public getEntries(): RejectedJob[] {
    return this.rejectedJobs;
  }

  public clear(): void {
    this.rejectedJobs = [];
  }

  public save(outputPath: string): void {
    if (this.rejectedJobs.length === 0) {
      console.log("[RejectedLogger] No rejected jobs to save.");
      return;
    }

    // Group by "Site - Type"
    const jobsBySheet: Record<string, RejectedJob[]> = {};
    for (const job of this.rejectedJobs) {
      // Capitalize type for better readability: "Dice - Title", "Dice - Detail"
      const typeLabel = job.type.charAt(0).toUpperCase() + job.type.slice(1);
      const sheetName = `${job.site} - ${typeLabel}`;

      if (!jobsBySheet[sheetName]) {
        jobsBySheet[sheetName] = [];
      }
      jobsBySheet[sheetName].push(job);
    }

    const workbook = XLSX.utils.book_new();

    for (const sheetName of Object.keys(jobsBySheet)) {
      const jobs = jobsBySheet[sheetName].reverse();

      const worksheetData = jobs.map((job, index) => ({
        "Serial No": index + 1,
        "Job Title": job.title,
        "Job Site Name": job.site,
        "Job Link": job.url,
        "Extracted JD": job.jd,
        "Reason for Rejection": job.reason,
        "Scraped At": job.scraped_at,
      }));

      const worksheet = XLSX.utils.json_to_sheet(worksheetData);
      // Sheet names in Excel have a 31 char limit.
      // "randstadusa - Detail" is 20 chars, so we should be safe for now.
      // But let's truncate just in case.
      const safeSheetName = sheetName.slice(0, 31);
      XLSX.utils.book_append_sheet(workbook, worksheet, safeSheetName);
    }

    // Ensure directory exists
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    XLSX.writeFile(workbook, outputPath);
    console.log(
      `[RejectedLogger] Saved ${this.rejectedJobs.length} rejected jobs to ${outputPath}`
    );
  }
}

export const rejectedLogger = new RejectedLogger();
