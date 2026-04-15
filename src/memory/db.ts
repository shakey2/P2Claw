/**
 * P2 Claw — SQLite database engine.
 *
 * Uses sql.js (pure WASM) instead of native bindings to avoid
 * AV/EDR false positives from unsigned native modules (§2.1.6).
 *
 * sql.js runs entirely in-memory, so we manage persistence ourselves:
 *   - Debounced auto-save: writes to disk 1s after the last mutation
 *   - Immediate save on shutdown (SIGINT/SIGTERM)
 *   - Load from file on boot (or create fresh if no file exists)
 *
 * IMPORTANT: sql.js requires db.exec() for DDL (CREATE TABLE, triggers),
 * not db.run(). db.run() silently fails for virtual table creation.
 *
 * Database file: data/p2claw.db
 */

import initSqlJs, { type Database } from "sql.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { log } from "../logger.js";

const DB_PATH = join(process.cwd(), "data", "p2claw.db");
const SAVE_DEBOUNCE_MS = 1_000;

let _db: Database | null = null;

/** Whether FTS5 virtual table was created successfully. */
let _fts5Available = false;

/**
 * Returns true if FTS5 full-text search is available.
 * Other modules should check this before attempting FTS5 queries.
 */
export function isFts5Available(): boolean {
  return _fts5Available;
}

let _saveTimer: ReturnType<typeof setTimeout> | null = null;

// ── Initialisation ──────────────────────────────────────────────

/**
 * Initialises the SQLite database.
 *
 * Loads from data/p2claw.db if it exists, otherwise creates a fresh
 * database and runs the schema. Must be called once at boot before
 * any memory operations.
 */
export async function initDatabase(): Promise<void> {
  const SQL = await initSqlJs();

  // Ensure data/ directory exists
  const dataDir = dirname(DB_PATH);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Load existing database or create fresh
  if (existsSync(DB_PATH)) {
    const fileBuffer = readFileSync(DB_PATH);
    _db = new SQL.Database(fileBuffer);
    log.info(`Loaded existing database from ${DB_PATH}`);
    console.log(`   ✓ Loaded existing database from ${DB_PATH}`);
  } else {
    _db = new SQL.Database();
    log.info("Created new database");
    console.log(`   ✓ Created new database`);
  }

  // Run schema (CREATE IF NOT EXISTS — safe to run every boot)
  createSchema(_db);

  // Attempt FTS5 setup — non-fatal if it fails
  _fts5Available = tryCreateFts5(_db);

  // Persist immediately so new tables survive a crash before the
  // first debounced save fires (this was a bug — schema changes
  // were only in memory until the first write operation).
  saveDatabase();
}

/**
 * Returns the active database instance. Throws if not yet initialised.
 */
export function getDb(): Database {
  if (!_db) {
    throw new Error("Database not initialised. Call initDatabase() first.");
  }
  return _db;
}

// ── Schema ──────────────────────────────────────────────────────

/**
 * Creates the core database schema (non-FTS tables).
 *
 * Uses db.exec() for all DDL — db.run() silently fails for
 * some DDL statements in sql.js.
 */
function createSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_preferences (
      chat_id INTEGER PRIMARY KEY NOT NULL,
      voice_mode TEXT NOT NULL DEFAULT 'off',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  log.info("Core database schema applied");
}

/**
 * Attempts to create the FTS5 virtual table and sync triggers.
 * Returns true if FTS5 is available, false otherwise.
 *
 * FTS5 may not be available in all sql.js WASM builds. If it fails,
 * the memory system falls back to LIKE-based search (see store.ts).
 * This is non-fatal by design — memory still works, just slower on
 * large datasets (irrelevant for a personal agent with <10K entries).
 */
function tryCreateFts5(db: Database): boolean {
  try {
    // FTS5 virtual table for full-text search on memory content.
    // content='memories' makes it an "external content" table — we manage
    // the content ourselves via triggers for insert/delete sync.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        category,
        content='memories',
        content_rowid='id',
        tokenize='unicode61'
      );
    `);

    // Sync triggers: keep FTS index in sync with the memories table.
    db.exec(`DROP TRIGGER IF EXISTS memories_ai;`);
    db.exec(`
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, category)
        VALUES (new.id, new.content, new.category);
      END;
    `);

    db.exec(`DROP TRIGGER IF EXISTS memories_ad;`);
    db.exec(`
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, category)
        VALUES ('delete', old.id, old.content, old.category);
      END;
    `);

    db.exec(`DROP TRIGGER IF EXISTS memories_au;`);
    db.exec(`
      CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, category)
        VALUES ('delete', old.id, old.content, old.category);
        INSERT INTO memories_fts(rowid, content, category)
        VALUES (new.id, new.content, new.category);
      END;
    `);

    // Verify the table actually exists and is queryable
    db.exec(`SELECT * FROM memories_fts LIMIT 0`);

    log.info("FTS5 full-text search enabled");
    console.log("   ✓ FTS5 full-text search enabled");
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`FTS5 not available, using LIKE fallback: ${msg}`);
    console.warn(`   ⚠️  FTS5 not available — using LIKE-based search (still works fine)`);
    console.warn(`      Reason: ${msg}`);
    return false;
  }
}

// ── Persistence ─────────────────────────────────────────────────

/**
 * Schedules a debounced save to disk. Call this after any write
 * operation. If multiple writes happen within SAVE_DEBOUNCE_MS,
 * only the last one triggers the actual file write.
 */
export function scheduleSave(): void {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
  }

  _saveTimer = setTimeout(() => {
    saveDatabase();
    _saveTimer = null;
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Immediately saves the database to disk. Call this during
 * shutdown to ensure no data is lost.
 */
export function saveDatabase(): void {
  if (!_db) return;

  const data = _db.export();
  const buffer = Buffer.from(data);

  // Ensure data/ directory exists (defensive — should already exist)
  const dataDir = dirname(DB_PATH);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  writeFileSync(DB_PATH, buffer);
  log.debug("Database saved to disk");
}

/**
 * Closes the database and cancels any pending save timer.
 * Saves to disk before closing.
 */
export function closeDatabase(): void {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }

  if (_db) {
    saveDatabase();
    _db.close();
    _db = null;
    log.info("Database closed");
  }
}
