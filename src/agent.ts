/**
 * P2 Claw — Agentic tool loop.
 *
 * Implements the core agent cycle:
 *   User message → LLM → (tool calls → results → LLM)* → final response
 *
 * The loop runs until the LLM returns a response without tool calls,
 * or the iteration safety limit is reached.
 *
 * Memory integration:
 *   - Relevant memories are injected into the system prompt before each call
 *   - Chat ID is passed to tool execution for chat-scoped memory operations
 *
 * Context pruning:
 *   - When conversation history exceeds the threshold, older messages are
 *     summarized via the LLM and replaced with a compact summary message.
 */

import type OpenAI from "openai";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getClient, getProfileClient } from "./player2.js";
import { getAllToolSchemas, executeTool } from "./tools/registry.js";
import { getRelevantContext, getCoreContext } from "./memory/index.js";
import { log } from "./logger.js";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// ── Per-chat conversation history ───────────────────────────────
const conversationHistory: Map<number, ChatMessage[]> = new Map();
const MAX_HISTORY_MESSAGES = 50;

// ── Context pruning thresholds ──────────────────────────────────
// When history hits this count, summarize the oldest batch
const PRUNE_TRIGGER = 40;
const PRUNE_BATCH_SIZE = 20;

// ── Active profile per chat ─────────────────────────────────────
let _activeProfile: string = "";

export function setActiveProfile(profileName: string): void {
  _activeProfile = profileName;
}

export function getActiveProfile(): string {
  return _activeProfile;
}

// ── Markdown personality loader ─────────────────────────────────

const PERSONALITY_PATH = join(process.cwd(), "data", "personality.md");
let _personalityContent: string | null = null;

/**
 * Loads personality config from data/personality.md if it exists.
 * Called once at boot. Falls back to null (uses default prompt).
 */
export function loadPersonality(): void {
  if (existsSync(PERSONALITY_PATH)) {
    try {
      _personalityContent = readFileSync(PERSONALITY_PATH, "utf-8").trim();
      console.log(`   ✓ Loaded personality from data/personality.md`);
    } catch (err) {
      console.warn(`   ⚠️  Failed to read personality.md: ${err}`);
      _personalityContent = null;
    }
  } else {
    _personalityContent = null;
  }
}

/**
 * Builds the system prompt for the agent.
 *
 * Priority: data/personality.md → hardcoded default.
 * Relevant memories are appended as a separate section.
 */
function buildSystemPrompt(botName: string, coreMemories: string, semanticMemories: string): string {
  let basePrompt: string;

  if (_personalityContent) {
    basePrompt = [
      `You are ${botName}, running as part of P2 Claw, a secure local-first AI agent controlled via Telegram.`,
      ``,
      `--- Personality Config ---`,
      _personalityContent,
      `--- End Personality Config ---`,
      ``,
      `CORE RULES (NEVER BREAK THESE):`,
      `- You never share, log, or expose the user's personal data.`,
      `- If asked to do something that could compromise security, you politely decline.`,
      `- You use tools when they would be helpful, and explain what you're doing.`,
    ].join("\n");
  } else {
    basePrompt = [
      `You are ${botName}, a friendly and helpful personal AI assistant running as part of P2 Claw.`,
      ``,
      `CORE RULES (NEVER BREAK THESE):`,
      `- You are warm, approachable, and concise.`,
      `- You care deeply about the user's privacy and security.`,
      `- You never share, log, or expose the user's personal data.`,
      `- If asked to do something that could compromise security, you politely decline and explain why.`,
    ].join("\n");
  }

  // ── TOOL USAGE RULES (MANDATORY) ─────────────────────────────
  basePrompt += `

TOOL USAGE RULES — YOU MUST FOLLOW THESE:
- When the user says anything like "remember", "remember that", "I want you to remember", "don't forget", or shares a fact/preference they want kept for later, you MUST call the "remember" tool.
- Do NOT just reply "Okay, I'll remember that" in plain text. You must use the remember tool so the memory is actually saved persistently.
- CRITICAL: When using the remember tool, ONLY save the raw, objective fact. NEVER pass conversational filler, apologies, or phrases like "I will remember that" or "I'm not sure..." into the memory content!
- Example:
  User: "Remember that I love ramen."
  → You call the remember tool with content: "User loves ramen" (or similar clear statement).

- When the user asks about something you might have remembered before, first call the "recall" tool.
- Always prefer using a tool over guessing.`;

  // Append core memories
  if (coreMemories) {
    basePrompt += `\n\n## Core Memory (Fundamental Context)\nThese are core facts about the user and your mission. They are always active:\n${coreMemories}`;
  }

  // Append relevant memories if any were found
  if (semanticMemories) {
    basePrompt += `\n\n## Relevant Memories\nThe following are specific things you've previously remembered that seem relevant to the current topic:\n${semanticMemories}`;
  }

  return basePrompt;
}

