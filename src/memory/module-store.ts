/**
 * P2 Claw — Module-scoped key/value store.
 *
 * Backs `ctx.memory.read/write` on the capability broker. Each row in
 * `module_memory` is owned by exactly one module_id, so there is no way for
 * module A to observe or overwrite module B's keys through this API.
 *
 * Strictly a text KV store — keep values small and serialise larger payloads
 * yourself. Binary blobs are explicitly out of scope (Phase 1.5 non-goal).
 *
 * Schema is created in src/memory/db.ts `createSchema`.
 */

import { getDb, scheduleSave } from "./db.js";

/** Maximum allowed length of a module memory key (codepoints). */
export const MAX_MODULE_MEMORY_KEY_LENGTH = 128;

/** Maximum allowed byte length of a module memory value (UTF-8). */
export const MAX_MODULE_MEMORY_VALUE_BYTES = 64 * 1024;

/**
 * Error thrown when a module-memory call is refused for input reasons
 * (oversize key/value). Kept distinct from `PermissionDeniedError` because
 * it's an input-shape problem, not a capability gate decision.
 */
export class ModuleMemoryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModuleMemoryInputError";
  }
}

function assertKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new ModuleMemoryInputError("module memory key must be a non-empty string");
  }
  if (key.length > MAX_MODULE_MEMORY_KEY_LENGTH) {
    throw new ModuleMemoryInputError(
      `module memory key exceeds ${MAX_MODULE_MEMORY_KEY_LENGTH} characters`
    );
  }
}

function assertValue(value: string): void {
  if (typeof value !== "string") {
    throw new ModuleMemoryInputError("module memory value must be a string");
  }
  const bytes = Buffer.byteLength(value, "utf-8");
  if (bytes > MAX_MODULE_MEMORY_VALUE_BYTES) {
    throw new ModuleMemoryInputError(
      `module memory value exceeds ${MAX_MODULE_MEMORY_VALUE_BYTES} bytes (got ${bytes})`
    );
  }
}

/**
 * Reads a single module-scoped key. Returns `null` if not set.
 * `moduleId` is supplied by the broker from the caller's manifest — module
 * code never passes this directly.
 */
export function readModuleMemory(moduleId: string, key: string): string | null {
  assertKey(key);
  const db = getDb();
  const stmt = db.prepare(
    "SELECT value FROM module_memory WHERE module_id = ? AND key = ? LIMIT 1"
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
 * Writes a module-scoped key/value pair. Overwrites any existing row for the
 * same (module_id, key) pair. Persistence is debounced through
 * `scheduleSave()` — same path the rest of the memory layer uses.
 */
export function writeModuleMemory(
  moduleId: string,
  key: string,
  value: string
): void {
  assertKey(key);
  assertValue(value);
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO module_memory (module_id, key, value, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(module_id, key) DO UPDATE SET
       value = excluded.value,
       updated_at = datetime('now')`
  );
  try {
    stmt.bind([moduleId, key, value]);
    stmt.step();
  } finally {
    stmt.free();
  }
  scheduleSave();
}
