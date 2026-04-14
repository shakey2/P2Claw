/**
 * P2 Claw — Memory store.
 *
 * CRUD operations for persistent memories backed by SQLite + FTS5.
 * All operations are scoped by chat_id — memories never leak between
 * chats. Write operations trigger a debounced save to disk.
 */

import { getDb, scheduleSave, isFts5Available } from "./db.js";

// ── Types ───────────────────────────────────────────────────────

export interface Memory {
  id: number;
  chat_id: number;
  content: string;
  category: string;
  created_at: string;
  updated_at: string;
}

/** Valid memory categories. Kept simple — complexity can come later. */
export const MEMORY_CATEGORIES = [
  "general",
  "preferences",
  "facts",
  "people",
  "core",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

// ── Create ──────────────────────────────────────────────────────

/**
 * Stores a new memory for a specific chat.
 *
 * @returns The ID of the newly created memory
 */
export function addMemory(
  chatId: number,
  content: string,
  category: MemoryCategory = "general"
): number {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO memories (chat_id, content, category) VALUES (?, ?, ?)`
  );
  stmt.run([chatId, content, category]);
  stmt.free();

  // Get the last inserted row ID
  const result = db.exec("SELECT last_insert_rowid() as id");
  const id = (result[0]?.values[0]?.[0] as number) ?? 0;

  scheduleSave();
  return id;
}

// ── Read ────────────────────────────────────────────────────────

/**
 * Searches memories using FTS5 (if available) or LIKE fallback.
 * Results are ranked by relevance.
 */
export function searchMemories(
  chatId: number,
  query: string,
  limit: number = 10
): Memory[] {
  if (isFts5Available()) {
    return searchMemoriesFts5(chatId, query, limit);
  }
  return searchMemoriesLike(chatId, query, limit);
}

/**
 * FTS5-based search with bm25() ranking.
 * Only called when FTS5 is confirmed available.
 */
function searchMemoriesFts5(
  chatId: number,
  query: string,
  limit: number
): Memory[] {
  const db = getDb();

  // Escape FTS5 special characters in the query to prevent syntax errors
  const safeQuery = sanitizeFtsQuery(query);
  if (!safeQuery) return [];

  const stmt = db.prepare(`
    SELECT m.id, m.chat_id, m.content, m.category, m.created_at, m.updated_at
    FROM memories m
    JOIN memories_fts fts ON m.id = fts.rowid
    WHERE memories_fts MATCH ?
      AND m.chat_id = ?
      AND m.category != 'core'
    ORDER BY bm25(memories_fts)
    LIMIT ?
  `);
  stmt.bind([safeQuery, chatId, limit]);

  const results: Memory[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as unknown as Memory;
    results.push(row);
  }
  stmt.free();
  return results;
}

/**
 * LIKE-based fallback search for when FTS5 is not available.
 * Scores results by counting how many query words appear in the content.
 * For a personal agent with <10K memories, this is plenty fast.
 */
function searchMemoriesLike(
  chatId: number,
  query: string,
  limit: number
): Memory[] {
  const db = getDb();

  // Tokenize query into words (lowercase, min 2 chars)
  const words = query
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .filter((w) => !STOP_WORDS.has(w));

  if (words.length === 0) return [];

  // Build scoring expression: each matching word adds 1 point
  const scoreParts = words.map(
    () => `(CASE WHEN LOWER(content) LIKE ? THEN 1 ELSE 0 END)`
  );
  const scoreExpr = scoreParts.join(" + ");
  const likeParams = words.map((w) => `%${w}%`);

  const sql = `
    SELECT id, chat_id, content, category, created_at, updated_at,
           (${scoreExpr}) as score
    FROM memories
    WHERE chat_id = ? AND score > 0 AND category != 'core'
    ORDER BY score DESC, updated_at DESC
    LIMIT ?
  `;

  const stmt = db.prepare(sql);
  stmt.bind([...likeParams, chatId, limit]);

  const results: Memory[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as unknown as Memory;
    results.push(row);
  }
  stmt.free();
  return results;
}

/**
 * Lists all memories for a chat, optionally filtered by category.
 */
export function listMemories(
  chatId: number,
  category?: string,
  limit: number = 50
): Memory[] {
  const db = getDb();

  let sql = `SELECT id, chat_id, content, category, created_at, updated_at
             FROM memories WHERE chat_id = ?`;
  const params: (string | number)[] = [chatId];

  if (category) {
    sql += ` AND category = ?`;
    params.push(category);
  }

  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  const stmt = db.prepare(sql);
  stmt.bind(params);

  const results: Memory[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as unknown as Memory;
    results.push(row);
  }
  stmt.free();
  return results;
}

/**
 * Gets a single memory by ID (scoped to chat for safety).
 */
export function getMemory(chatId: number, memoryId: number): Memory | null {
  const db = getDb();
  const stmt = db.prepare(
    `SELECT id, chat_id, content, category, created_at, updated_at
     FROM memories WHERE id = ? AND chat_id = ?`
  );
  stmt.bind([memoryId, chatId]);

  if (stmt.step()) {
    const row = stmt.getAsObject() as unknown as Memory;
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

// ── Delete ──────────────────────────────────────────────────────

/**
 * Deletes a memory by ID. Returns true if a row was actually deleted.
 * Scoped to chat_id to prevent cross-chat deletion.
 */
export function deleteMemory(chatId: number, memoryId: number): boolean {
  const db = getDb();
  const stmt = db.prepare(
    `DELETE FROM memories WHERE id = ? AND chat_id = ?`
  );
  stmt.run([memoryId, chatId]);
  stmt.free();

  const changes = db.getRowsModified();
  if (changes > 0) {
    scheduleSave();
  }
  return changes > 0;
}

// ── Context Injection ───────────────────────────────────────────

/**
 * Finds memories relevant to a user's message for context injection.
 *
 * Extracts meaningful words from the message and searches FTS5.
 * This is called before every LLM call to enrich the system prompt
 * with relevant memories.
 */
export function getRelevantContext(
  chatId: number,
  userMessage: string,
  limit: number = 5
): Memory[] {
  // Extract keywords: remove short words, punctuation, and stop words
  const words = userMessage
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .filter((w) => !STOP_WORDS.has(w));

  if (words.length === 0) return [];

  // Join with OR for broad matching
  const query = words.join(" OR ");
  return searchMemories(chatId, query, limit);
}

/**
 * Returns all 'core' memories for a chat.
 * These are injected directly into the system prompt.
 */
export function getCoreContext(chatId: number): Memory[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT id, chat_id, content, category, created_at, updated_at
    FROM memories
    WHERE chat_id = ? AND category = 'core'
    ORDER BY created_at ASC
  `);
  stmt.bind([chatId]);

  const results: Memory[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as unknown as Memory;
    results.push(row);
  }
  stmt.free();
  return results;
}

/**
 * Returns the total number of memories for a chat.
 */
export function getMemoryCount(chatId: number): number {
  const db = getDb();
  const result = db.exec(
    `SELECT COUNT(*) as count FROM memories WHERE chat_id = ?`,
    [chatId]
  );
  return (result[0]?.values[0]?.[0] as number) ?? 0;
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Sanitizes a query string for FTS5 MATCH syntax.
 * Removes special characters that would cause FTS5 parse errors.
 */
function sanitizeFtsQuery(query: string): string {
  return query
    .replace(/[*"(){}[\]:^~!@#$%&\\|<>=+\-/,;.?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Common English stop words to skip in context extraction */
const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all",
  "can", "had", "her", "was", "one", "our", "out", "has",
  "have", "from", "they", "been", "said", "each", "she",
  "which", "their", "will", "other", "about", "many",
  "then", "them", "these", "some", "would", "make",
  "like", "into", "time", "very", "when", "come",
  "could", "more", "than", "been", "its", "who",
  "did", "get", "may", "him", "his", "how", "man",
  "new", "now", "old", "see", "way", "day", "too",
  "any", "tell", "what", "this", "that", "with",
  "just", "your", "also", "know", "does", "think",
]);
