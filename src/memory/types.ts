/**
 * P2 Claw — Modular Memory Provider Abstraction
 * 
 * Defines the standard interface for any memory storage backend 
 * (e.g. SQLite Lexical, Pinecone Vector, local Transformers.js Vector).
 */

export interface Memory {
  id: number;
  chat_id: number;
  content: string;
  category: string;
  created_at: string;
  updated_at: string;
}

export type MemoryCategory = "general" | "preferences" | "facts" | "people" | "core" | string;

export interface IMemoryProvider {
  /**
   * Called automatically when the provider is registered.
   * Useful for spinning up connections or checking schema.
   */
  init(): Promise<void>;

  /**
   * Called tightly on shutdown to ensure graceful disconnections.
   */
  close(): Promise<void>;

  /**
   * Persists a string into the database.
   * @param chatId Telegram Chat ID
   * @param content Raw memory text
   * @param category Defaults to 'general'
   * @returns unique memory ID
   */
  addMemory(chatId: number, content: string, category?: MemoryCategory): Promise<number>;

  /**
   * Primary search retrieval (e.g. FTS5 BM25, or Vector Cosine Distance).
   */
  searchMemories(chatId: number, query: string, limit?: number): Promise<Memory[]>;

  /**
   * Utility for pure list listing. Usually ordered newest first.
   */
  listMemories(chatId: number, category?: string, limit?: number): Promise<Memory[]>;

  /**
   * Fetches an exact memory block by ID.
   */
  getMemory(chatId: number, memoryId: number): Promise<Memory | null>;

  /**
   * Deletes a specific memory block.
   */
  deleteMemory(chatId: number, memoryId: number): Promise<boolean>;

  /**
   * Agent loop entry point for pulling immediate semantic context from a prompt.
   */
  getRelevantContext(chatId: number, userMessage: string, limit?: number): Promise<Memory[]>;

  /**
   * Agent loop entry point for pulling foundational constraints ALWAYS into the system prompt.
   */
  getCoreContext(chatId: number): Promise<Memory[]>;

  /**
   * Utility statistic checker.
   */
  getMemoryCount(chatId: number): Promise<number>;
}
