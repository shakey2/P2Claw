/**
 * P2 Claw — Module settings store.
 *
 * CRUD layer for the `module_settings` SQLite table. Each row is owned by
 * exactly one module_id — module A cannot read or write module B's settings
 * through this API (the broker enforces moduleId scoping).
 *
 * Values are stored as JSON-encoded strings so booleans and numbers
 * round-trip correctly. Core validates values against the module's
 * SettingFieldDescriptor schema before calling write operations here.
 *
 * Part H — Module Settings And HTML Contribution Hooks.
 */

import { getDb, scheduleSave } from "../../memory/db.js";

/** Maximum byte length of a JSON-encoded settings value (same as module memory). */
export const MAX_SETTING_VALUE_BYTES = 64 * 1024;

/**
 * Reads a single setting value for a module. Returns the raw JSON-encoded
 * string or `null` if not set.
 */
export function readModuleSetting(moduleId: string, key: string): string | null {
  const db = getDb();
  const stmt = db.prepare(
    "SELECT value FROM module_settings WHERE module_id = ? AND key = ? LIMIT 1"
  );
  try {
    stmt.bind([moduleId, key]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      return typeof row.value === "string" ? row.value : null;
    }
    return null;
  } finally {
    stmt.free();
  }
}

/**
 * Reads all stored settings for a module. Returns a map of key → JSON-encoded
 * value. Used by the settings API endpoint to return all current values.
 */
export function readAllModuleSettings(moduleId: string): Map<string, string> {
  const db = getDb();
  const stmt = db.prepare(
    "SELECT key, value FROM module_settings WHERE module_id = ?"
  );
  const result = new Map<string, string>();
  try {
    stmt.bind([moduleId]);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      if (typeof row.key === "string" && typeof row.value === "string") {
        result.set(row.key, row.value);
      }
    }
  } finally {
    stmt.free();
  }
  return result;
}

/**
 * Writes a module setting value (JSON-encoded). Overwrites any existing row
 * for the same (module_id, key) pair. Persistence is debounced through
 * `scheduleSave()` — same path as module_memory/memories.
 */
export function writeModuleSetting(
  moduleId: string,
  key: string,
  jsonValue: string
): void {
  if (Buffer.byteLength(jsonValue, "utf-8") > MAX_SETTING_VALUE_BYTES) {
    throw new Error(
      `module setting value exceeds ${MAX_SETTING_VALUE_BYTES} bytes`
    );
  }
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO module_settings (module_id, key, value, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(module_id, key) DO UPDATE SET
       value = excluded.value,
       updated_at = datetime('now')`
  );
  try {
    stmt.bind([moduleId, key, jsonValue]);
    stmt.step();
  } finally {
    stmt.free();
  }
  scheduleSave();
}

/**
 * Seeds default values for any settings fields that don't already have a
 * stored value. Called once at module load time after schema validation.
 */
export function seedSettingDefaults(
  moduleId: string,
  fields: ReadonlyArray<{ key: string; default: string | number | boolean }>
): void {
  for (const field of fields) {
    const existing = readModuleSetting(moduleId, field.key);
    if (existing === null) {
      writeModuleSetting(moduleId, field.key, JSON.stringify(field.default));
    }
  }
}
