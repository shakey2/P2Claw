/**
 * P2 Claw - Core file-system policy helpers.
 *
 * Centralises sandbox + hard-ban checks so all real file operations flow through
 * one policy surface owned by Core.
 */

import { basename, dirname, isAbsolute, join, resolve, sep } from "path";
import { resolveAuditLogPath } from "./audit.js";
import { PermissionDeniedError } from "./types.js";

/**
 * Repo root.
 *
 * We intentionally anchor to `process.cwd()` because:
 * - All normal entrypoints run from the repo root (or packaged root).
 * - The module-system code lives under `src/core/modules/`, so resolving
 *   relative to `import.meta.url` is fragile when directory depth changes.
 */
export const PKG_ROOT = resolve(process.cwd());

/** Root for user-facing sandboxed file tools. */
export const WORKSPACE_ROOT = join(PKG_ROOT, "data", "workspace");

/** Maximum bytes for broker private reads. */
export const MAX_PRIVATE_READ_BYTES = 4 * 1024 * 1024;

/** Maximum bytes for broker public reads. */
export const MAX_PUBLIC_READ_BYTES = 1 * 1024 * 1024;

/** Maximum bytes for broker write-any operations. */
export const MAX_WRITE_ANY_BYTES = 10 * 1024 * 1024;

/** Maximum bytes for user-facing workspace read/write tools. */
export const MAX_WORKSPACE_FILE_BYTES = 1 * 1024 * 1024;

const SOURCE_TREE_BAN_PREFIXES = ["src", "dist", "scripts"].map((p) =>
  resolve(PKG_ROOT, p)
);

function lowerBaseName(pathValue: string): string {
  return basename(pathValue).toLowerCase();
}

function isDotEnvFamily(pathValue: string): boolean {
  const base = lowerBaseName(pathValue);
  return base === ".env" || base.startsWith(".env.") || base.endsWith(".env");
}

/**
 * Returns true when `target` resolves inside `base` (or equals it).
 *
 * Note: this is lexical containment based on `path.resolve()`. We currently do
 * not resolve symlinks with `realpath()` in this layer.
 */
export function containsPath(base: string, target: string): boolean {
  const baseAbs = resolve(base);
  const targetAbs = resolve(target);
  return targetAbs === baseAbs || targetAbs.startsWith(baseAbs + sep);
}

/**
 * Resolves a relative workspace path and enforces sandbox containment.
 */
export function checkWorkspaceSandbox(rel: string): string {
  if (typeof rel !== "string" || rel.trim().length === 0) {
    throw new PermissionDeniedError(
      "DENIED",
      "workspace path must be a non-empty string"
    );
  }
  const abs = resolve(WORKSPACE_ROOT, rel);
  if (!containsPath(WORKSPACE_ROOT, abs)) {
    throw new PermissionDeniedError(
      "DENIED",
      `workspace path escapes sandbox (${rel})`
    );
  }
  return abs;
}

/**
 * Paths that are always forbidden write targets.
 */
export const WRITE_BAN_EXACT: readonly string[] = [
  resolve(PKG_ROOT, ".env"),
  resolve(PKG_ROOT, "data", "p2claw.db"),
  resolve(PKG_ROOT, "package.json"),
  resolve(PKG_ROOT, "tsconfig.json"),
];

/**
 * Prefixes that are always forbidden write targets.
 */
export const WRITE_BAN_PREFIXES: readonly string[] = SOURCE_TREE_BAN_PREFIXES;

/**
 * Exact paths that are never readable via `fs.read_private`.
 */
export const READ_BAN_EXACT: readonly string[] = [resolve(PKG_ROOT, ".env")];

function isAuditLogPath(pathValue: string): boolean {
  const auditPath = resolve(resolveAuditLogPath());
  return pathValue === auditPath || pathValue === `${auditPath}.1`;
}

/**
 * Throws if the absolute write target is prohibited by hard policy.
 */
export function checkWriteBan(abs: string): void {
  if (typeof abs !== "string" || abs.length === 0 || !isAbsolute(abs)) {
    throw new PermissionDeniedError(
      "DENIED",
      "write target must be an absolute path"
    );
  }
  const target = resolve(abs);

  if (isDotEnvFamily(target)) {
    throw new PermissionDeniedError(
      "DENIED",
      `fs: hard ban on writing secret file (${basename(target)})`
    );
  }
  if (isAuditLogPath(target)) {
    throw new PermissionDeniedError(
      "DENIED",
      "fs: hard ban on writing audit log files"
    );
  }
  for (const exact of WRITE_BAN_EXACT) {
    if (target === resolve(exact)) {
      throw new PermissionDeniedError(
        "DENIED",
        `fs: hard ban on writing protected path (${basename(target)})`
      );
    }
  }
  for (const prefix of WRITE_BAN_PREFIXES) {
    const resolvedPrefix = resolve(prefix);
    if (containsPath(resolvedPrefix, target)) {
      throw new PermissionDeniedError(
        "DENIED",
        `fs: hard ban on writing source tree path (${basename(target)})`
      );
    }
  }
}

/**
 * Throws if the absolute read target is prohibited by hard policy.
 */
export function checkReadBan(abs: string): void {
  if (typeof abs !== "string" || abs.length === 0 || !isAbsolute(abs)) {
    throw new PermissionDeniedError(
      "DENIED",
      "read target must be an absolute path"
    );
  }
  const target = resolve(abs);
  if (isDotEnvFamily(target)) {
    throw new PermissionDeniedError(
      "DENIED",
      `fs: hard ban on reading secret file (${basename(target)})`
    );
  }
  for (const exact of READ_BAN_EXACT) {
    if (target === resolve(exact)) {
      throw new PermissionDeniedError(
        "DENIED",
        `fs: hard ban on reading protected path (${basename(target)})`
      );
    }
  }
}

/**
 * Redacted path summary for approval prompts and audit entries.
 */
export function summarisePath(absPath: string): string {
  const abs = resolve(absPath);
  if (containsPath(WORKSPACE_ROOT, abs)) {
    const rel = abs.slice(resolve(WORKSPACE_ROOT).length).replace(/^[\\/]+/, "");
    return rel.length > 0 ? `workspace/${rel.replace(/\\/g, "/")}` : "workspace/";
  }
  const parent = basename(dirname(abs));
  const file = basename(abs);
  if (!parent || parent === file) {
    return file;
  }
  return `${parent}/${file}`;
}

/**
 * Non-sensitive summary for file-operation approval prompts.
 */
export function buildFsApprovalSummary(
  op: "read" | "write" | "list",
  absPath: string,
  bytes?: number
): string {
  const target = summarisePath(absPath);
  if (op === "write") {
    const size = typeof bytes === "number" && Number.isFinite(bytes) ? bytes : 0;
    return `Write ${size} bytes -> ${target}`;
  }
  if (op === "read") {
    return `Read file -> ${target}`;
  }
  return `List directory -> ${target}`;
}
