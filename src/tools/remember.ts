/**
 * P2 Claw — Tool: remember
 *
 * Stores a fact, preference, or piece of context as a persistent memory.
 * The LLM calls this when the user shares something worth remembering,
 * or when it determines a piece of information should be retained.
 */

import type { ToolDefinition } from "./registry.js";
import { addMemory, MEMORY_CATEGORIES, type MemoryCategory } from "../memory/index.js";

interface RememberArgs {
  content: string;
  category?: string;
}

const remember: ToolDefinition = {
  schema: {
    type: "function" as const,
    function: {
      name: "remember",
      description:
        "Store a memory — a fact, preference, or piece of context about the user. " +
        "You MUST use this tool whenever the user says 'remember', 'remember that', 'don't forget', or shares something they want you to keep for future conversations. " +
        "Do not just acknowledge it in text — always call this tool so the memory is persisted.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "The memory to store. Should be a clear, concise statement. " +
              'Example: "User prefers dark mode" or "User\'s dog is named Max".',
          },
          category: {
            type: "string",
            enum: [...MEMORY_CATEGORIES],
            description:
              "Category for the memory. " +
              '"preferences" for user preferences, ' +
              '"facts" for factual information, ' +
              '"people" for info about people the user knows, ' +
              '"general" for everything else. Defaults to "general".',
          },
        },
        required: ["content"],
      },
    },
  },

  handler: async (
    rawArgs: Record<string, unknown>,
    chatId?: number
  ): Promise<string> => {
    const args = rawArgs as unknown as RememberArgs;

    if (!args.content?.trim()) {
      return JSON.stringify({ error: "Memory content cannot be empty." });
    }

    if (!chatId) {
      return JSON.stringify({ error: "No chat context available." });
    }

    // Validate category
    const category = (args.category as MemoryCategory) || "general";
    if (!MEMORY_CATEGORIES.includes(category)) {
      return JSON.stringify({
        error: `Invalid category "${args.category}". Valid: ${MEMORY_CATEGORIES.join(", ")}`,
      });
    }

    const id = addMemory(chatId, args.content.trim(), category);

    return JSON.stringify({
      success: true,
      memory_id: id,
      message: `Memory #${id} saved under "${category}".`,
    });
  },
};

export default remember;
