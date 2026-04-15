/**
 * P2 Claw — Memory module barrel export & Provider Router.
 *
 * All external modules call these transparent, asynchronous generic functions.
 * Underneath, requests are routed to the dynamically active Memory Provider.
 */

import type { VoiceOutputMode } from "../config.js";
import { initDatabase, saveDatabase, closeDatabase, isFts5Available } from "./db.js";
import * as RawStore from "./store.js";
import { IMemoryProvider, Memory, MemoryCategory } from "./types.js";

// Export standard types and db tooling
export { initDatabase, saveDatabase, closeDatabase, isFts5Available };
export type { Memory, MemoryCategory, IMemoryProvider };
export { MEMORY_CATEGORIES } from "./store.js";

/** 
 * Default Implementation wrappers matching the old synchronous SQL flow 
 * mapped gracefully to the asynchronous generic provider contract.
 */
export const SqliteMemoryProvider: IMemoryProvider = {
  init: async () => { await initDatabase(); },
  close: async () => { closeDatabase(); },
  addMemory: async (chatId, content, category) => RawStore.addMemory(chatId, content, category as any),
  searchMemories: async (chatId, query, limit) => RawStore.searchMemories(chatId, query, limit),
  listMemories: async (chatId, category, limit) => RawStore.listMemories(chatId, category, limit),
  getMemory: async (chatId, memoryId) => RawStore.getMemory(chatId, memoryId),
  deleteMemory: async (chatId, memoryId) => RawStore.deleteMemory(chatId, memoryId),
  getRelevantContext: async (chatId, msg, limit) => RawStore.getRelevantContext(chatId, msg, limit),
  getCoreContext: async (chatId) => RawStore.getCoreContext(chatId),
  getMemoryCount: async (chatId) => RawStore.getMemoryCount(chatId),
};

// ── The Stateful Router ───────────────────────────────────────

let activeProvider: IMemoryProvider = SqliteMemoryProvider;

/**
 * Registers an alternative memory provider (e.g., Vector RAG Module).
 */
export function registerMemoryProvider(provider: IMemoryProvider) {
  activeProvider = provider;
}

// ── Dynamic Proxies ───────────────────────────────────────────

export async function addMemory(chatId: number, content: string, category: string = "general"): Promise<number> {
  return activeProvider.addMemory(chatId, content, category);
}

export async function searchMemories(chatId: number, query: string, limit?: number): Promise<Memory[]> {
  return activeProvider.searchMemories(chatId, query, limit);
}

export async function listMemories(chatId: number, category?: string, limit?: number): Promise<Memory[]> {
  return activeProvider.listMemories(chatId, category, limit);
}

export async function getMemory(chatId: number, memoryId: number): Promise<Memory | null> {
  return activeProvider.getMemory(chatId, memoryId);
}

export async function deleteMemory(chatId: number, memoryId: number): Promise<boolean> {
  return activeProvider.deleteMemory(chatId, memoryId);
}

export async function getRelevantContext(chatId: number, userMessage: string, limit?: number): Promise<Memory[]> {
  return activeProvider.getRelevantContext(chatId, userMessage, limit);
}

export async function getCoreContext(chatId: number): Promise<Memory[]> {
  return activeProvider.getCoreContext(chatId);
}

export async function getMemoryCount(chatId: number): Promise<number> {
  return activeProvider.getMemoryCount(chatId);
}

/** Per-chat voice output mode (persisted in SQLite). */
export async function getChatVoiceMode(chatId: number): Promise<VoiceOutputMode | null> {
  return RawStore.getChatVoiceMode(chatId);
}

export async function setChatVoiceMode(chatId: number, mode: VoiceOutputMode): Promise<boolean> {
  return RawStore.setChatVoiceMode(chatId, mode);
}
