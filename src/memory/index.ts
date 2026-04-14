/**
 * P2 Claw — Memory module barrel export.
 *
 * Re-exports everything needed from the memory subsystem so other
 * modules can import from "memory" without knowing the internal structure.
 */

export { initDatabase, saveDatabase, closeDatabase, isFts5Available } from "./db.js";
export {
  addMemory,
  searchMemories,
  listMemories,
  getMemory,
  deleteMemory,
  getRelevantContext,
  getCoreContext,
  getMemoryCount,
  MEMORY_CATEGORIES,
} from "./store.js";
export type { Memory, MemoryCategory } from "./store.js";
