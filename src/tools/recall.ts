/**
 * P2 Claw — Tool: recall
 *
 * Searches persistent memories using full-text search (FTS5).
 * The LLM calls this when the user asks about something that might
 * be stored in memory, or when it needs to retrieve context.
 */

import type { ToolDefinition } from "./registry.js";
import { searchMemories, listMemories } from "../memory/index.js";

interface RecallArgs {
  query?: string;
  category?: string;
  limit?: number;
}

const recall: ToolDefinition = {
  schema: {
    type: "function" as const,
    function: {
      name: "recall",
      description:
        "Search stored memories. Use this when the user asks about something " +
        "you might have remembered before, like their preferences, facts they shared, " +
        "or context from past conversations. You can search by keyword or list by category.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search query — keywords to find relevant memories. " +
              'Example: "dark mode" or "dog name". Leave empty to list all memories.',
          },
          category: {
            type: "string",
            enum: ["general", "preferences", "facts", "people"],
            description:
              "Optional filter by category. Only returns memories in this category.",
          },
          limit: {
            type: "number",
            description:
              "Maximum number of memories to return. Defaults to 10.",
          },
        },
        required: [],
      },
    },
  },

  handler: async (
    rawArgs: Record<string, unknown>,
    chatId?: number
  ): Promise<string> => {
    const args = rawArgs as RecallArgs;

    if (!chatId) {
      return JSON.stringify({ error: "No chat context available." });
    }

    const limit = Math.min(args.limit ?? 10, 50);

    // If a search query is provided, use FTS5 search
    if (args.query?.trim()) {
      const results = searchMemories(chatId, args.query.trim(), limit);

      if (results.length === 0) {
        return JSON.stringify({
          results: [],
          message: `No memories found matching "${args.query}".`,
        });
      }

      return JSON.stringify({
        results: results.map((m) => ({
          id: m.id,
          content: m.content,
          category: m.category,
          created_at: m.created_at,
        })),
        count: results.length,
      });
    }

    // No query — list memories (optionally filtered by category)
    const results = listMemories(
      chatId,
      args.category ?? undefined,
      limit
    );

    if (results.length === 0) {
      const categoryNote = args.category
        ? ` in category "${args.category}"`
        : "";
      return JSON.stringify({
        results: [],
        message: `No memories stored${categoryNote}.`,
      });
    }

    return JSON.stringify({
      results: results.map((m) => ({
        id: m.id,
        content: m.content,
        category: m.category,
        created_at: m.created_at,
      })),
      count: results.length,
    });
  },
};

export default recall;
