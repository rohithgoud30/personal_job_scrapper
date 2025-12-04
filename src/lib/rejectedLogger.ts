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

  public save(outputPath?: string): void {
    if (this.rejectedJobs.length === 0) {
      console.log("[RejectedLogger] No rejected jobs to save.");
      return;
    }

    // Default to centralized path if not provided
    const finalPath =
      outputPath || path.join(process.cwd(), "data", "rejected_jobs.xlsx");

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

    let workbook: XLSX.WorkBook;
    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(finalPath)) {
      try {
        workbook = XLSX.readFile(finalPath);
      } catch (error) {
        console.warn(
          `[RejectedLogger] Failed to read existing file at ${finalPath}. Creating new one.`,
          error
        );
        workbook = XLSX.utils.book_new();
      }
    } else {
      workbook = XLSX.utils.book_new();
    }

    // Get current date YYYY-MM-DD for the "Date" column
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];

    for (const sheetName of Object.keys(jobsBySheet)) {
      const newJobs = jobsBySheet[sheetName].reverse();
      // Sheet names in Excel have a 31 char limit.
      const safeSheetName = sheetName.slice(0, 31);

      let existingData: any[] = [];
      if (workbook.Sheets[safeSheetName]) {
        existingData = XLSX.utils.sheet_to_json(workbook.Sheets[safeSheetName]);
      }

      const newRows = newJobs.map((job, index) => ({
        "Serial No": existingData.length + index + 1,
        Date: dateStr,
        "Job Title": job.title,
        "Job Site Name": job.site,
        "Job Link": job.url,
        "Extracted JD": job.jd,
        "Reason for Rejection": job.reason,
        "Scraped At": job.scraped_at,
      }));

      const combinedData = [...existingData, ...newRows];
      const worksheet = XLSX.utils.json_to_sheet(combinedData);

      // If sheet exists, we need to replace it in the workbook object
      // XLSX doesn't have a direct "replace sheet" method, but assigning to Sheets[name] works
      // We also need to ensure it's in SheetNames if it wasn't before
      workbook.Sheets[safeSheetName] = worksheet;
      if (!workbook.SheetNames.includes(safeSheetName)) {
        XLSX.utils.book_append_sheet(workbook, worksheet, safeSheetName);
      }
    }

    XLSX.writeFile(workbook, finalPath);
    console.log(
      `[RejectedLogger] Saved ${this.rejectedJobs.length} new rejected jobs to ${finalPath}`
    );
  }
}

export const rejectedLogger = new RejectedLogger();
