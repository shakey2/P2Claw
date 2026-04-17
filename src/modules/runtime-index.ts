/**
 * P2 Claw — Runtime module index.
 *
 * Small explicit in-memory index of modules the loader has actually accepted.
 * The loader populates it after a module passes manifest validation, tool
 * contribution, and tool registration; readers (the dev-tools module and the
 * `/debug` handler) then introspect loaded modules without rescanning disk.
 *
 * This intentionally does NOT mirror every manifest field. The shape is the
 * subset the debug surface needs — id, version, declared permissions, and
 * per-tool requires — with primitive values only so the snapshot is cheap to
 * serialise.
 */

import type { ModuleManifest, ModuleRuntime } from "./manifest.js";

export interface LoadedModuleToolSummary {
  name: string;
  description: string;
  requires: readonly string[];
}

export interface LoadedModuleSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  runtime: ModuleRuntime;
  firstParty: boolean;
  permissions: readonly string[];
  tools: readonly LoadedModuleToolSummary[];
}

/**
 * Builds a snapshot from a validated manifest. Exported so the loader and
 * any future callers share exactly one shape.
 */
export function summaryFromManifest(
  manifest: ModuleManifest
): LoadedModuleSummary {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    runtime: manifest.runtime,
    firstParty: manifest.firstParty,
    permissions: [...manifest.permissions],
    tools: manifest.tools.map((t) => ({
      name: t.name,
      description: t.description,
      requires: [...t.requires],
    })),
  };
}

const loaded = new Map<string, LoadedModuleSummary>();

/**
 * Records a loaded module. Idempotent — a second call with the same id
 * overwrites the previous entry (normal in verify / test harnesses that
 * rerun the loader in-process).
 */
export function registerLoadedModule(summary: LoadedModuleSummary): void {
  loaded.set(summary.id, summary);
}

export function getLoadedModule(id: string): LoadedModuleSummary | undefined {
  return loaded.get(id);
}

export function listLoadedModules(): ReadonlyArray<LoadedModuleSummary> {
  return Array.from(loaded.values());
}

/**
 * Clears the index. Only intended for the verify harness; production code
 * never calls this (the loader runs once at boot).
 */
export function resetRuntimeIndex(): void {
  loaded.clear();
}
