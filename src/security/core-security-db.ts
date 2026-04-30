/**
 * Security-owned SQLite database.
 *
 * Keep durable grants and approval metadata out of p2claw.db so memory/general
 * state can never become the authority for security decisions.
 */

import initSqlJs, { type Database } from "sql.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_DB_PATH = join(PKG_ROOT, "data", "core_security.db");
const SAVE_DEBOUNCE_MS = 1_000;

function getSecurityDbPath(): string {
  return process.env.P2CLAW_SECURITY_DB_PATH?.trim() || DEFAULT_DB_PATH;
}

let db: Database | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export async function initCoreSecurityDatabase(): Promise<void> {
  const SQL = await initSqlJs();
  const dbPath = getSecurityDbPath();
  const dataDir = dirname(dbPath);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  if (existsSync(dbPath)) {
    db = new SQL.Database(readFileSync(dbPath));
    log.info(`Loaded core security database from ${dbPath}`);
  } else {
    db = new SQL.Database();
    log.info("Created new core security database");
  }

  createSchema(db);
  saveCoreSecurityDatabase();
}

export function getCoreSecurityDb(): Database {
  if (!db) {
    throw new Error("Core security database not initialised. Call initCoreSecurityDatabase() first.");
  }
  return db;
}

function createSchema(activeDb: Database): void {
  activeDb.exec(`
    CREATE TABLE IF NOT EXISTS capabilities (
      id TEXT PRIMARY KEY,
      tool TEXT NOT NULL,
      permission TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_path TEXT,
      scope_pattern TEXT,
      scope_command TEXT,
      constraints_json TEXT,
      risk_level TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      persistent INTEGER NOT NULL DEFAULT 1,
      granted_via TEXT NOT NULL
    );
  `);

  activeDb.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      tool TEXT NOT NULL,
      permission TEXT,
      outcome TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  activeDb.exec(`
    CREATE TABLE IF NOT EXISTS totp_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export function scheduleCoreSecuritySave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveCoreSecurityDatabase();
    saveTimer = null;
  }, SAVE_DEBOUNCE_MS);
}

export function saveCoreSecurityDatabase(): void {
  if (!db) return;
  const dbPath = getSecurityDbPath();
  const dataDir = dirname(dbPath);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  writeFileSync(dbPath, Buffer.from(db.export()));
}

export function closeCoreSecurityDatabase(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (db) {
    saveCoreSecurityDatabase();
    db.close();
    db = null;
  }
}
