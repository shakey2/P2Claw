/**
 * P2 Claw — Module manifest schema + strict validator.
 *
 * Every first-party module in `src/extensions/<folder>/` must ship a
 * `manifest.json` that passes this validator. Validation is intentionally
 * strict: any unexpected field shape or any permission/runtime outside the
 * Core-owned allowlist rejects the entire manifest.
 *
 * Phase 1 rules:
 *   - runtime MUST be "inprocess". "mcp" is rejected as not-yet-implemented.
 *   - firstParty MUST be `true` AND the module's folder name must be a key in
 *     `FIRST_PARTY_ALLOWLIST` AND `manifest.id` must equal the value that
 *     folder is bound to. This folder->id binding prevents a "rename a
 *     first-party folder and swap its contents" spoof. Modules cannot
 *     self-promote to firstParty.
 *   - Every permission id must be in the Core catalog.
 *   - Every tool's `requires` list must be a subset of the module's permissions.
 *   - `entry` must resolve to a file inside the module folder (no "..").
 *
 * Note: `firstParty: true` is a required informational marker, not a security
 * claim. The `FIRST_PARTY_ALLOWLIST` map + the capability broker's permission
 * and TOTP gates are the authoritative security boundary. For in-process
 * modules the real trust boundary is code review; OS-level isolation is a
 * Phase 2 concern (MCP subprocesses).
 */

import { existsSync, statSync } from "fs";
import { isAbsolute, join, normalize, relative, sep } from "path";
import {
  PERMISSION_CATALOG,
  isKnownPermission,
  type PermissionId,
} from "./permissions.js";

export type ModuleRuntime = "inprocess" | "mcp";

export interface ManifestTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  requires: readonly PermissionId[];
}

export interface ModuleManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  runtime: ModuleRuntime;
  firstParty: boolean;
  entry: string;
  permissions: readonly PermissionId[];
  tools: readonly ManifestTool[];
}

/**
 * Folders inside `src/extensions/` that are allowed to set `firstParty: true`,
 * each bound to the exact reverse-DNS module id we expect that folder to ship.
 *
 * Binding the folder to the id closes a practical spoof: without it, anyone
 * dropping arbitrary code into `src/extensions/demo-safe/` could claim any
 * module id they wanted (e.g. `com.evil.impostor`) and still pass first-party
 * validation, muddying audit logs and any future policy decisions keyed off
 * `moduleId`. With the binding, `folderName -> id` is 1:1 and authoritative.
 */
export const FIRST_PARTY_ALLOWLIST: Readonly<Record<string, string>> = {
  "demo-safe": "com.p2claw.demo-safe",
  "demo-high-risk": "com.p2claw.demo-high-risk",
  // Dev-tools ships in-tree but is only scanned by the loader when
  // P2CLAW_DEV_MODE=true. The allowlist entry stays unconditional so the
  // folder->id binding still holds if dev mode is ever toggled on.
  "dev-tools": "com.p2claw.dev-tools",
};

const ID_REGEX = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,4}$/;
const TOOL_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const SEMVER_REGEX =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export class ManifestValidationError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ManifestValidationError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ManifestValidationError(code, message);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(obj: Record<string, unknown>, field: string): string {
  const v = obj[field];
  if (typeof v !== "string" || v.trim().length === 0) {
    fail("ERR_MANIFEST_FIELD", `manifest.${field} must be a non-empty string`);
  }
  return v;
}

/**
 * Validates a parsed manifest object and returns a typed ModuleManifest.
 * `folderName` is the basename of the module's folder in `src/extensions/`;
 * used to enforce the firstParty allowlist.
 * `folderPath` is the absolute path of the module folder; used to validate
 * that `entry` resolves inside it.
 */
