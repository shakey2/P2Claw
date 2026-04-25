/**
 * P2 Claw — Dev-tools module (first-party, developer-only).
 *
 * Loaded ONLY when P2CLAW_DEV_MODE=true. See DESIGN.md §4.7. The four tools
 * below exist so contributors can diagnose "is the bug in the LLM picking
 * wrong args, the schema, or the tool itself?" without coaxing an LLM into
 * calling a tool indirectly:
 *
 *   - debug_list_tools   : snapshot of the registry.
 *   - debug_inspect_module : declared perms + tools for a loaded module.
 *   - debug_tail_audit   : tails the active audit log (same path the writer
 *                          uses; never hardcoded).
 *   - debug_call_tool    : force-invokes a target tool through the registry,
 *                          re-using the caller's approval hook / TOTP secret
 *                          via the registry's AsyncLocalStorage option store.
 *
 * Security model notes:
 *   - The module declares `log.info` only so `debug_call_tool` can emit a
 *     tracing log line. No high-risk permissions. No per-tool `requires`,
 *     so none of these tools is ever promoted to effective risk "high".
 *     The TARGET tool's effective risk is what drives the TOTP gate on
 *     re-entry through executeTool — that's the whole point of the design.
 *   - Self-recursion and nested debug calls are rejected: a debug target
 *     calling debug_call_tool is a footgun (state confusion, runaway
 *     recursion), and we have no use case that requires it.
 */

import type { Module, ModuleContext, ModuleTool } from "../../core/modules/types.js";
import {
  executeTool,
  getRegisteredTool,
  getRegisteredTools,
  getCurrentExecuteOptions,
  isDebugCallInFlight,
  runAsDebugCall,
} from "../../tools/registry.js";
import {
  getLoadedModule,
  listLoadedModules,
} from "../../core/modules/runtime-index.js";
import {
  resolveAuditLogPath,
  writeDebugInvocation,
  hashArgs,
  summariseArgs,
  type DebugInvocationResult,
} from "../../core/modules/audit.js";
import { existsSync, readFileSync } from "fs";

const CALLER_ID = "com.p2claw.dev-tools";

/** Hard cap on `debug_tail_audit` — matches the /debug audit cap. */
const AUDIT_TAIL_HARD_MAX = 200;
/** Default when `n` is omitted or invalid. */
const AUDIT_TAIL_DEFAULT = 20;

function makeDebugListTools(): ModuleTool {
  return {
    schema: {
      type: "function",
      function: {
        name: "debug_list_tools",
        description:
          "Lists every registered tool with its description, parameter schema, owner module id, required permissions, and effective risk. Read-only.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    requires: [],
    handler: async (): Promise<string> => {
      return JSON.stringify({
        ok: true,
        tools: getRegisteredTools(),
      });
    },
  };
}

function makeDebugInspectModule(): ModuleTool {
  return {
    schema: {
      type: "function",
      function: {
        name: "debug_inspect_module",
        description:
          "Returns a snapshot of a loaded module by reverse-DNS id: declared permissions, runtime, firstParty flag, and per-tool requires. Read-only.",
        parameters: {
          type: "object",
          properties: {
            moduleId: {
              type: "string",
              description:
                "Reverse-DNS module id, e.g. com.p2claw.demo-safe.",
            },
          },
          required: ["moduleId"],
        },
      },
    },
    requires: [],
    handler: async (rawArgs): Promise<string> => {
      const moduleId =
        typeof (rawArgs as { moduleId?: unknown }).moduleId === "string"
          ? ((rawArgs as { moduleId: string }).moduleId)
          : "";
      if (!moduleId) {
        return JSON.stringify({ ok: false, error: "moduleId is required" });
      }
      const module = getLoadedModule(moduleId) ?? null;
      return JSON.stringify({
        ok: true,
        moduleId,
        module,
        loadedIds: listLoadedModules().map((m) => m.id),
      });
    },
  };
}

/**
 * Tails the last `n` lines of the audit log. Returns a structured body so
 * callers can see the resolved path and whether the file existed. Never
 * throws — a missing file is a normal "no activity yet" case.
 */
function tailAuditLines(n: number): {
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
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { path, entries: [], note: `read failed: ${msg}` };
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const tail = lines.slice(Math.max(0, lines.length - n));
  return { path, entries: tail };
}

function makeDebugTailAudit(): ModuleTool {
  return {
    schema: {
      type: "function",
      function: {
        name: "debug_tail_audit",
        description:
          "Tails the last N entries from the active audit log (as raw JSONL). N defaults to 20 and is capped at 200. Read-only.",
        parameters: {
          type: "object",
          properties: {
            n: {
              type: "number",
              description:
                "Number of most-recent lines to return. Default 20, max 200.",
            },
          },
          required: [],
        },
      },
    },
    requires: [],
    handler: async (rawArgs): Promise<string> => {
      const n = normaliseTailCount((rawArgs as { n?: unknown }).n);
      const result = tailAuditLines(n);
      return JSON.stringify({ ok: true, n, ...result });
    },
  };
}

function normaliseTailCount(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return AUDIT_TAIL_DEFAULT;
  }
  const n = Math.floor(raw);
  if (n <= 0) return AUDIT_TAIL_DEFAULT;
  return Math.min(n, AUDIT_TAIL_HARD_MAX);
}

/**
 * Inspects a tool invocation's returned string (tools always return strings,
 * usually JSON) and classifies the outcome for the debug-invocation audit
 * entry. Best-effort: parsing fails are treated as "success" because a
 * non-JSON success response is still a success from the registry's POV.
 */
function classifyDebugResult(raw: string): DebugInvocationResult {
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === "string") {
      // "cancelled by user" is emitted without the "not approved" prefix.
      if (parsed.error.includes("cancelled by user")) return "approval_denied";
      if (parsed.error.includes("not approved")) {
        if (parsed.error.includes("denied")) return "approval_denied";
        // "timed out" and "superseded" are both timeout-class events.
        return "approval_timeout";
      }
      return "error";
    }
    return "success";
  } catch {
    return "success";
  }
}

