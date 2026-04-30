import { randomUUID } from "crypto";
import { extname, resolve } from "path";
import {
  getPermission,
  isKnownPermission,
  isWhitelistable,
} from "../core/modules/permissions.js";
import type { PermissionId } from "../core/modules/permissions.js";
import { getCoreSecurityDb, scheduleCoreSecuritySave } from "./core-security-db.js";
import type {
  Capability,
  CapabilityConstraints,
  CapabilityMatchContext,
  CapabilityScope,
} from "./capability-types.js";

const activeCapabilities = new Map<string, Capability>();

export function createCapability(capability: Capability): Capability {
  if (!isKnownPermission(capability.permission)) {
    throw new Error(`Unknown permission "${capability.permission}".`);
  }
  if (!isWhitelistable(capability.permission)) {
    throw new Error(`Permission "${capability.permission}" is critical and cannot be saved as a capability.`);
  }

  const catalogEntry = getPermission(capability.permission);
  if (
    capability.tool === "*" &&
    (catalogEntry?.riskLevel === "dangerous" || catalogEntry?.riskLevel === "critical")
  ) {
    throw new Error(`Wildcard tool capabilities are not allowed for ${catalogEntry.riskLevel} permissions.`);
  }

  const now = new Date().toISOString();
  const normalized: Capability = {
    ...capability,
    id: capability.id || randomUUID(),
    riskLevel: catalogEntry?.riskLevel ?? capability.riskLevel,
    createdAt: capability.createdAt || now,
    expiresAt: capability.expiresAt ?? null,
    persistent: Boolean(capability.persistent),
  };

  activeCapabilities.set(normalized.id, normalized);
  if (normalized.persistent) {
    upsertPersistentCapability(normalized);
  }
  return normalized;
}

export function findMatchingCapability(
  tool: string,
  permission: PermissionId,
  context: CapabilityMatchContext = {}
): Capability | null {
  pruneExpiredCapabilities();
  for (const cap of activeCapabilities.values()) {
    if (cap.permission !== permission) continue;
    if (cap.tool !== "*" && cap.tool !== tool) continue;
    if (!scopeMatches(cap.scope, context)) continue;
    if (!constraintsMatch(cap.constraints, context)) continue;
    return cap;
  }
  return null;
}

export function listCapabilities(): Capability[] {
  pruneExpiredCapabilities();
  return [...activeCapabilities.values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  );
}

export function revokeCapability(id: string): boolean {
  const existed = activeCapabilities.delete(id);
  const db = getCoreSecurityDb();
  const stmt = db.prepare(`DELETE FROM capabilities WHERE id = ?`);
  stmt.run([id]);
  stmt.free();
  if (existed || db.getRowsModified() > 0) {
    scheduleCoreSecuritySave();
    return true;
  }
  return false;
}

export function revokeAll(): number {
  const count = activeCapabilities.size;
  activeCapabilities.clear();
  getCoreSecurityDb().exec(`DELETE FROM capabilities;`);
  scheduleCoreSecuritySave();
  return count;
}

export function loadPersistentCapabilities(): number {
  const db = getCoreSecurityDb();
  const result = db.exec(`
    SELECT id, tool, permission, scope_type, scope_path, scope_pattern,
           scope_command, constraints_json, risk_level, created_at, expires_at,
           persistent, granted_via
    FROM capabilities
  `);

  let loaded = 0;
  for (const table of result) {
    for (const row of table.values) {
      const cap = rowToCapability(row);
      if (!cap) continue;
      activeCapabilities.set(cap.id, cap);
      loaded++;
    }
  }
  pruneExpiredCapabilities();
  return loaded;
}

export function clearSessionCapabilities(): number {
  let removed = 0;
  for (const [id, cap] of [...activeCapabilities.entries()]) {
    if (cap.persistent) continue;
    activeCapabilities.delete(id);
    removed++;
  }
  return removed;
}

function upsertPersistentCapability(cap: Capability): void {
  const db = getCoreSecurityDb();
  const stmt = db.prepare(`
    INSERT INTO capabilities (
      id, tool, permission, scope_type, scope_path, scope_pattern,
      scope_command, constraints_json, risk_level, created_at, expires_at,
      persistent, granted_via
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      tool = excluded.tool,
      permission = excluded.permission,
      scope_type = excluded.scope_type,
      scope_path = excluded.scope_path,
      scope_pattern = excluded.scope_pattern,
      scope_command = excluded.scope_command,
      constraints_json = excluded.constraints_json,
      risk_level = excluded.risk_level,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at,
      persistent = excluded.persistent,
      granted_via = excluded.granted_via
  `);
  stmt.run([
    cap.id,
    cap.tool,
    cap.permission,
    cap.scope.type,
    cap.scope.path ?? null,
    cap.scope.pattern ?? null,
    cap.scope.command ?? null,
    cap.constraints ? JSON.stringify(cap.constraints) : null,
    cap.riskLevel,
    cap.createdAt,
    cap.expiresAt,
    cap.persistent ? 1 : 0,
    cap.grantedVia,
  ]);
  stmt.free();
  scheduleCoreSecuritySave();
}