export function validateManifest(
  raw: unknown,
  folderName: string,
  folderPath: string
): ModuleManifest {
  if (!isObject(raw)) {
    fail("ERR_MANIFEST_SHAPE", "manifest.json must be a JSON object");
  }

  const id = requireString(raw, "id");
  if (!ID_REGEX.test(id)) {
    fail(
      "ERR_MANIFEST_ID",
      `manifest.id "${id}" must be reverse-DNS (e.g. com.example.my-module)`
    );
  }

  const name = requireString(raw, "name");
  const version = requireString(raw, "version");
  if (!SEMVER_REGEX.test(version)) {
    fail(
      "ERR_MANIFEST_VERSION",
      `manifest.version "${version}" must be semver (e.g. 0.1.0)`
    );
  }

  const description = requireString(raw, "description");

  const runtime = raw.runtime;
  if (runtime !== "inprocess" && runtime !== "mcp") {
    fail(
      "ERR_MANIFEST_RUNTIME",
      `manifest.runtime must be "inprocess" (mcp is planned for Phase 2)`
    );
  }
  if (runtime === "mcp") {
    fail(
      "ERR_MCP_NOT_IMPLEMENTED_PHASE1",
      `runtime "mcp" is not implemented in Phase 1; use "inprocess" for first-party modules`
    );
  }

  if (raw.firstParty !== true) {
    fail(
      "ERR_MANIFEST_FIRST_PARTY",
      `manifest.firstParty must be true in Phase 1 (third-party modules are not yet loaded)`
    );
  }
  const expectedId = Object.prototype.hasOwnProperty.call(
    FIRST_PARTY_ALLOWLIST,
    folderName
  )
    ? FIRST_PARTY_ALLOWLIST[folderName]
    : undefined;
  if (expectedId === undefined) {
    fail(
      "ERR_FIRST_PARTY_NOT_ALLOWLISTED",
      `module folder "${folderName}" is not in FIRST_PARTY_ALLOWLIST; modules cannot self-promote to firstParty`
    );
  }
  if (expectedId !== id) {
    fail(
      "ERR_FIRST_PARTY_ID_MISMATCH",
      `module folder "${folderName}" is bound to id "${expectedId}" in FIRST_PARTY_ALLOWLIST, but manifest.id is "${id}"`
    );
  }

  const entry = requireString(raw, "entry");
  if (isAbsolute(entry) || entry.includes("..")) {
    fail(
      "ERR_MANIFEST_ENTRY",
      `manifest.entry "${entry}" must be a relative path inside the module folder`
    );
  }
  const resolvedEntry = normalize(join(folderPath, entry));
  const rel = relative(folderPath, resolvedEntry);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    fail(
      "ERR_MANIFEST_ENTRY",
      `manifest.entry "${entry}" escapes the module folder`
    );
  }

  if (!Array.isArray(raw.permissions)) {
    fail("ERR_MANIFEST_PERMISSIONS", "manifest.permissions must be an array of strings");
  }
  const perms = raw.permissions as unknown[];
  const permSet = new Set<string>();
  for (const p of perms) {
    if (typeof p !== "string") {
      fail("ERR_MANIFEST_PERMISSIONS", "manifest.permissions entries must be strings");
    }
    if (!isKnownPermission(p)) {
      fail(
        "ERR_UNKNOWN_PERMISSION",
        `unknown permission "${p}"; valid permissions: ${PERMISSION_CATALOG.map((c) => c.id).join(", ")}`
      );
    }
    if (permSet.has(p)) {
      fail("ERR_DUPLICATE_PERMISSION", `manifest.permissions contains duplicate "${p}"`);
    }
    permSet.add(p);
  }

  if (!Array.isArray(raw.tools)) {
    fail("ERR_MANIFEST_TOOLS", "manifest.tools must be an array");
  }
  const rawTools = raw.tools as unknown[];
  const toolNames = new Set<string>();
  const tools: ManifestTool[] = [];
  for (const t of rawTools) {
    if (!isObject(t)) {
      fail("ERR_MANIFEST_TOOL_SHAPE", "each tool entry must be an object");
    }
    const toolName = requireString(t, "name");
    if (!TOOL_NAME_REGEX.test(toolName)) {
      fail(
        "ERR_MANIFEST_TOOL_NAME",
        `tool.name "${toolName}" must match ${TOOL_NAME_REGEX}`
      );
    }
    if (toolNames.has(toolName)) {
      fail("ERR_DUPLICATE_TOOL", `duplicate tool name "${toolName}" in manifest`);
    }
    toolNames.add(toolName);

    const toolDescription = requireString(t, "description");

    const parameters = t.parameters;
    if (!isObject(parameters)) {
      fail("ERR_MANIFEST_TOOL_PARAMETERS", `tool "${toolName}".parameters must be an object`);
    }

    if (!Array.isArray(t.requires)) {
      fail(
        "ERR_MANIFEST_TOOL_REQUIRES",
        `tool "${toolName}".requires must be an array of permission ids`
      );
    }
    const requires: PermissionId[] = [];
    const reqSet = new Set<string>();
    for (const r of t.requires as unknown[]) {
      if (typeof r !== "string") {
        fail(
          "ERR_MANIFEST_TOOL_REQUIRES",
          `tool "${toolName}".requires entries must be strings`
        );
      }
      if (!isKnownPermission(r)) {
        fail(
          "ERR_UNKNOWN_PERMISSION",
          `tool "${toolName}".requires contains unknown permission "${r}"`
        );
      }
      if (!permSet.has(r)) {
        fail(
          "ERR_TOOL_REQUIRES_UNDECLARED",
          `tool "${toolName}" requires "${r}" but module.permissions does not declare it`
        );
      }
      if (reqSet.has(r)) {
        fail(
          "ERR_DUPLICATE_TOOL_REQUIRE",
          `tool "${toolName}".requires contains duplicate "${r}"`
        );
      }
      reqSet.add(r);
      requires.push(r);
    }

    tools.push({
      name: toolName,
      description: toolDescription,
      parameters,
      requires,
    });
  }

  return {
    id,
    name,
    version,
    description,
    runtime,
    firstParty: true,
    entry,
    permissions: Array.from(permSet) as PermissionId[],
    tools,
  };
}

/** True if `entry` resolves to an existing file under the module folder. */
export function entryExists(folderPath: string, entry: string): boolean {
  const p = normalize(join(folderPath, entry));
  return existsSync(p) && statSync(p).isFile();
}
