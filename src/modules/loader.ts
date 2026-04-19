/**
 * P2 Claw — Module loader.
 *
 * Scans `src/extensions/*\/manifest.json`, validates each manifest, and then:
 *   - runtime "inprocess": dynamic-imports entry and contributes tools.
 *   - runtime "mcp": starts a Core-owned MCP host and bridges its tools into
 *     the registry (permissions still come from the manifest).
 *
 * A failure in any individual module is isolated — the loader logs the
 * rejection and continues with the rest.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  validateManifest,
  entryExists,
  ManifestValidationError,
  type ModuleManifest,
} from "./manifest.js";
import { createBroker, type BrokerCoreServices } from "./broker.js";
import type { Module, ModuleTool } from "./types.js";
import { registerModuleTool } from "../tools/registry.js";
import type { ToolDefinition } from "../tools/tool-types.js";
import { registerLoadedModule, summaryFromManifest } from "./runtime-index.js";
import { registerMcpTools } from "../mcp/bridge.js";
import { McpServerHost } from "../mcp/host.js";
import { registerMcpHost, stopAllMcpHosts } from "../mcp/registry.js";

/**
 * The in-tree `dev-tools` module is only scanned when the caller opts in
 * (P2CLAW_DEV_MODE=true surfaces via `loadModules(..., { devMode: true })`).
 * Kept here rather than inside the dev-tools folder itself so the gate
 * works even if `src/extensions/dev-tools/` is misconfigured.
 */
const DEV_TOOLS_FOLDER = "dev-tools";
const MCP_VERIFY_FIXTURE_FOLDER = "mcp-echo";

export interface LoadModulesOptions {
  /**
   * When true, the loader includes `src/extensions/dev-tools/`. When false
   * (default) that folder is skipped entirely — its manifest is not parsed,
   * its tools are never registered, and it does not appear in the runtime
   * module index. See DESIGN.md §4.7.
   */
  devMode?: boolean;
  /**
   * Optional default timeout for MCP tool calls routed through McpServerHost.
   * If omitted, the host uses its built-in default.
   */
  mcpCallTimeoutMs?: number;
  /**
   * Test-harness gate for the in-tree `mcp-echo` fixture. Normal boots should
   * leave this false so verification fixtures never widen production surface.
   */
  mcpVerify?: boolean;
}

/** Where Core looks for first-party modules. Resolved from this file's location. */
function resolveExtensionsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // This file lives at src/modules/loader.ts (or dist/modules/loader.js).
  // Extensions live one level up in src/extensions (or dist/extensions).
  return resolve(here, "..", "extensions");
}

export interface LoadModulesResult {
  loaded: Array<{ id: string; toolCount: number }>;
  rejected: Array<{ folder: string; code: string; reason: string }>;
}

function safeReadManifest(folderPath: string): unknown {
  const path = join(folderPath, "manifest.json");
  if (!existsSync(path)) {
    throw new ManifestValidationError(
      "ERR_MANIFEST_MISSING",
      `manifest.json not found in ${folderPath}`
    );
  }
  const raw = readFileSync(path, "utf-8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ManifestValidationError(
      "ERR_MANIFEST_JSON",
      `manifest.json in ${folderPath} is not valid JSON: ${msg}`
    );
  }
}

