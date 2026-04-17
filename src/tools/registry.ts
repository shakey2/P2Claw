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
import { AsyncLocalStorage } from "async_hooks";
import {
  createChallenge,
  waitForApproval,
  APPROVAL_TTL_MS,
} from "../security/approval.js";
import type { ToolDefinition, ExecuteToolOptions, ToolRisk } from "./tool-types.js";
import { maxRisk, type PermissionId } from "../modules/permissions.js";
import { runWithGrants } from "../modules/broker.js";

export type { ToolDefinition, ToolRisk, ExecuteToolOptions } from "./tool-types.js";

/**
 * Sanitized, read-only view of a registered tool. Returned by
 * `getRegisteredTools` / `getRegisteredTool` for the dev-tools debug surface
 * (and any other callers that want introspection without touching the
 * internal handler or raw schema object).
 */
export interface ToolMetadata {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  ownerModuleId?: string;
  requiredPermissions: readonly string[];
  effectiveRisk: ToolRisk;
}

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
 * Register a module-contributed tool. The loader calls this with
 * `ownerModuleId` and `requiredPermissions` populated so execution can pass
 * through the broker's grant context and the existing TOTP flow.
 */
export function registerModuleTool(tool: ToolDefinition): void {
  if (!tool.ownerModuleId) {
    throw new Error("registerModuleTool requires ownerModuleId");
  }
  register(tool);
}

/**
 * Returns all tool schemas for the LLM's `tools` parameter.
 */
export function getAllToolSchemas(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return Array.from(tools.values()).map((t) => t.schema);
}

/**
 * Derives the effective risk for a tool: any high-risk permission promotes
 * the tool to `high`, regardless of its explicit `risk` field. Exported so
 * the dev-tools introspection surface reports the same value `executeTool`
 * actually enforces.
 */
export function computeEffectiveRisk(def: ToolDefinition): ToolRisk {
  let risk: ToolRisk = def.risk ?? "safe";
  if (def.requiredPermissions && def.requiredPermissions.length > 0) {
    if (maxRisk(def.requiredPermissions) === "high") {
      risk = "high";
    }
  }
  return risk;
}

function deepCloneJsonish<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toMetadata(def: ToolDefinition): ToolMetadata {
  const fn = def.schema.function;
  return {
    name: fn.name,
    description: fn.description ?? "",
    parameters: deepCloneJsonish(
      (fn.parameters ?? {}) as Record<string, unknown>
    ),
    ownerModuleId: def.ownerModuleId,
    requiredPermissions: [...(def.requiredPermissions ?? [])],
    effectiveRisk: computeEffectiveRisk(def),
  };
}

/**
 * Returns a read-only snapshot of every registered tool. Used by the
 * dev-tools module (`debug_list_tools`, `debug_inspect_tool`, and
 * `debug_call_tool`'s target lookup) and the `/debug` frontend commands.
 */
export function getRegisteredTools(): ReadonlyArray<ToolMetadata> {
  return Array.from(tools.values()).map(toMetadata);
}

/**
 * Returns sanitized metadata for a single tool, or undefined when unknown.
 */
export function getRegisteredTool(name: string): ToolMetadata | undefined {
  const def = tools.get(name);
  return def ? toMetadata(def) : undefined;
}

// ── Runtime options / nesting stores ─────────────────────────────
//
// Threading ExecuteToolOptions through the handler chain without changing
// the ToolDefinition handler signature keeps the built-in tools untouched.
// The dev-tools `debug_call_tool` reads from this store to re-enter
// `executeTool(target, args, opts)` with the same chatId / approval hook /
// TOTP secret the original call received.

const executeOptionsStore = new AsyncLocalStorage<ExecuteToolOptions>();

/**
 * Returns the `ExecuteToolOptions` in effect for the currently-running
 * handler, or `undefined` when called outside a tool dispatch. Intended for
 * `debug_call_tool` and the frontend `/debug call` path; no other caller
 * should need this.
 */
export function getCurrentExecuteOptions(): ExecuteToolOptions | undefined {
  return executeOptionsStore.getStore();
}

const debugCallInFlightStore = new AsyncLocalStorage<true>();

/**
 * True while `debug_call_tool` (or the `/debug call` frontend path) is
 * executing a target. Used to reject nested debug-call chains.
 */
export function isDebugCallInFlight(): boolean {
  return debugCallInFlightStore.getStore() === true;
}

/**
 * Runs `fn` with the "debug call in flight" marker set. `debug_call_tool`
 * and the shared `/debug call` handler both funnel through this so nested
 * debug-call attempts (LLM → debug → target → debug) are rejected.
 */
export function runAsDebugCall<T>(fn: () => Promise<T>): Promise<T> {
  return debugCallInFlightStore.run(true, fn);
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

  const risk: ToolRisk = computeEffectiveRisk(tool);

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

    const approvalOutcome = await approvalPromise;
    if (approvalOutcome !== "approved") {
      if (approvalOutcome === "cancelled") {
        // Human-readable message so the agent understands the user was deliberate.
        return JSON.stringify({
          error: "High-risk action cancelled by user. Do not retry unless explicitly asked.",
        });
      }
      const detail =
        approvalOutcome === "timeout"
          ? "timed out waiting for TOTP code"
          : approvalOutcome === "denied"
            ? "denied"
            : approvalOutcome === "superseded"
              ? "superseded by a new request for this session"
              : approvalOutcome;
      return JSON.stringify({
        error: `High-risk action not approved (${detail}).`,
      });
    }
  }

   const memoryKey = opts.memoryScopeId ?? opts.chatId;

  try {
    // Thread the active ExecuteToolOptions through AsyncLocalStorage so
    // re-entering handlers (e.g. `debug_call_tool` invoking a target tool)
    // can recover the same approval hook / TOTP secret / chatId without
    // changing the ToolDefinition handler signature.
    return await executeOptionsStore.run(opts, async () => {
      // Module-contributed tools run inside a broker grant context so any
      // high-risk permission their manifest pre-approved is considered granted
      // for the duration of the handler (no double TOTP prompt).
      if (tool.ownerModuleId && tool.requiredPermissions) {
        return await runWithGrants(
          tool.requiredPermissions as readonly PermissionId[],
          name,
          () => tool.handler(args, memoryKey)
        );
      }
      return tool.handler(args, memoryKey);
    });
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
