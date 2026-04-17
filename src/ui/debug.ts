/**
 * P2 Claw — Shared /debug command handler (frontend-agnostic).
 *
 * The LLM-facing `dev-tools` module covers diagnostic tool calls made
 * inside the agent loop. This module handles the complementary `/debug`
 * slash command typed directly by the developer into a frontend (CLI,
 * Telegram, or the HTML GUI), which bypasses the LLM entirely.
 *
 * Only the *parsing + dispatch* lives here. Rendering is deliberately left
 * to each frontend because Telegram needs chunking + Markdown fallback,
 * the CLI wants plain text, and the HTML GUI renders JSON client-side.
 * Forcing one raw-string format here would recreate the frontend-specific
 * bugs this feature is meant to diagnose. See DESIGN.md §4.7.
 */

import {
  executeTool,
  getRegisteredTool,
  getRegisteredTools,
  isDebugCallInFlight,
  runAsDebugCall,
  type ToolMetadata,
} from "../tools/registry.js";
import type { ExecuteToolOptions, ToolRisk } from "../tools/tool-types.js";
import {
  getLoadedModule,
  listLoadedModules,
  type LoadedModuleSummary,
} from "../modules/runtime-index.js";
import {
  hashArgs,
  resolveAuditLogPath,
  summariseArgs,
  writeDebugInvocation,
  type DebugInvocationResult,
} from "../modules/audit.js";
import {
  getPendingChallengeForChat,
  type PendingChallengeSnapshot,
} from "../security/approval.js";
import { existsSync, readFileSync } from "fs";

const AUDIT_TAIL_DEFAULT = 20;
const AUDIT_TAIL_HARD_MAX = 200;

export type DebugUiMode = "telegram" | "cli" | "html";

export interface DebugHandlerInput {
  /** Whether dev mode is active. When false, handler short-circuits. */
  devMode: boolean;
  /** Session id = Telegram chat id / CLI session id / HTML memoryScopeId. */
  sessionId: number;
  /** First token after `/debug` (e.g. "list", "call"). */
  subcommand: string;
  /**
   * Everything after the subcommand, verbatim (NOT pre-tokenised). JSON
   * args for `/debug call` must survive intact, which is why the caller
   * must not split on whitespace before passing this in.
   */
  rest: string;
  /** Frontend label used when writing the debug-invocation audit entry. */
  uiMode: DebugUiMode;
  /** Passed through to `executeTool` for `/debug call`. */
  totpSecretBase32?: string;
  /** Approval hook for high-risk target tools invoked via `/debug call`. */
  sendPendingApproval?: (text: string) => Promise<void>;
  /** Stable memory-scope id shared across frontends. */
  memoryScopeId?: number;
}

export interface DebugCallMeta {
  target: string;
  targetOwnerModuleId?: string;
  effectiveRisk: ToolRisk;
  /** Raw string returned by the target tool (usually JSON). */
  raw: string;
  /** Classification used for the audit record. */
  outcome: DebugInvocationResult;
}

export interface DebugPermsInfo {
  tool: string;
  ownerModuleId?: string;
  requiredPermissions: readonly string[];
  effectiveRisk: ToolRisk;
  totpConfigured: boolean;
  /**
   * Snapshot of the ephemeral pending challenge for this session, if any.
   * Null when there is no pending approval. Approvals in P2 Claw are
   * ephemeral (one pending challenge per session, short TTL); there is no
   * persistent approved/unapproved cache to report.
   */
  pendingChallenge: PendingChallengeSnapshot | null;
}

export type DebugResult =
  | { kind: "help"; lines: readonly string[] }
  | { kind: "list"; tools: readonly ToolMetadata[] }
  | { kind: "modules"; modules: readonly LoadedModuleSummary[] }
  | {
      kind: "inspect_module";
      moduleId: string;
      module: LoadedModuleSummary | null;
    }
  | { kind: "audit"; path: string; n: number; entries: readonly string[]; note?: string }
  | { kind: "call"; meta: DebugCallMeta }
  | { kind: "perms"; info: DebugPermsInfo }
  | { kind: "error"; message: string }
  | { kind: "unknown_subcommand"; subcommand: string }
  | { kind: "disabled" };

