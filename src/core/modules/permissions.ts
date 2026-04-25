/**
 * P2 Claw — Module permission catalog.
 *
 * Fixed, broad permission categories owned by Core. This list is the SINGLE
 * source of truth — modules cannot declare permissions outside it. Adding a
 * new category requires a Core release and a DESIGN.md Decision Log entry.
 *
 * Risk levels:
 *   - "safe" : no user approval required; audit log still records grants.
 *   - "high" : must pass TOTP approval (src/security/approval.ts) before the
 *              broker dispatches the underlying primitive. High-risk grants
 *              are always written to the audit log.
 *
 * See DESIGN.md §4.7 "Module framework (Phase 1)" for context.
 */

export type PermissionRisk = "safe" | "high";

export interface PermissionDescriptor {
  readonly id: string;
  readonly riskLevel: PermissionRisk;
  readonly description: string;
}

/**
 * Core's fixed permission catalog. DO NOT extend at runtime.
 *
 * Categories are intentionally broad to avoid a per-action permission explosion.
 * If a proposed capability cannot be expressed here, the answer is a Core PR
 * that adds one new broad category — not a module-declared custom key.
 */
export const PERMISSION_CATALOG = [
  {
    id: "time.now",
    riskLevel: "safe",
    description: "Read the current wall-clock time.",
  },
  {
    id: "log.info",
    riskLevel: "safe",
    description: "Write informational lines to the application log (not the audit log).",
  },
  {
    id: "memory.read",
    riskLevel: "safe",
    description: "Read from this module's own memory scope.",
  },
  {
    id: "memory.write",
    riskLevel: "safe",
    description: "Write to this module's own memory scope.",
  },
  {
    id: "fs.read_public",
    riskLevel: "safe",
    description:
      "Read files under an allowlisted public area (data/public/*) — no user secrets, no .env.",
  },
  {
    id: "fs.read_private",
    riskLevel: "high",
    description:
      "Read arbitrary files on disk, including .env, user documents, and credentials.",
  },
  {
    id: "fs.write_any",
    riskLevel: "high",
    description: "Write anywhere on disk (create, overwrite, delete).",
  },
  {
    id: "shell.execute",
    riskLevel: "high",
    description: "Run a subprocess or shell command.",
  },
  {
    id: "process.spawn",
    riskLevel: "high",
    description: "Spawn a Node child process without invoking a shell.",
  },
  {
    id: "net.outbound",
    riskLevel: "high",
    description: "Make outbound network requests (HTTP, sockets, DNS lookups).",
  },
  {
    id: "credentials.read",
    riskLevel: "high",
    description:
      "Read resolved secrets — Player2 game key, Telegram bot token, or TOTP secret.",
  },
] as const satisfies readonly PermissionDescriptor[];

/** Literal union of every valid permission id. */
export type PermissionId = (typeof PERMISSION_CATALOG)[number]["id"];

const CATALOG_MAP: ReadonlyMap<string, PermissionDescriptor> = new Map(
  PERMISSION_CATALOG.map((p) => [p.id, p])
);

/** Returns true if `id` is a recognised Core permission. */
export function isKnownPermission(id: string): id is PermissionId {
  return CATALOG_MAP.has(id);
}

/** Returns the catalog entry for a permission id, or `undefined` if unknown. */
export function getPermission(id: string): PermissionDescriptor | undefined {
  return CATALOG_MAP.get(id);
}

/** Returns the highest risk level across the given permissions; "safe" if empty. */
export function maxRisk(ids: readonly string[]): PermissionRisk {
  for (const id of ids) {
    const p = CATALOG_MAP.get(id);
    if (p?.riskLevel === "high") {
      return "high";
    }
  }
  return "safe";
}
