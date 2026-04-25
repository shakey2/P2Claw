/**
 * P2 Claw — Module permission audit log.
 *
 * Append-only JSONL sink for every permission decision made by the capability
 * broker. One line per decision. Secrets never land here: only a SHA-256 hash
 * of the full argument payload plus a short, operator-readable summary.
 *
 * File: data/p2claw.audit.log (configurable via P2CLAW_AUDIT_LOG_PATH).
 * Rotation: when the file exceeds 5 MB, it is moved to `p2claw.audit.log.1`
 * (overwriting any previous rotation) and a fresh file is started.
 *
 * Writes are synchronous — the audit log MUST be on disk before the
 * broker dispatches the corresponding primitive.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "fs";
import { createHash } from "crypto";
import { dirname, join } from "path";
import type { McpEventEntry, McpLifecycleEntry } from "../../mcp/types.js";

const DEFAULT_LOG_PATH = join(process.cwd(), "data", "p2claw.audit.log");
const MAX_AUDIT_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Resolves the active audit log path. Honours `P2CLAW_AUDIT_LOG_PATH`
 * (read lazily so the verify harness can override it before the first
 * write). This is the one place that decides the path; exported so
 * dev-tools (`debug_tail_audit` / `/debug audit`) can tail the same file
 * the writer appends to instead of hardcoding `data/p2claw.audit.log`.
 */
export function resolveAuditLogPath(): string {
  const override = process.env.P2CLAW_AUDIT_LOG_PATH?.trim();
  return override && override.length > 0 ? override : DEFAULT_LOG_PATH;
}

export type AuditDecision =
  | "granted"
  | "denied"
  | "timeout"
  | "not_declared"
  | "error";

export interface AuditEntry {
  moduleId: string;
  permission: string;
  decision: AuditDecision;
  reason: string;
  argsHash?: string;
  argsSummary?: string;
  toolName?: string;
}

function rotateIfNeeded(path: string): void {
  try {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.size <= MAX_AUDIT_SIZE_BYTES) return;
    const rotated = `${path}.1`;
    if (existsSync(rotated)) {
      try {
        unlinkSync(rotated);
      } catch {
        /* best effort */
      }
    }
    renameSync(path, rotated);
  } catch {
    // Never crash the app because of the audit log.
  }
}

/**
 * Hashes the JSON-serialised argument payload with SHA-256.
 * Undefined args yield a stable empty-string hash so the column is always present.
 */
export function hashArgs(args: unknown): string {
  let serialised: string;
  try {
    serialised = JSON.stringify(args ?? null);
  } catch {
    serialised = "<unserialisable>";
  }
  return "sha256:" + createHash("sha256").update(serialised).digest("hex");
}

/**
 * Produces a short, non-sensitive summary of args for human review.
 * Truncated to ~120 chars. Secret-like keys are redacted before truncation.
 */
export function summariseArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args !== "object") {
    const s = String(args);
    return s.length > 120 ? s.slice(0, 117) + "..." : s;
  }

  const SENSITIVE = /token|secret|password|api[_-]?key|credential|authorization/i;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    const value = SENSITIVE.test(k)
      ? "[REDACTED]"
      : typeof v === "string"
        ? v.length > 40
          ? v.slice(0, 37) + "..."
          : v
        : JSON.stringify(v);
    parts.push(`${k}=${value}`);
    if (parts.join(" ").length > 120) break;
  }
  const joined = parts.join(" ");
  return joined.length > 120 ? joined.slice(0, 117) + "..." : joined;
}

/**
 * Writes a single audit entry synchronously. Never throws.
 */
export function writeAudit(entry: AuditEntry): void {
  const path = resolveAuditLogPath();
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    rotateIfNeeded(path);
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        ...entry,
      }) + "\n";
    appendFileSync(path, line, "utf-8");
  } catch {
    // Audit must never crash the app; the gate decision still stands.
  }
}

// ── Approval-gate events ─────────────────────────────────────────
//
// These records answer "what happened to this TOTP challenge?". They are
// written by the approval module rather than the registry so every outcome
// is captured regardless of which caller awaited the challenge.
//
// Terminal outcomes (the challenge is removed from the in-memory map):
//   approved   – TOTP verified correctly.
//   cancelled  – user sent CANCEL before the TTL expired (intentional abort).
//   denied     – future: module workflow /deny command rejects a call.
//   timeout    – TTL elapsed before a valid code was entered.
//   superseded – a new challenge for the same session was created, which
//                invalidates this one.
//   aborted    – process exited while the challenge was still pending (shutdown
//                drain). Written synchronously in the shutdown handler; no waiter
//                is resolved because the event loop is already closing.
//
// Non-terminal attempt records (challenge stays pending):
//   bad_code   – a wrong TOTP code was submitted; the challenge remains.

/** Terminal TOTP challenge outcomes. */
export type ApprovalOutcome =
  | "approved"
  | "aborted"      // process exited while challenge was pending (shutdown drain)
  | "cancelled"    // user explicitly sent CANCEL before the TTL expired
  | "denied"       // future: module workflow explicitly rejects a pending call
  | "timeout"      // TTL elapsed without a valid code
  | "superseded";  // a new challenge replaced this one for the same session

/** All outcomes that can appear in an approval_event record. */
export type ApprovalAttemptOutcome = ApprovalOutcome | "bad_code";

export interface ApprovalEventEntry {
  kind: "approval_event";
  toolName: string;
  challengeId: string;
  /**
   * "bad_code" is non-terminal (challenge stays pending); all others are
   * terminal and the challenge is removed from the in-memory map at write time.
   */
  outcome: ApprovalAttemptOutcome;
}

/**
 * Appends an approval-gate record to the shared JSONL audit file. Never throws.
 */
