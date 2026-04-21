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
 * High-risk capability gates are wired for all dangerous primitives. Some
 * surfaces remain intentionally stubbed (for example net/credentials), while
 * subprocess and filesystem now dispatch real bounded implementations.
 */

import { AsyncLocalStorage } from "async_hooks";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import type { ModuleManifest } from "./manifest.js";
import type { ModuleContext, ProcessResult } from "./types.js";
import { PermissionDeniedError } from "./types.js";
import {
  getPermission,
  type PermissionId,
} from "./permissions.js";
import {
  writeAudit,
  writeSettingsEvent,
  hashArgs,
  summariseArgs,
  writeFsEvent,
  writeSubprocessEvent,
  type AuditEntry,
} from "./audit.js";
import { log as coreLog } from "../logger.js";
import {
  runShell,
  runSpawn,
  DEFAULT_SUBPROCESS_TIMEOUT_MS,
  DEFAULT_SUBPROCESS_OUTPUT_CAP_BYTES,
  SUBPROCESS_CWD_MODE,
} from "./subprocess.js";
import {
  MAX_PRIVATE_READ_BYTES,
  MAX_PUBLIC_READ_BYTES,
  MAX_WRITE_ANY_BYTES,
  PKG_ROOT,
  checkReadBan,
  checkWriteBan,
  containsPath,
  summarisePath,
} from "./fs-policy.js";

