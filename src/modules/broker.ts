/**
 * P2 Claw — Capability broker.
 *
 * The ONLY capability surface Core hands to a module. Every risky primitive
 * (shell, fs, net, credentials) is behind a broker method that:
 *
 *   1. Verifies the module declared the matching permission in its manifest.
 *   2. If the permission is high-risk, verifies the current execution context
 *      already passed the TOTP gate for this permission (pre-approved when the
 *      LLM invoked a module tool whose `requires` includes it). Direct broker
 *      calls outside a pre-approved context are refused in Phase 1 because we
 *      have no way to prompt the active frontend from arbitrary async code yet.
 *   3. Writes an audit entry (granted / denied / not_declared).
 *   4. Runs the primitive and returns.
 *
 * Phase 1 keeps shell/process/net/fs.writeAny/fs.readPrivate/credentials.read
 * STUBBED. The gate + audit pipeline is wired end-to-end, but the actual
 * side-effect-inducing primitives return synthetic results. This is deliberate:
 * it proves the gate without shipping real in-process shell execution before
 * Phase 2's subprocess-isolation work.
 */

import { AsyncLocalStorage } from "async_hooks";
import { existsSync, readFileSync, statSync } from "fs";
import { dirname, join, resolve, sep } from "path";
import { fileURLToPath } from "url";
import type { ModuleManifest } from "./manifest.js";
import type { ModuleContext, ProcessResult } from "./types.js";
import { PermissionDeniedError } from "./types.js";
import {
  getPermission,
  type PermissionId,
} from "./permissions.js";
import {
  writeAudit,
  hashArgs,
  summariseArgs,
  type AuditEntry,
} from "./audit.js";
import { log as coreLog } from "../logger.js";

/** Repo root (works under `tsx src/...` and `node dist/...`). */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Root of per-module public read area: data/public/<moduleId>/ */
const PUBLIC_ROOT = join(PKG_ROOT, "data", "public");

/** Hard cap on a single `fs.readPublic` response, in bytes. */
const MAX_PUBLIC_READ_BYTES = 1 * 1024 * 1024;

// ── Grant context (pre-approved permissions for a call) ─────────

interface GrantContext {
  /** Permissions that passed the gate for the in-flight tool call. */
  granted: Set<PermissionId>;
  /** Optional label for audit entries (e.g. the tool name). */
  toolName?: string;
}

const grantStore = new AsyncLocalStorage<GrantContext>();

/**
 * Run `fn` with the given permissions pre-approved for the duration of the
 * call. Used by the tool registry to funnel a tool's TOTP approval down into
 * the broker so broker methods for those permissions do not prompt again.
 */
export function runWithGrants<T>(
  granted: readonly PermissionId[],
  toolName: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const ctx: GrantContext = {
    granted: new Set(granted),
    toolName,
  };
  return grantStore.run(ctx, fn);
}

function currentGrants(): GrantContext | undefined {
  return grantStore.getStore();
}

// ── Broker core services (hooks Core supplies at loader time) ───

export interface BrokerCoreServices {
  /**
   * Provider for module-scoped memory. If omitted, memory.* operations return
   * a namespaced no-op (useful for Phase 1 demo flow that doesn't need it).
   */
  memory?: {
    read(moduleId: string, key: string): Promise<string | null>;
    write(moduleId: string, key: string, value: string): Promise<void>;
  };
}

// ── Broker factory ──────────────────────────────────────────────