const HELP_LINES: readonly string[] = [
  "/debug help                         Show this help.",
  "/debug list                         List all registered tools.",
  "/debug modules [moduleId]           List loaded modules, or inspect one.",
  "/debug audit [N]                    Tail last N audit entries (default 20, max 200).",
  "/debug call <tool> <json>           Force-invoke a tool. JSON must be one line.",
  "/debug perms <tool>                 Show a tool's required perms + effective risk.",
];

/**
 * Splits `rest` into the first whitespace-separated token and the verbatim
 * remainder. Used by `/debug call` and `/debug perms` to preserve JSON
 * bodies and tool names that may contain unusual characters.
 */
function splitFirstToken(rest: string): { head: string; tail: string } {
  const trimmed = rest.trimStart();
  const match = trimmed.match(/^(\S+)(\s+([\s\S]*))?$/);
  if (!match) return { head: "", tail: "" };
  return {
    head: match[1] ?? "",
    tail: (match[3] ?? "").trim(),
  };
}

function parseAuditCount(rest: string): number {
  const trimmed = rest.trim();
  if (!trimmed) return AUDIT_TAIL_DEFAULT;
  const n = parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n <= 0) return AUDIT_TAIL_DEFAULT;
  return Math.min(n, AUDIT_TAIL_HARD_MAX);
}

function tailAudit(n: number): {
  path: string;
  entries: string[];
  note?: string;
} {
  const path = resolveAuditLogPath();
  if (!existsSync(path)) {
    return {
      path,
      entries: [],
      note: "audit log has not been written yet",
    };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
    return { path, entries: lines.slice(Math.max(0, lines.length - n)) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { path, entries: [], note: `read failed: ${msg}` };
  }
}

function classifyCallOutcome(raw: string): DebugInvocationResult {
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === "string") {
      if (parsed.error.includes("cancelled by user")) return "approval_denied";
      if (parsed.error.includes("not approved")) {
        if (parsed.error.includes("denied")) return "approval_denied";
        return "approval_timeout";
      }
      return "error";
    }
    return "success";
  } catch {
    return "success";
  }
}