function rowToCapability(row: unknown[]): Capability | null {
  const permission = String(row[2] ?? "");
  if (!isKnownPermission(permission)) return null;
  const constraints = parseConstraints(row[7]);
  const scope: CapabilityScope = {
    type: String(row[3]) as CapabilityScope["type"],
    path: nullableString(row[4]),
    pattern: nullableString(row[5]),
    command: nullableString(row[6]),
  };
  return {
    id: String(row[0]),
    tool: String(row[1]),
    permission,
    scope,
    constraints,
    riskLevel: getPermission(permission)?.riskLevel ?? "safe",
    createdAt: String(row[9]),
    expiresAt: nullableString(row[10]) ?? null,
    persistent: Boolean(row[11]),
    grantedVia: String(row[12]) as Capability["grantedVia"],
  };
}

function nullableString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseConstraints(raw: unknown): CapabilityConstraints | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw) as CapabilityConstraints;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function pruneExpiredCapabilities(): void {
  const now = Date.now();
  const expiredIds: string[] = [];
  for (const [id, cap] of activeCapabilities.entries()) {
    if (cap.expiresAt && Date.parse(cap.expiresAt) <= now) {
      activeCapabilities.delete(id);
      expiredIds.push(id);
    }
  }
  if (expiredIds.length > 0) {
    const db = getCoreSecurityDb();
    const stmt = db.prepare(`DELETE FROM capabilities WHERE id = ?`);
    for (const id of expiredIds) {
      stmt.run([id]);
    }
    stmt.free();
    scheduleCoreSecuritySave();
  }
}

function scopeMatches(scope: CapabilityScope, context: CapabilityMatchContext): boolean {
  switch (scope.type) {
    case "once":
    case "session":
    case "project":
      return true;
    case "file":
      return Boolean(scope.path && context.path && samePath(scope.path, context.path));
    case "folder":
      return folderScopeMatches(scope, context.path);
  }
}

function folderScopeMatches(scope: CapabilityScope, candidatePath: string | undefined): boolean {
  if (!candidatePath) return false;
  if (scope.pattern) {
    return globLikeMatches(scope.pattern, candidatePath);
  }
  if (!scope.path) return false;
  const base = normalizePath(scope.path);
  const candidate = normalizePath(candidatePath);
  return candidate === base || candidate.startsWith(`${base}/`);
}

function constraintsMatch(
  constraints: CapabilityConstraints | undefined,
  context: CapabilityMatchContext
): boolean {
  if (!constraints) return true;
  if (constraints.commandAllowlist?.length) {
    if (!context.command || !constraints.commandAllowlist.includes(context.command)) {
      return false;
    }
  }
  if (constraints.allowedExtensions?.length) {
    if (!context.path) return false;
    const ext = extname(context.path).toLowerCase();
    const allowed = constraints.allowedExtensions.map((value) => value.toLowerCase());
    if (!allowed.includes(ext)) return false;
  }
  if (typeof constraints.maxFileSize === "number") {
    const size = inferPayloadSize(context.args);
    if (size !== null && size > constraints.maxFileSize) return false;
  }
  return true;
}

function inferPayloadSize(args: Record<string, unknown> | undefined): number | null {
  if (!args) return null;
  for (const key of ["content", "data", "body"]) {
    const value = args[key];
    if (typeof value === "string") {
      return Buffer.byteLength(value, "utf-8");
    }
  }
  return null;
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function normalizePath(pathValue: string): string {
  return resolve(pathValue).replace(/\\/g, "/").toLowerCase();
}

function globLikeMatches(pattern: string, candidatePath: string): boolean {
  const normalizedCandidates = [
    candidatePath.replace(/\\/g, "/").toLowerCase(),
    normalizePath(candidatePath),
  ];
  const normalizedPatterns = [
    pattern.replace(/\\/g, "/").toLowerCase(),
    resolve(pattern).replace(/\\/g, "/").toLowerCase(),
  ];
  return normalizedPatterns.some((normalizedPattern) =>
    normalizedCandidates.some((normalizedCandidate) =>
      oneGlobLikePatternMatches(normalizedPattern, normalizedCandidate)
    )
  );
}

function oneGlobLikePatternMatches(
  normalizedPattern: string,
  normalizedCandidate: string
): boolean {
  if (normalizedPattern.endsWith("/**")) {
    const base = normalizedPattern.slice(0, -3);
    return normalizedCandidate === base || normalizedCandidate.startsWith(`${base}/`);
  }
  const escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*")}$`);
  return regex.test(normalizedCandidate);
}