/** Root of per-module public read area: data/public/<moduleId>/ */
const PUBLIC_ROOT = join(PKG_ROOT, "data", "public");

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
  /**
   * Part H: Provider for module-scoped settings. If omitted, settings.*
   * operations return defaults / no-ops.
   */
  settings?: {
    read(moduleId: string, key: string): Promise<string | number | boolean | null>;
    write(moduleId: string, key: string, value: string | number | boolean): Promise<void>;
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

  const subprocessPolicy = {
    timeoutMs: DEFAULT_SUBPROCESS_TIMEOUT_MS,
    stdoutCapBytes: DEFAULT_SUBPROCESS_OUTPUT_CAP_BYTES,
    stderrCapBytes: DEFAULT_SUBPROCESS_OUTPUT_CAP_BYTES,
  } as const;

  function auditSubprocessResult(
    permission: "shell.execute" | "process.spawn",
    cmd: string,
    args: string[],
    result: ProcessResult
  ): void {
    const payload = {
      cmd,
      args,
      cwd: SUBPROCESS_CWD_MODE,
      timeoutMs: subprocessPolicy.timeoutMs,
      stdoutCapBytes: subprocessPolicy.stdoutCapBytes,
      stderrCapBytes: subprocessPolicy.stderrCapBytes,
    };
    writeSubprocessEvent({
      kind: "subprocess_event",
      moduleId: manifest.id,
      permission,
      toolName: currentGrants()?.toolName,
      outcome: result.timedOut
        ? "timeout"
        : result.code === -1
          ? "spawn_error"
          : result.code === 0
            ? "success"
            : "nonzero_exit",
      commandHash: hashArgs(payload),
      commandSummary: summariseArgs(payload),
      code: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
      stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    });
  }

  function isHardBanError(err: unknown): boolean {
    return (
      err instanceof PermissionDeniedError &&
      typeof err.message === "string" &&
      err.message.startsWith("fs: hard ban")
    );
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

    settings: {
      async read(key: string): Promise<string | number | boolean | null> {
        if (!services.settings) return null;
        return services.settings.read(manifest.id, key);
      },
      async write(key: string, value: string | number | boolean): Promise<void> {
        if (!services.settings) return;
        writeSettingsEvent({
          kind: "settings_event",
          moduleId: manifest.id,
          operation: "write",
          settingKey: key,
          valueHash: hashArgs(value),
          outcome: "success",
          sensitive: false, // sensitivity check done at the API layer
        });
        return services.settings.write(manifest.id, key, value);
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
        if (!containsPath(base, abs)) {
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
        if (typeof abs !== "string" || abs.length === 0 || !isAbsolute(abs)) {
          writeFsEvent({
            kind: "fs_event",
            moduleId: manifest.id,
            permission: "fs.read_private",
            toolName: currentGrants()?.toolName,
            operation: "read",
            pathHash: hashArgs(String(abs)),
            pathSummary: String(abs),
            outcome: "denied_sandbox",
            banned: false,
          });
          throw new PermissionDeniedError(
            "DENIED",
            "fs.readPrivate: abs must be an absolute path"
          );
        }
        const target = resolve(abs);
        try {
          checkReadBan(target);
        } catch (err) {
          writeFsEvent({
            kind: "fs_event",
            moduleId: manifest.id,
            permission: "fs.read_private",
            toolName: currentGrants()?.toolName,
            operation: "read",
            pathHash: hashArgs(target),
            pathSummary: summarisePath(target),
            outcome: "denied_ban",
            banned: true,
          });
          throw err;
        }
        if (!existsSync(target)) {
          writeFsEvent({
            kind: "fs_event",
            moduleId: manifest.id,
            permission: "fs.read_private",
            toolName: currentGrants()?.toolName,
            operation: "read",
            pathHash: hashArgs(target),
            pathSummary: summarisePath(target),
            outcome: "not_found",
            banned: false,
          });
          throw new PermissionDeniedError(
            "DENIED",
            `fs.readPrivate: file not found (${target})`
          );
        }
        const info = statSync(target);
        if (!info.isFile()) {
          writeFsEvent({
            kind: "fs_event",
            moduleId: manifest.id,
            permission: "fs.read_private",
            toolName: currentGrants()?.toolName,
            operation: "read",
            pathHash: hashArgs(target),
            pathSummary: summarisePath(target),
            outcome: "denied_sandbox",
            banned: false,
          });
          throw new PermissionDeniedError(
            "DENIED",
            `fs.readPrivate: not a regular file (${target})`
          );
        }
        if (info.size > MAX_PRIVATE_READ_BYTES) {
          writeFsEvent({
            kind: "fs_event",
            moduleId: manifest.id,
            permission: "fs.read_private",
            toolName: currentGrants()?.toolName,
            operation: "read",
            pathHash: hashArgs(target),
            pathSummary: summarisePath(target),
            outcome: "denied_sandbox",
            banned: false,
          });
          throw new PermissionDeniedError(
            "DENIED",
            `fs.readPrivate: file exceeds ${MAX_PRIVATE_READ_BYTES}-byte cap (${info.size} bytes)`
          );
        }
        const body = readFileSync(target, "utf-8");
        writeFsEvent({
          kind: "fs_event",
          moduleId: manifest.id,
          permission: "fs.read_private",
          toolName: currentGrants()?.toolName,
          operation: "read",
          pathHash: hashArgs(target),
          pathSummary: summarisePath(target),
          outcome: "success",
          bytesTransferred: Buffer.byteLength(body, "utf-8"),
          banned: false,
        });
        return body;
      },
      async writeAny(abs: string, data: string): Promise<void> {
        checkGate("fs.write_any", {
          abs,
          bytes: typeof data === "string" ? Buffer.byteLength(data, "utf-8") : 0,
        });
        if (typeof abs !== "string" || abs.length === 0 || !isAbsolute(abs)) {
          writeFsEvent({
            kind: "fs_event",
            moduleId: manifest.id,
            permission: "fs.write_any",
            toolName: currentGrants()?.toolName,
            operation: "write",
            pathHash: hashArgs(String(abs)),
            pathSummary: String(abs),
            outcome: "denied_sandbox",
            banned: false,
          });
          throw new PermissionDeniedError(
            "DENIED",
            "fs.writeAny: abs must be an absolute path"
          );
        }
        if (typeof data !== "string") {
          throw new PermissionDeniedError(
            "DENIED",
            "fs.writeAny: data must be a string"
          );
        }
        const target = resolve(abs);
        const bytes = Buffer.byteLength(data, "utf-8");
        if (bytes > MAX_WRITE_ANY_BYTES) {
          writeFsEvent({
            kind: "fs_event",
            moduleId: manifest.id,
            permission: "fs.write_any",
            toolName: currentGrants()?.toolName,
            operation: "write",
            pathHash: hashArgs(target),
            pathSummary: summarisePath(target),
            outcome: "denied_sandbox",
            banned: false,
          });
          throw new PermissionDeniedError(
            "DENIED",
            `fs.writeAny: payload exceeds ${MAX_WRITE_ANY_BYTES}-byte cap (${bytes} bytes)`
          );
        }
        try {
          checkWriteBan(target);
        } catch (err) {
          writeFsEvent({
            kind: "fs_event",
            moduleId: manifest.id,
            permission: "fs.write_any",
            toolName: currentGrants()?.toolName,
            operation: "write",
            pathHash: hashArgs(target),
            pathSummary: summarisePath(target),
            outcome: isHardBanError(err) ? "denied_ban" : "error",
            banned: isHardBanError(err),
          });
          throw err;
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, data, "utf-8");
        writeFsEvent({
          kind: "fs_event",
          moduleId: manifest.id,
          permission: "fs.write_any",
          toolName: currentGrants()?.toolName,
          operation: "write",
          pathHash: hashArgs(target),
          pathSummary: summarisePath(target),
          outcome: "success",
          bytesTransferred: bytes,
          banned: false,
        });
      },
    },

    shell: {
      async execute(cmd: string, args: string[]): Promise<ProcessResult> {
        const safeCmd = typeof cmd === "string" ? cmd : "";
        const safeArgs = Array.isArray(args)
          ? args.filter((v): v is string => typeof v === "string")
          : [];
        checkGate("shell.execute", {
          cmd: safeCmd,
          args: safeArgs,
          cwd: SUBPROCESS_CWD_MODE,
          timeoutMs: subprocessPolicy.timeoutMs,
          stdoutCapBytes: subprocessPolicy.stdoutCapBytes,
          stderrCapBytes: subprocessPolicy.stderrCapBytes,
        });
        const result = await runShell(safeCmd, safeArgs, subprocessPolicy);
        auditSubprocessResult("shell.execute", safeCmd, safeArgs, result);
        return result;
      },
    },

    process: {
      async spawn(cmd: string, args: string[]): Promise<ProcessResult> {
        const safeCmd = typeof cmd === "string" ? cmd : "";
        const safeArgs = Array.isArray(args)
          ? args.filter((v): v is string => typeof v === "string")
          : [];
        checkGate("process.spawn", {
          cmd: safeCmd,
          args: safeArgs,
          cwd: SUBPROCESS_CWD_MODE,
          timeoutMs: subprocessPolicy.timeoutMs,
          stdoutCapBytes: subprocessPolicy.stdoutCapBytes,
          stderrCapBytes: subprocessPolicy.stderrCapBytes,
        });
        const result = await runSpawn(safeCmd, safeArgs, subprocessPolicy);
        auditSubprocessResult("process.spawn", safeCmd, safeArgs, result);
        return result;
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