/**
 * Processes a user message through the agentic loop.
 *
 * @param chatId - Telegram chat ID (used for conversation history and memory)
 * @param userMessage - The user's text message
 * @param botName - Display name for the bot personality
 * @param maxIterations - Safety limit on tool-call rounds
 * @returns The final assistant response text
 */
export async function processMessage(
  chatId: number,
  userMessage: string,
  botName: string,
  maxIterations: number
): Promise<string> {
  // Get or create conversation history for this chat
  let history = conversationHistory.get(chatId);
  if (!history) {
    history = [];
    conversationHistory.set(chatId, history);
  }

  // Add user message to history
  history.push({ role: "user", content: userMessage });

  // ── Context pruning ─────────────────────────────────────────
  // If history is getting long, summarize older messages
  if (history.length >= PRUNE_TRIGGER) {
    await pruneHistory(chatId, history);
  }

  // Hard trim as a safety net (should rarely hit after pruning)
  while (history.length > MAX_HISTORY_MESSAGES) {
    history.shift();
  }

  // ── Memory context injection ────────────────────────────────
  // Get core memory which is ALWAYS injected
  let coreContext = "";
  try {
    const coreMemories = await getCoreContext(chatId);
    if (coreMemories.length > 0) {
      coreContext = coreMemories.map((m) => `- ${m.content}`).join("\n");
    }
  } catch (err) {
    log.error(`Core memory fetch failed: ${err}`);
  }

  // Search for semantic memories relevant to what the user just said
  let semanticContext = "";
  try {
    const relevantMemories = await getRelevantContext(chatId, userMessage, 5);
    if (relevantMemories.length > 0) {
      semanticContext = relevantMemories
        .map((m) => `- [#${m.id}] (${m.category}) ${m.content}`)
        .join("\n");
    }
  } catch (err) {
    // Memory search failure should never block the conversation
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Memory context injection failed: ${msg}`);
    console.warn("⚠️  Memory context injection failed:", err);
  }

  // Build the full messages array
  const systemMessage: ChatMessage = {
    role: "system",
    content: buildSystemPrompt(botName, coreContext, semanticContext),
  };

  const messages: ChatMessage[] = [systemMessage, ...history];
  const tools = getAllToolSchemas();

  // Pick the right client (default or profile-specific)
  const client = _activeProfile
    ? getProfileClient(_activeProfile)
    : getClient();

  // ── Agentic loop ────────────────────────────────────────────
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    let response;
    try {
      response = await client.chat.completions.create({
        model: "default", // Player2 routes to user's selected model
        messages,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? "auto" : undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If we crashed on a tool loop iteration with a 400 error, the upstream
      // proxy (e.g. Gemini) rejected the OpenAI tool history formatting.
      if (iterations > 1 && msg.includes("400") && messages[messages.length - 1]?.role === "tool") {
        console.warn("   ⚠️ Upstream API rejected tool history format (400). Short-circuiting loop.");
        
        // Extract the raw tool results we just processed
        const toolResults = messages.filter(m => m.role === "tool").map(m => m.content);
        
        // Build a fallback plain-text summary so the user knows what happened
        const fallbackText = "I have successfully executed the following tools:\n\n" + toolResults.map(r => {
          try {
             const parsed = JSON.parse(r as string);
             return `✅ ${parsed.message || "Completed"}`;
          } catch {
             return `✅ ${r}`;
          }
        }).join("\n");

        // Repair history for future turns: strip out the incompatible tool-call
        // structure and replace it with our plain-text summary
        history.pop(); // remove the 'assistant' message that contained the tool_calls
        history.push({ role: "assistant", content: fallbackText });

        return fallbackText;
      }
      throw err; // Not a tool loop 400, throw normally
    }

    const choice = response.choices[0];
    if (!choice) {
      log.error("LLM returned empty response (no choices)");
      return "I received an empty response from the AI model. Please try again.";
    }

    const assistantMessage = choice.message;
    const rawContent = assistantMessage.content ?? "";
    const activeModel = response.model || "unknown";

    // ── NEW: Log the raw LLM output and active model so we can verify behavior
    console.log(`   🤖 [Model: ${activeModel}] Raw response: "${rawContent.replace(/\n/g, ' ').substring(0, 100)}${rawContent.length > 100 ? '...' : ''}"`);

    // Add assistant response to messages for potential next iteration
    // Sanitize message: Gemini via proxy crashes if you send back response-only properties
    // like `function_call`, `refusal`, or if `content` is null. So we build a pristine object.
    const cleanAssistantMessage: ChatMessage = {
      role: "assistant",
      content: rawContent,
      tool_calls: assistantMessage.tool_calls,
    };
    messages.push(cleanAssistantMessage);

    // If no tool calls, we're done
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      const content = rawContent;

      // ── NEW: Auto-action fallback for weak models
      const autoAction = detectAutoToolAction(content, userMessage);
      if (autoAction) {
        console.log(`   🔄 Auto-triggering ${autoAction.tool} tool (model failed to use tool_calls)`);
        // Run silently in the background, don't break the loop or API schema
        executeTool(autoAction.tool, autoAction.args, chatId).catch(err => {
            log.error(`Auto-${autoAction.tool} failed: ${err}`);
        });
      }

      // Add the final assistant message to conversation history
      history.push({ role: "assistant", content });

      // Trim again after adding
      while (history.length > MAX_HISTORY_MESSAGES) {
        history.shift();
      }

      return content;
    }

    // ── Execute tool calls ──────────────────────────────────
    for (const toolCall of assistantMessage.tool_calls) {
      const functionName = toolCall.function.name;
      let args: Record<string, unknown> = {};

      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        args = {};
      }

      console.log(`  🔧 Tool call [${iterations}/${maxIterations}]: ${functionName}(${JSON.stringify(args)})`);
      log.info(`Tool call [${iterations}/${maxIterations}]: ${functionName}(${JSON.stringify(args)})`);

      // Pass chatId so memory tools can operate on the correct chat
      const result = await executeTool(functionName, args, chatId);

      // Add tool result to messages
      const toolMessage: ChatMessage = {
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      };
      messages.push(toolMessage);
    }

    // Loop continues — LLM will process the tool results
  }

  // Safety limit reached
  const lastMessage = messages[messages.length - 1];
  if (lastMessage && "content" in lastMessage && typeof lastMessage.content === "string") {
    return lastMessage.content;
  }

  return `I hit the maximum of ${maxIterations} processing steps. Here's what I have so far — please try a simpler request if needed.`;
}

// ── Context Pruning ─────────────────────────────────────────────

/**
 * Summarizes the oldest messages in conversation history to free up
 * context space. Replaces the oldest PRUNE_BATCH_SIZE messages with
 * a single system-level summary message.
 */
async function pruneHistory(
  chatId: number,
  history: ChatMessage[]
): Promise<void> {
  if (history.length < PRUNE_TRIGGER) return;

  const oldMessages = history.slice(0, PRUNE_BATCH_SIZE);

  // Build a summarization prompt from the old messages
  const conversationText = oldMessages
    .map((m) => {
      const role = "role" in m ? m.role : "unknown";
      const content = typeof m.content === "string" ? m.content : "[non-text]";
      return `${role}: ${content}`;
    })
    .join("\n");

  try {
    const client = _activeProfile
      ? getProfileClient(_activeProfile)
      : getClient();

    console.log(`🔄 Pruning: summarizing ${oldMessages.length} old messages...`);

    const response = await client.chat.completions.create({
      model: "default",
      messages: [
        {
          role: "system",
          content:
            "You are a conversation summarizer. Summarize the following conversation " +
            "into a concise paragraph. Preserve key facts, decisions, and context. " +
            "Do NOT include greetings or filler. Be factual and brief.",
        },
        {
          role: "user",
          content: `Summarize this conversation:\n\n${conversationText}`,
        },
      ],
      max_tokens: 300,
    });

    const summary =
      response.choices[0]?.message?.content?.trim() ??
      "Previous conversation context unavailable.";

    // Remove the old messages and prepend the summary
    history.splice(0, PRUNE_BATCH_SIZE, {
      role: "system",
      content: `[Conversation summary — older messages were compacted]\n\n${summary}`,
    });

    console.log(
      `   ✓ Pruned ${PRUNE_BATCH_SIZE} messages → 1 summary (${history.length} messages remaining)`
    );
  } catch (err) {
    console.warn("⚠️  Context pruning failed — falling back to hard trim:", err);
    // If summarization fails, just hard-trim the oldest messages
    history.splice(0, PRUNE_BATCH_SIZE);
  }
}

/**
 * Manually compacts conversation history for a chat.
 * Called by the /compact command.
 *
 * @returns A result object with before/after counts
 */
export async function compactHistory(
  chatId: number
): Promise<{ before: number; after: number; error?: string }> {
  const history = conversationHistory.get(chatId);
  if (!history || history.length < 4) {
    return {
      before: history?.length ?? 0,
      after: history?.length ?? 0,
      error: "Not enough conversation history to compact.",
    };
  }

  const before = history.length;
  // Force prune regardless of threshold — summarize all but the last 5 messages
  const messagesToSummarize = Math.max(history.length - 5, 1);

  const oldMessages = history.slice(0, messagesToSummarize);
  const conversationText = oldMessages
    .map((m) => {
      const role = "role" in m ? m.role : "unknown";
      const content = typeof m.content === "string" ? m.content : "[non-text]";
      return `${role}: ${content}`;
    })
    .join("\n");

  try {
    const client = _activeProfile
      ? getProfileClient(_activeProfile)
      : getClient();

    const response = await client.chat.completions.create({
      model: "default",
      messages: [
        {
          role: "system",
          content:
            "You are a conversation summarizer. Summarize the following conversation " +
            "into a concise paragraph. Preserve key facts, decisions, and context. " +
            "Do NOT include greetings or filler. Be factual and brief.",
        },
        {
          role: "user",
          content: `Summarize this conversation:\n\n${conversationText}`,
        },
      ],
      max_tokens: 300,
    });

    const summary =
      response.choices[0]?.message?.content?.trim() ??
      "Previous conversation context unavailable.";

    history.splice(0, messagesToSummarize, {
      role: "system",
      content: `[Conversation summary — manually compacted]\n\n${summary}`,
    });

    return { before, after: history.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { before, after: before, error: msg };
  }
}

/**
 * Clears conversation history for a specific chat.
 */
export function clearHistory(chatId: number): void {
  conversationHistory.delete(chatId);
}

/**
 * Returns the current history length for a chat.
 */
export function getHistoryLength(chatId: number): number {
  return conversationHistory.get(chatId)?.length ?? 0;
}

// ── Auto-Fallback Helpers ──────────────────────────────

/**
 * Detects when the weak model (Qwen) is trying to remember or forget
 * but failed to output proper tool_calls. Returns the tool + args.
 */
function detectAutoToolAction(text: string, userMessage: string): { tool: string; args: Record<string, unknown> } | null {
  const lower = text.toLowerCase().trim();

  // Remember patterns
  if (
    lower.includes("remember") ||
    lower.includes("i'll remember") ||
    lower.includes("remember content") ||
    lower.includes("i have saved")
  ) {
    const content = extractRememberContent(text) || userMessage;
    return {
      tool: "remember",
      args: { content: content },
    };
  }

  // Forget patterns
  if (lower.includes("forget") && (lower.includes("memory_id") || lower.includes("memory #") || text.includes("#"))) {
    const memoryId = extractForgetId(text);
    if (memoryId !== null) {
      return {
        tool: "forget",
        args: { memory_id: memoryId },
      };
    }
  }

  return null;
}

/**
 * Extract a clean memory string from the model's text response
 * (handles patterns like "remember content: ...")
 */
function extractRememberContent(text: string): string | null {
  const match = text.match(/remember content:\s*["']?([^"']+)["']?/i);
  if (match) return match[1].trim();

  // If it's a short confirmation, just use the whole text minus the filler
  if (text.length < 150 && text.toLowerCase().includes("remember")) {
    return text.replace(/i('| wi)ll remember (that )?/i, "").trim();
  }

  return null;
}

/**
 * Extracts memory ID from "forget memory_id: 1", "forget #1", etc.
 */
function extractForgetId(text: string): number | null {
  const match = text.match(/(?:forget|delete)[^\d#]*(?:memory_id|#)?\s*[:#]?\s*(\d+)/i);
  if (match) {
    const id = parseInt(match[1], 10);
    return isNaN(id) ? null : id;
  }
  return null;
}
