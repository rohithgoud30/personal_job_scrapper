import { JobRow } from "../lib/csv";

export interface RunOptions {
  /**
   * When true, skip the polite sleep between keyword batches so AI filtering can start sooner.
   */
  skipBatchPause?: boolean;
  /**
   * When provided, bypass scraping and re-run AI filtering/detail evaluation against an existing session ID.
   */
  resumeSessionId?: string;
  /**
   * Optional list of keywords to override config.
   */
  keywords?: string[];
  /**
   * Called each time a job passes detail evaluation and is accepted.
   * Used by the HTTP server for live-mode SSE streaming.
   */
  onJobAccepted?: (job: JobRow) => void;
}