function importErrorMessage(err: unknown): { code: string; reason: string } {
  if (err instanceof ManifestValidationError) {
    return { code: err.code, reason: err.message };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { code: "ERR_MODULE_LOAD", reason: msg };
}

function buildToolDefinition(
  manifest: ModuleManifest,
  tool: ModuleTool
): ToolDefinition {
  const schemaName = tool.schema.function.name;
  const declaredInManifest = manifest.tools.find((t) => t.name === schemaName);
  if (!declaredInManifest) {
    throw new ManifestValidationError(
      "ERR_TOOL_NOT_IN_MANIFEST",
      `module "${manifest.id}" contributed tool "${schemaName}" but it is not declared in manifest.tools`
    );
  }

  // Cross-check: the runtime `requires` must exactly match what the manifest
  // advertised. This prevents a malicious/buggy module from quietly consuming
  // a permission the manifest says it does not need.
  const manifestReqs = new Set<string>(declaredInManifest.requires);
  const runtimeReqs = new Set<string>(tool.requires);
  if (
    manifestReqs.size !== runtimeReqs.size ||
    [...runtimeReqs].some((r) => !manifestReqs.has(r))
  ) {
    throw new ManifestValidationError(
      "ERR_TOOL_REQUIRES_MISMATCH",
      `module "${manifest.id}" tool "${schemaName}" runtime requires [${[...runtimeReqs].join(", ")}] != manifest [${[...manifestReqs].join(", ")}]`
    );
  }

  return {
    schema: tool.schema,
    handler: tool.handler,
    ownerModuleId: manifest.id,
    requiredPermissions: tool.requires,
  };
}

/**
 * Loads all first-party modules from `src/extensions/`. Returns a summary of
 * successes and rejections; never throws.
 *
 * `options.devMode` gates the in-tree dev-tools module — see
 * `LoadModulesOptions` and DESIGN.md §4.7.
 */
export async function loadModules(
  services: BrokerCoreServices = {},
  options: LoadModulesOptions = {}
): Promise<LoadModulesResult> {
  const devMode = options.devMode === true;
  const mcpVerify = options.mcpVerify === true;
  const result: LoadModulesResult = { loaded: [], rejected: [] };
  const extensionsDir = resolveExtensionsDir();

  if (!existsSync(extensionsDir)) {
    return result;
  }

  let folders: string[];
  try {
    folders = readdirSync(extensionsDir).filter((name) => {
      const full = join(extensionsDir, name);
      try {
        return statSync(full).isDirectory();
      } catch {
        return false;
      }
    });
  } catch (err) {
    const { code, reason } = importErrorMessage(err);
    result.rejected.push({ folder: "(root)", code, reason });
    return result;
  }

  for (const folder of folders) {
    // Dev-mode gate: skip dev-tools silently when disabled. The FIRST_PARTY
    // allowlist entry stays unconditional so a stray dev-tools folder in a
    // non-dev install still fails safely if someone flips dev mode on later.
    if (folder === DEV_TOOLS_FOLDER && !devMode) {
      continue;
    }
    if (folder === MCP_VERIFY_FIXTURE_FOLDER && !mcpVerify) {
      continue;
    }
    const folderPath = join(extensionsDir, folder);
    let manifest: ModuleManifest;

    try {
      const rawManifest = safeReadManifest(folderPath);
      manifest = validateManifest(rawManifest, folder, folderPath);
    } catch (err) {
      const { code, reason } = importErrorMessage(err);
      result.rejected.push({ folder, code, reason });
      continue;
    }

    if (manifest.runtime === "inprocess") {
      // When running via tsx the compiled .js may not exist; fall back to .ts.
      let importedEntry = manifest.entry;
      if (!entryExists(folderPath, importedEntry)) {
        const withTs = manifest.entry.replace(/\.js$/, ".ts");
        if (entryExists(folderPath, withTs)) {
          importedEntry = withTs;
        } else {
          result.rejected.push({
            folder,
            code: "ERR_ENTRY_NOT_FOUND",
            reason: `entry "${manifest.entry}" not found in ${folderPath}`,
          });
          continue;
        }
      }

      const entryAbs = join(folderPath, importedEntry);
      const entryUrl = pathToFileURL(entryAbs).href;

      let loaded: { default?: Module } & Partial<Module>;
      try {
        loaded = (await import(entryUrl)) as typeof loaded;
      } catch (err) {
        const { code, reason } = importErrorMessage(err);
        result.rejected.push({ folder, code, reason });
        continue;
      }

      const mod: Module | undefined = loaded.default ?? (loaded as Module);
      if (!mod || typeof mod.register !== "function") {
        result.rejected.push({
          folder,
          code: "ERR_MODULE_SHAPE",
          reason: `module "${manifest.id}" does not default-export a Module with a register() function`,
        });
        continue;
      }

      const ctx = createBroker(manifest, services);
      const registeredTools: ModuleTool[] = [];
      const contributeTool = (tool: ModuleTool): void => {
        registeredTools.push(tool);
      };

      try {
        await mod.register({ ctx, contributeTool });
      } catch (err) {
        const { code, reason } = importErrorMessage(err);
        result.rejected.push({ folder, code, reason });
        continue;
      }

      // Post-validation: every manifest-declared tool must have been contributed.
      const contributedNames = new Set(
        registeredTools.map((t) => t.schema.function.name)
      );
      const missing = manifest.tools
        .map((t) => t.name)
        .filter((n) => !contributedNames.has(n));
      if (missing.length > 0) {
        result.rejected.push({
          folder,
          code: "ERR_TOOLS_NOT_CONTRIBUTED",
          reason: `module "${manifest.id}" declared tools [${missing.join(", ")}] in manifest but did not contribute them at register time`,
        });
        continue;
      }

      let toolsRegistered = 0;
      let rejected = false;
      for (const t of registeredTools) {
        try {
          const def = buildToolDefinition(manifest, t);
          registerModuleTool(def);
          toolsRegistered += 1;
        } catch (err) {
          const { code, reason } = importErrorMessage(err);
          result.rejected.push({ folder, code, reason });
          rejected = true;
          break;
        }
      }
      if (rejected) continue;

      // Module fully accepted — publish a runtime-index snapshot so the
      // dev-tools surface (debug_inspect_module / /debug modules) can answer
      // without rescanning disk.
      registerLoadedModule(summaryFromManifest(manifest));
      result.loaded.push({ id: manifest.id, toolCount: toolsRegistered });
      continue;
    }

    // runtime "mcp"
    let host: McpServerHost;
    try {
      host = new McpServerHost(manifest, {
        defaultCallTimeoutMs: options.mcpCallTimeoutMs,
        cwd: folderPath,
      });
      const discovered = await host.start();
      const bridged = registerMcpTools(manifest, discovered, host);
      await registerMcpHost(manifest.id, host);

      for (const toolName of bridged.undeclaredByManifest) {
        result.rejected.push({
          folder,
          code: "WARN_MCP_TOOL_UNDECLARED",
          reason: `mcp server "${manifest.id}" reported undeclared tool "${toolName}" (ignored by Core)`,
        });
      }
      for (const toolName of bridged.declaredButMissingFromServer) {
        result.rejected.push({
          folder,
          code: "WARN_MCP_TOOL_MISSING",
          reason: `manifest "${manifest.id}" declared "${toolName}" but server did not expose it`,
        });
      }

      registerLoadedModule(summaryFromManifest(manifest));
      result.loaded.push({ id: manifest.id, toolCount: bridged.registered });
    } catch (err) {
      const { code, reason } = importErrorMessage(err);
      result.rejected.push({ folder, code, reason });
      continue;
    }
  }

  return result;
}

export { stopAllMcpHosts };