async function handleCall(
  input: DebugHandlerInput
): Promise<DebugResult> {
  const { head: target, tail: jsonTail } = splitFirstToken(input.rest);
  if (!target) {
    return { kind: "error", message: "usage: /debug call <tool> <json>" };
  }

  if (!jsonTail) {
    return {
      kind: "error",
      message: "usage: /debug call <tool> <json> (args must be a JSON object)",
    };
  }

  let parsedArgs: Record<string, unknown>;
  try {
    const anyParsed = JSON.parse(jsonTail);
    if (!anyParsed || typeof anyParsed !== "object" || Array.isArray(anyParsed)) {
      return {
        kind: "error",
        message: "args must parse to a JSON object (not array/scalar)",
      };
    }
    parsedArgs = anyParsed as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: "error", message: `invalid JSON for args: ${msg}` };
  }

  const callerId = `frontend:${input.uiMode}:debug`;

  if (target === "debug_call_tool") {
    writeDebugInvocation({
      kind: "debug_invocation",
      surface: "frontend_debug_command",
      callerId,
      targetTool: target,
      argsHash: hashArgs(parsedArgs),
      argsSummary: summariseArgs(parsedArgs),
      result: "recursion_rejected",
    });
    return {
      kind: "error",
      message: "/debug call refuses to invoke debug_call_tool (recursion)",
    };
  }

  if (isDebugCallInFlight()) {
    writeDebugInvocation({
      kind: "debug_invocation",
      surface: "frontend_debug_command",
      callerId,
      targetTool: target,
      argsHash: hashArgs(parsedArgs),
      argsSummary: summariseArgs(parsedArgs),
      result: "recursion_rejected",
    });
    return {
      kind: "error",
      message: "a debug call is already in flight; nested debug invocations are rejected",
    };
  }

  const targetMeta = getRegisteredTool(target);
  if (!targetMeta) {
    writeDebugInvocation({
      kind: "debug_invocation",
      surface: "frontend_debug_command",
      callerId,
      targetTool: target,
      argsHash: hashArgs(parsedArgs),
      argsSummary: summariseArgs(parsedArgs),
      result: "unknown_tool",
    });
    return { kind: "error", message: `unknown tool: ${target}` };
  }

  const opts: ExecuteToolOptions = {
    chatId: input.sessionId,
    memoryScopeId: input.memoryScopeId,
    sendPendingApproval: input.sendPendingApproval,
    totpSecretBase32: input.totpSecretBase32,
  };

  const raw = await runAsDebugCall(() => executeTool(target, parsedArgs, opts));
  const outcome = classifyCallOutcome(raw);

  writeDebugInvocation({
    kind: "debug_invocation",
    surface: "frontend_debug_command",
    callerId,
    targetTool: target,
    targetOwnerModuleId: targetMeta.ownerModuleId,
    argsHash: hashArgs(parsedArgs),
    argsSummary: summariseArgs(parsedArgs),
    result: outcome,
  });

  return {
    kind: "call",
    meta: {
      target,
      targetOwnerModuleId: targetMeta.ownerModuleId,
      effectiveRisk: targetMeta.effectiveRisk,
      raw,
      outcome,
    },
  };
}

function handlePerms(input: DebugHandlerInput): DebugResult {
  const { head: toolName } = splitFirstToken(input.rest);
  if (!toolName) {
    return { kind: "error", message: "usage: /debug perms <tool>" };
  }
  const meta = getRegisteredTool(toolName);
  if (!meta) {
    return { kind: "error", message: `unknown tool: ${toolName}` };
  }
  const info: DebugPermsInfo = {
    tool: toolName,
    ownerModuleId: meta.ownerModuleId,
    requiredPermissions: meta.requiredPermissions,
    effectiveRisk: meta.effectiveRisk,
    totpConfigured: !!input.totpSecretBase32?.trim(),
    pendingChallenge: getPendingChallengeForChat(input.sessionId),
  };
  return { kind: "perms", info };
}

function handleModules(input: DebugHandlerInput): DebugResult {
  const { head: moduleId } = splitFirstToken(input.rest);
  if (!moduleId) {
    return { kind: "modules", modules: listLoadedModules() };
  }
  return {
    kind: "inspect_module",
    moduleId,
    module: getLoadedModule(moduleId) ?? null,
  };
}

/**
 * Routes a parsed `/debug` subcommand to its action. Returns a structured
 * result for the calling frontend to render. When `devMode` is false the
 * handler returns `{kind: "disabled"}` so the frontend can surface
 * "unknown command" — no information leak about dev-tools' existence.
 */
export async function handleDebugCommand(
  input: DebugHandlerInput
): Promise<DebugResult> {
  if (!input.devMode) {
    return { kind: "disabled" };
  }
  const sub = (input.subcommand ?? "").trim().toLowerCase();
  switch (sub) {
    case "":
    case "help":
      return { kind: "help", lines: HELP_LINES };
    case "list":
      return { kind: "list", tools: getRegisteredTools() };
    case "modules":
      return handleModules(input);
    case "audit": {
      const n = parseAuditCount(input.rest);
      const r = tailAudit(n);
      return {
        kind: "audit",
        path: r.path,
        n,
        entries: r.entries,
        note: r.note,
      };
    }
    case "call":
      return handleCall(input);
    case "perms":
      return handlePerms(input);
    default:
      return { kind: "unknown_subcommand", subcommand: sub };
  }
}
