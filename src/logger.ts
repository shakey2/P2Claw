/**
 * P2 Claw — File logger.
 *
 * Writes structured log entries to data/p2claw.log alongside console output.
 * Designed for post-mortem debugging — when a user reports an issue, they
 * can share this log file instead of transcribing terminal output.
 *
 * Log levels: ERROR, WARN, INFO, DEBUG
 *
 * The log file is append-only and auto-rotates when it exceeds 5 MB
 * (old content is truncated, keeping the most recent entries).
 *
 * This module is intentionally simple — no dependencies, no async I/O.
 * Writes are synchronous to ensure crash-safety (log entry is on disk
 * before the operation that might fail).
 */

import { appendFileSync, existsSync, statSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const LOG_PATH = join(process.cwd(), "data", "p2claw.log");
const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG";

/**
 * Formats and writes a log entry to the log file.
 */
function write(level: LogLevel, message: string): void {
  try {
    // Ensure data/ directory exists
    const dataDir = dirname(LOG_PATH);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    // Auto-rotate if log file exceeds max size
    if (existsSync(LOG_PATH)) {
      try {
        const stats = statSync(LOG_PATH);
        if (stats.size > MAX_LOG_SIZE_BYTES) {
          writeFileSync(LOG_PATH, `[${timestamp()}] [INFO] Log rotated (exceeded 5 MB)\n`);
        }
      } catch {
        // Stat failed — continue writing anyway
      }
    }

    const entry = `[${timestamp()}] [${level}] ${message}\n`;
    appendFileSync(LOG_PATH, entry, "utf-8");
  } catch {
    // Logger should never crash the app.
    // If we can't write to the log file, just continue silently.
  }
}

/**
 * Returns an ISO timestamp for log entries.
 */
function timestamp(): string {
  return new Date().toISOString();
}

// ── Public API ──────────────────────────────────────────────────

export const log = {
  /** Critical errors — things that break functionality */
  error(message: string): void {
    write("ERROR", message);
  },

  /** Warnings — things that might cause issues but aren't fatal */
  warn(message: string): void {
    write("WARN", message);
  },

  /** Informational — key lifecycle events (boot, shutdown, etc.) */
  info(message: string): void {
    write("INFO", message);
  },

  /** Debug — verbose details for troubleshooting */
  debug(message: string): void {
    write("DEBUG", message);
  },
};