export function writeApprovalEvent(entry: ApprovalEventEntry): void {
  const path = resolveAuditLogPath();
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    rotateIfNeeded(path);
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        ...entry,
      }) + "\n";
    appendFileSync(path, line, "utf-8");
  } catch {
    /* never crash on audit failure */
  }
}

// ── Debug invocation events ─────────────────────────────────────
//
// The broker writes one `AuditEntry` per permission decision. That answers
// "which primitive was granted/denied for which module?" but not "who
// intentionally triggered this top-level tool call?". The dev-tools module
// needs that answer for both the LLM-facing `debug_call_tool` and the
// frontend `/debug call` path, so we emit a separate record type into the
// same JSONL file. Readers distinguish the two by the `kind` discriminator
// (absence means permission decision, for backward compatibility).

export type DebugInvocationResult =
  | "success"
  | "error"
  | "approval_timeout"
  | "approval_denied"
  | "recursion_rejected"
  | "unknown_tool";

export type DebugInvocationSurface =
  | "llm_debug_tool"
  | "frontend_debug_command";

export interface DebugInvocationEntry {
  kind: "debug_invocation";
  surface: DebugInvocationSurface;
  /** Stable caller id — e.g. `com.p2claw.dev-tools` or `frontend:<uiMode>:debug`. */
  callerId: string;
  targetTool: string;
  targetOwnerModuleId?: string;
  argsHash: string;
  argsSummary: string;
  result: DebugInvocationResult;
}

/**
 * Writes a debug-invocation record into the same JSONL audit file. Never
 * throws. Use `hashArgs` / `summariseArgs` to populate argsHash / argsSummary.
 */
export function writeDebugInvocation(entry: DebugInvocationEntry): void {
  const path = resolveAuditLogPath();
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    rotateIfNeeded(path);
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        ...entry,
      }) + "\n";
    appendFileSync(path, line, "utf-8");
  } catch {
    /* never crash on audit failure */
  }
}

// ── Subprocess execution events ─────────────────────────────────
//
// Permission decisions answer "was the primitive allowed?". For real shell and
// process execution we also log a narrow post-dispatch result record so
// operators can tell whether execution completed, timed out, or failed.

export type SubprocessOutcome =
  | "success"
  | "nonzero_exit"
  | "timeout"
  | "spawn_error";

export interface SubprocessEventEntry {
  kind: "subprocess_event";
  moduleId: string;
  permission: "shell.execute" | "process.spawn";
  toolName?: string;
  outcome: SubprocessOutcome;
  commandHash: string;
  commandSummary: string;
  code: number;
  signal?: string;
  timedOut: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export function writeSubprocessEvent(entry: SubprocessEventEntry): void {
  const path = resolveAuditLogPath();
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    rotateIfNeeded(path);
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        ...entry,
      }) + "\n";
    appendFileSync(path, line, "utf-8");
  } catch {
    /* never crash on audit failure */
  }
}

// ── MCP bridge runtime events ───────────────────────────────────
//
// `mcp_lifecycle` answers process-level questions (started/crashed/restarted).
// `mcp_event` answers per-tool-call outcomes (success/timeout/disconnected...).

export function writeMcpEvent(entry: McpEventEntry): void {
  const path = resolveAuditLogPath();
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    rotateIfNeeded(path);
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        ...entry,
      }) + "\n";
    appendFileSync(path, line, "utf-8");
  } catch {
    /* never crash on audit failure */
  }
}

export function writeMcpLifecycle(entry: McpLifecycleEntry): void {
  const path = resolveAuditLogPath();
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    rotateIfNeeded(path);
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        ...entry,
      }) + "\n";
    appendFileSync(path, line, "utf-8");
  } catch {
    /* never crash on audit failure */
  }
}

// -- File-system operation events ---------------------------------
//
// Permission decisions answer "was the permission allowed?". Real file
// operations also need a narrow post-dispatch record so operators can audit
// outcome class (success, banned target, sandbox escape, missing path).

export type FsOperation = "read" | "write" | "list";

export type FsOutcome =
  | "success"
  | "denied_ban"
  | "denied_sandbox"
  | "not_found"
  | "error";

export interface FsEventEntry {
  kind: "fs_event";
  moduleId: string;
  permission: "fs.read_public" | "fs.read_private" | "fs.write_any";
  toolName?: string;
  operation: FsOperation;
  pathHash: string;
  pathSummary: string;
  outcome: FsOutcome;
  bytesTransferred?: number;
  banned: boolean;
}

export function writeFsEvent(entry: FsEventEntry): void {
  const path = resolveAuditLogPath();
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    rotateIfNeeded(path);
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        ...entry,
      }) + "\n";
    appendFileSync(path, line, "utf-8");
  } catch {
    /* never crash on audit failure */
  }
}

// ── Module settings events (Part H) ─────────────────────────────
//
// Records module settings reads and writes so operators can trace
// who changed what and when. Sensitive field values are hashed.

export type SettingsOutcome =
  | "success"
  | "validation_error"
  | "not_found"
  | "totp_required"
  | "error";

export interface SettingsEventEntry {
  kind: "settings_event";
  moduleId: string;
  operation: "read" | "write";
  settingKey: string;
  /** Only present for writes — SHA-256 hash of the new value. */
  valueHash?: string;
  outcome: SettingsOutcome;
  sensitive: boolean;
  error?: string;
}

export function writeSettingsEvent(entry: SettingsEventEntry): void {
  const path = resolveAuditLogPath();
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    rotateIfNeeded(path);
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        ...entry,
      }) + "\n";
    appendFileSync(path, line, "utf-8");
  } catch {
    /* never crash on audit failure */
  }
}