function makeDebugCallTool(ctx: ModuleContext): ModuleTool {
  return {
    schema: {
      type: "function",
      function: {
        name: "debug_call_tool",
        description:
          "Force-invokes a target tool through the normal registry path with the given args. Every broker gate still fires; high-risk targets still require TOTP. Rejects self-recursion and nested debug calls. Returns the raw target result plus target metadata.",
        parameters: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "Name of the target tool to invoke.",
            },
            args: {
              type: "object",
              description:
                "Structured argument object passed to the target tool.",
              additionalProperties: true,
            },
          },
          required: ["target", "args"],
        },
      },
    },
    requires: [],
    handler: async (rawArgs): Promise<string> => {
      const target =
        typeof (rawArgs as { target?: unknown }).target === "string"
          ? (rawArgs as { target: string }).target
          : "";
      const targetArgsRaw = (rawArgs as { args?: unknown }).args;
      const targetArgs: Record<string, unknown> =
        targetArgsRaw && typeof targetArgsRaw === "object" && !Array.isArray(targetArgsRaw)
          ? (targetArgsRaw as Record<string, unknown>)
          : {};

      if (!target) {
        return JSON.stringify({
          ok: false,
          error: "target is required (string)",
        });
      }

      // Reject the most obvious footgun first: calling debug_call_tool from
      // inside debug_call_tool. The audit record is the only observable
      // trace, which is why we emit it even on early rejection.
      if (target === "debug_call_tool") {
        writeDebugInvocation({
          kind: "debug_invocation",
          surface: "llm_debug_tool",
          callerId: CALLER_ID,
          targetTool: target,
          argsHash: hashArgs(targetArgs),
          argsSummary: summariseArgs(targetArgs),
          result: "recursion_rejected",
        });
        return JSON.stringify({
          ok: false,
          error: "debug_call_tool refuses to invoke itself",
        });
      }

      // Catch chained / deeper nesting: a target handler calling
      // debug_call_tool (e.g. via another module's path) while we are
      // already mid-debug-call. Same audit trail as self-recursion.
      if (isDebugCallInFlight()) {
        writeDebugInvocation({
          kind: "debug_invocation",
          surface: "llm_debug_tool",
          callerId: CALLER_ID,
          targetTool: target,
          argsHash: hashArgs(targetArgs),
          argsSummary: summariseArgs(targetArgs),
          result: "recursion_rejected",
        });
        return JSON.stringify({
          ok: false,
          error: "nested debug_call_tool invocations are rejected",
        });
      }

      const targetMeta = getRegisteredTool(target);
      if (!targetMeta) {
        writeDebugInvocation({
          kind: "debug_invocation",
          surface: "llm_debug_tool",
          callerId: CALLER_ID,
          targetTool: target,
          argsHash: hashArgs(targetArgs),
          argsSummary: summariseArgs(targetArgs),
          result: "unknown_tool",
        });
        return JSON.stringify({ ok: false, error: `unknown tool: ${target}` });
      }

      // Recover the options that `executeTool` stashed for this outer call
      // so the target tool's approval / TOTP path has the same hook set
      // the user originally provided (Telegram reply, CLI prompt, HTML
      // pending-approval channel).
      const opts = getCurrentExecuteOptions() ?? {};

      await ctx.log.info(
        `debug_call_tool -> ${target} (owner=${targetMeta.ownerModuleId ?? "core"}, risk=${targetMeta.effectiveRisk})`
      );

      const raw = await runAsDebugCall(() => executeTool(target, targetArgs, opts));
      const result = classifyDebugResult(raw);

      writeDebugInvocation({
        kind: "debug_invocation",
        surface: "llm_debug_tool",
        callerId: CALLER_ID,
        targetTool: target,
        targetOwnerModuleId: targetMeta.ownerModuleId,
        argsHash: hashArgs(targetArgs),
        argsSummary: summariseArgs(targetArgs),
        result,
      });

      return JSON.stringify({
        ok: result === "success",
        target,
        targetOwnerModuleId: targetMeta.ownerModuleId,
        effectiveRisk: targetMeta.effectiveRisk,
        raw,
      });
    },
  };
}

const mod: Module = {
  async register({ ctx, contributeTool }) {
    contributeTool(makeDebugListTools());
    contributeTool(makeDebugInspectModule());
    contributeTool(makeDebugTailAudit());
    contributeTool(makeDebugCallTool(ctx));
    await ctx.log.info("dev-tools module registered (P2CLAW_DEV_MODE=true)");
  },
};

export default mod;
