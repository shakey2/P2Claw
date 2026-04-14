/**
 * P2 Claw — Tool registry.
 *
 * Central registry that maps tool names to their schemas and handlers.
 * All tools register here so the agent loop can discover and invoke them.
 *
 * Tools receive an optional chatId parameter so chat-scoped tools
 * (like memory operations) can operate on the correct chat's data.
 */

import type OpenAI from "openai";

export interface ToolDefinition {
  /** OpenAI-compatible tool schema sent to the LLM */
  schema: OpenAI.Chat.Completions.ChatCompletionTool;

  /**
   * Executes the tool and returns a string result for the LLM.
   * @param args - Parsed arguments from the LLM's tool call
   * @param chatId - The active Telegram chat ID (for chat-scoped tools)
   */
  handler: (args: Record<string, unknown>, chatId?: number) => Promise<string>;
}

// ── Import all tools ────────────────────────────────────────────
import getCurrentTime from "./get-current-time.js";
import remember from "./remember.js";
import recall from "./recall.js";
import forget from "./forget.js";

// ── Registry ────────────────────────────────────────────────────
const tools: Map<string, ToolDefinition> = new Map();

function register(tool: ToolDefinition): void {
  const name = tool.schema.function.name;
  if (tools.has(name)) {
    throw new Error(`Duplicate tool name: "${name}"`);
  }
  tools.set(name, tool);
}

// Register all built-in tools
register(getCurrentTime);
register(remember);
register(recall);
register(forget);

/**
 * Returns all tool schemas for the LLM's `tools` parameter.
 */
export function getAllToolSchemas(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return Array.from(tools.values()).map((t) => t.schema);
}

/**
 * Executes a tool by name with the given arguments.
 * Returns the string result, or an error string if the tool is unknown.
 *
 * @param name - The tool function name
 * @param args - Parsed arguments from the LLM
 * @param chatId - The active chat ID (for chat-scoped tools like memory)
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  chatId?: number
): Promise<string> {
  const tool = tools.get(name);
  if (!tool) {
    return JSON.stringify({ error: `Unknown tool: "${name}". Available tools: ${Array.from(tools.keys()).join(", ")}` });
  }

  try {
    return await tool.handler(args, chatId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: `Tool "${name}" failed: ${message}` });
  }
}

/**
 * Returns the number of registered tools.
 */
export function getToolCount(): number {
  return tools.size;
}
