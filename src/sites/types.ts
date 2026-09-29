export interface RunOptions {
  /**
   * When provided, bypass scraping and re-run AI filtering/detail evaluation against an existing session ID.
   */
  resumeSessionId?: string;
  /**
   * Optional list of keywords to override config.
   */
  keywords?: string[];
}
