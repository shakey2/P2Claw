/**
 * P2 Claw — Tool: forget
 *
 * Deletes a specific memory by ID. The user can trigger this via
 * natural language ("forget that I like dark mode") — the LLM should
 * first recall the memory to find the ID, then call forget with it.
 */

import type { ToolDefinition } from "./registry.js";
import { deleteMemory, getMemory } from "../memory/index.js";

interface ForgetArgs {
  memory_id: number;
}

const forget: ToolDefinition = {
  schema: {
    type: "function" as const,
    function: {
      name: "forget",
      description:
        "Delete a specific memory by its ID. Use this when the user asks you to " +
        "forget something. First use the recall tool to find the memory and its ID, " +
        "then call forget with that ID. Always confirm with the user what you're deleting.",
      parameters: {
        type: "object",
        properties: {
          memory_id: {
            type: "number",
            description: "The ID of the memory to delete. Get this from the recall tool.",
          },
        },
        required: ["memory_id"],
      },
    },
  },

  handler: async (
    rawArgs: Record<string, unknown>,
    chatId?: number
  ): Promise<string> => {
    const args = rawArgs as unknown as ForgetArgs;

    if (!chatId) {
      return JSON.stringify({ error: "No chat context available." });
    }

    if (typeof args.memory_id !== "number" || !Number.isInteger(args.memory_id)) {
      return JSON.stringify({ error: "memory_id must be an integer." });
    }

    // Check if the memory exists first (for a better error message)
    const existing = getMemory(chatId, args.memory_id);
    if (!existing) {
      return JSON.stringify({
        success: false,
        message: `Memory #${args.memory_id} not found (or belongs to a different chat).`,
      });
    }

    const deleted = deleteMemory(chatId, args.memory_id);

    if (deleted) {
      return JSON.stringify({
        success: true,
        message: `Memory #${args.memory_id} deleted: "${existing.content}"`,
      });
    }

    return JSON.stringify({
      success: false,
      message: `Failed to delete memory #${args.memory_id}.`,
    });
  },
};

export default forget;
