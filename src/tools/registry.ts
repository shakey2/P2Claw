/**
 * P2 Claw — Tool registry.
 *
 * Central registry that maps tool names to their schemas and handlers.
 * All tools register here so the agent loop can discover and invoke them.
 *
 * Tools receive an optional chatId parameter so chat-scoped tools
 * (like memory operations) can operate on the correct chat's data.
 *
 * Level 4: tools may declare `risk: "high"` — execution waits for TOTP approval
 * (Telegram APPROVE message) before the handler runs.
 */

import type OpenAI from "openai";
import {
  createChallenge,
  waitForApproval,
  APPROVAL_TTL_MS,
} from "../security/approval.js";
import type { ToolDefinition, ExecuteToolOptions } from "./tool-types.js";

export type { ToolDefinition, ToolRisk, ExecuteToolOptions } from "./tool-types.js";

// ── Import all tools ────────────────────────────────────────────
import getCurrentTime from "./get-current-time.js";
import remember from "./remember.js";
import recall from "./recall.js";
import forget from "./forget.js";
import highRiskDemo from "./high-risk-demo.js";

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
register(highRiskDemo);

/**
 * Returns all tool schemas for the LLM's `tools` parameter.
 */
export function getAllToolSchemas(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return Array.from(tools.values()).map((t) => t.schema);
}

function normalizeExecuteOptions(
  options?: number | ExecuteToolOptions
): ExecuteToolOptions {
  if (typeof options === "number") {
    return { chatId: options };
  }
  return options ?? {};
}

/**
 * Executes a tool by name with the given arguments.
 * Returns the string result, or an error string if the tool is unknown.
 *
 * @param name - The tool function name
 * @param args - Parsed arguments from the LLM
 * @param options - Chat ID and/or approval channel for high-risk tools
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  options?: number | ExecuteToolOptions
): Promise<string> {
  const opts = normalizeExecuteOptions(options);

  const tool = tools.get(name);
  if (!tool) {
    return JSON.stringify({
      error: `Unknown tool: "${name}". Available tools: ${Array.from(tools.keys()).join(", ")}`,
    });
  }

  const risk = tool.risk ?? "safe";

  if (risk === "high") {
    const secret = opts.totpSecretBase32?.trim();
    if (!secret) {
      return JSON.stringify({
        error:
          "High-risk tools require TOTP. Set TOTP_SECRET_BASE32 in .env and restart.",
      });
    }
    if (!opts.sendPendingApproval) {
      return JSON.stringify({
        error:
          "Cannot request approval: no notification channel (internal error).",
      });
    }
    if (opts.chatId === undefined) {
      return JSON.stringify({
        error: "chatId required for high-risk tools.",
      });
    }

    const { challengeId, summary } = createChallenge(opts.chatId, name, args);

    const prompt =
      `High-risk action: ${name}\n` +
      `Bound payload: ${summary}\n\n` +
      `Reply in this chat with only your 6-digit authenticator code (within ${Math.round(APPROVAL_TTL_MS / 1000)}s).\n` +
      `Optional: APPROVE ${challengeId} <code> — same binding.`;

    const approvalPromise = waitForApproval(challengeId);

    await opts.sendPendingApproval(prompt);

    const approved = await approvalPromise;
    if (!approved) {
      return JSON.stringify({
        error: "High-risk action not approved (timeout or cancelled).",
      });
    }
  }

   const memoryKey = opts.memoryScopeId ?? opts.chatId;

  try {
    return await tool.handler(args, memoryKey);
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