export function createBroker(
  manifest: ModuleManifest,
  services: BrokerCoreServices = {}
): ModuleContext {
  const declared = new Set<string>(manifest.permissions);

  function audit(
    permission: PermissionId,
    decision: AuditEntry["decision"],
    reason: string,
    args?: unknown
  ): void {
    writeAudit({
      moduleId: manifest.id,
      permission,
      decision,
      reason,
      argsHash: args === undefined ? undefined : hashArgs(args),
      argsSummary: args === undefined ? undefined : summariseArgs(args),
      toolName: currentGrants()?.toolName,
    });
  }

  /**
   * Central gate every primitive goes through.
   * Throws PermissionDeniedError if the call is rejected.
   */
  function checkGate(permission: PermissionId, args?: unknown): void {
    if (!declared.has(permission)) {
      audit(permission, "not_declared", "permission not declared in manifest", args);
      throw new PermissionDeniedError(
        "NOT_DECLARED",
        `module "${manifest.id}" attempted "${permission}" but did not declare it in manifest.permissions`
      );
    }

    const desc = getPermission(permission);
    if (!desc) {
      audit(permission, "error", "unknown permission at runtime", args);
      throw new PermissionDeniedError(
        "NOT_DECLARED",
        `unknown permission "${permission}"`
      );
    }

    if (desc.riskLevel === "safe") {
      audit(permission, "granted", "safe_auto_grant", args);
      return;
    }

    // High-risk: must be pre-approved by the active tool call (TOTP passed in
    // the registry). Phase 1 does not do mid-flight TOTP prompts from the
    // broker itself — that's a future surface.
    const ctx = currentGrants();
    if (!ctx) {
      audit(permission, "denied", "no_grant_context", args);
      throw new PermissionDeniedError(
        "NO_CHANNEL",
        `high-risk permission "${permission}" requires an approved tool-call context (Phase 1)`
      );
    }
    if (!ctx.granted.has(permission)) {
      audit(permission, "denied", "permission_not_preapproved", args);
      throw new PermissionDeniedError(
        "DENIED",
        `high-risk permission "${permission}" was not approved for this tool call`
      );
    }

    audit(permission, "granted", "totp_preapproved", args);
  }

  // ── Primitive stubs ───────────────────────────────────────────

  function stubProcess(cmd: string, args: string[]): ProcessResult {
    return {
      stdout: `[phase1-stub] would run: ${cmd} ${args.join(" ")}`,
      stderr: "",
      code: 0,
    };
  }

  return {
    moduleId: manifest.id,

    log: {
      async info(msg: string): Promise<void> {
        checkGate("log.info", { msg });
        coreLog.info(`[module:${manifest.id}] ${msg}`);
      },
    },

    time: {
      async now(): Promise<Date> {
        checkGate("time.now");
        return new Date();
      },
    },

    memory: {
      async read(key: string): Promise<string | null> {
        checkGate("memory.read", { key });
        if (!services.memory) return null;
        return services.memory.read(manifest.id, key);
      },
      async write(key: string, value: string): Promise<void> {
        checkGate("memory.write", { key });
        if (!services.memory) return;
        return services.memory.write(manifest.id, key, value);
      },
    },

    fs: {
      async readPublic(rel: string): Promise<string> {
        checkGate("fs.read_public", { rel });

        // Sandbox: every read is clamped to data/public/<moduleId>/. We
        // resolve the requested path relative to that base and then require
        // that the resolved absolute path is still inside the base. This
        // rejects absolute paths, `..` segments, and symlink-escape attempts
        // that manifest as out-of-base paths after resolve().
        const base = join(PUBLIC_ROOT, manifest.id);
        if (typeof rel !== "string" || rel.length === 0) {
          throw new PermissionDeniedError(
            "DENIED",
            "fs.readPublic: rel must be a non-empty string"
          );
        }
        const abs = resolve(base, rel);
        if (abs !== base && !abs.startsWith(base + sep)) {
          throw new PermissionDeniedError(
            "DENIED",
            `fs.readPublic: path escapes module public dir (${rel})`
          );
        }
        if (!existsSync(abs)) {
          throw new PermissionDeniedError(
            "DENIED",
            `fs.readPublic: file not found under module public dir (${rel})`
          );
        }
        const info = statSync(abs);
        if (!info.isFile()) {
          throw new PermissionDeniedError(
            "DENIED",
            `fs.readPublic: not a regular file (${rel})`
          );
        }
        if (info.size > MAX_PUBLIC_READ_BYTES) {
          throw new PermissionDeniedError(
            "DENIED",
            `fs.readPublic: file exceeds ${MAX_PUBLIC_READ_BYTES}-byte cap (${info.size} bytes)`
          );
        }
        return readFileSync(abs, "utf-8");
      },
      async readPrivate(abs: string): Promise<string> {
        checkGate("fs.read_private", { abs });
        return `[phase1-stub] fs.readPrivate(${abs})`;
      },
      async writeAny(abs: string, data: string): Promise<void> {
        checkGate("fs.write_any", { abs, bytes: data.length });
        // Stub: intentionally does nothing.
      },
    },

    shell: {
      async execute(cmd: string, args: string[]): Promise<ProcessResult> {
        checkGate("shell.execute", { cmd, args });
        return stubProcess(cmd, args);
      },
    },

    process: {
      async spawn(cmd: string, args: string[]): Promise<ProcessResult> {
        checkGate("process.spawn", { cmd, args });
        return stubProcess(cmd, args);
      },
    },

    net: {
      async fetch(
        url: string,
        init?: { method?: string; body?: string; headers?: Record<string, string> }
      ): Promise<{ status: number; body: string }> {
        checkGate("net.outbound", { url, method: init?.method ?? "GET" });
        return {
          status: 0,
          body: `[phase1-stub] net.fetch(${init?.method ?? "GET"} ${url})`,
        };
      },
    },

    credentials: {
      async read(kind: "player2" | "telegram" | "totp"): Promise<string> {
        checkGate("credentials.read", { kind });
        return `[phase1-stub] credentials.read(${kind})`;
      },
    },
  };
}
