/**
 * P2 Claw — Runtime module index.
 *
 * Small explicit in-memory index of modules the loader has actually accepted.
 * The loader populates it after a module passes manifest validation, tool
 * contribution, and tool registration; readers (the dev-tools module and the
 * `/debug` handler) then introspect loaded modules without rescanning disk.
 *
 * Part H additions: settings schemas, tab registrations, and a navigation
 * helper for the HTML frontend.
 *
 * This intentionally does NOT mirror every manifest field. The shape is the
 * subset the debug surface needs — id, version, declared permissions, and
 * per-tool requires — with primitive values only so the snapshot is cheap to
 * serialise.
 */

import type { ModuleManifest, ModuleRuntime, ManifestTab } from "./manifest.js";
import type { SettingFieldDescriptor, ModuleTab, TabContentDescriptor } from "./types.js";

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
  /** Part H: settings field descriptors from the validated manifest. */
  settings: readonly SettingFieldDescriptor[];
  /** Part H: tab declarations from the validated manifest. */
  manifestTabs: readonly ManifestTab[];
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
    settings: [...manifest.settings],
    manifestTabs: [...manifest.tabs],
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

// ── Part H: Tab registry ────────────────────────────────────────

/** Registered tab with its live renderContent callback. */
export interface RegisteredTab {
  moduleId: string;
  moduleName: string;
  id: string;
  title: string;
  order: number;
  renderContent: () => Promise<TabContentDescriptor>;
}

const registeredTabs = new Map<string, RegisteredTab>();

/** Composite key for the tab map. */
function tabKey(moduleId: string, tabId: string): string {
  return `${moduleId}:${tabId}`;
}

/** Register a module tab (called from the loader after validation). */
export function registerModuleTab(
  moduleId: string,
  moduleName: string,
  tab: ModuleTab
): void {
  registeredTabs.set(tabKey(moduleId, tab.id), {
    moduleId,
    moduleName,
    id: tab.id,
    title: tab.title,
    order: tab.order,
    renderContent: tab.renderContent,
  });
}

/** Look up a specific registered tab. */
export function getRegisteredTab(
  moduleId: string,
  tabId: string
): RegisteredTab | undefined {
  return registeredTabs.get(tabKey(moduleId, tabId));
}

/** All registered tabs for a module. */
export function getModuleTabs(moduleId: string): readonly RegisteredTab[] {
  const result: RegisteredTab[] = [];
  for (const tab of registeredTabs.values()) {
    if (tab.moduleId === moduleId) result.push(tab);
  }
  return result.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * Navigation-ready sorted tab list for the HTML UI header. Returns all
 * registered tabs sorted by order then moduleId alphabetically.
 */
export interface NavTab {
  moduleId: string;
  moduleName: string;
  tabId: string;
  title: string;
  order: number;
  href: string;
}

export function getNavTabs(): readonly NavTab[] {
  const tabs: NavTab[] = [];
  for (const t of registeredTabs.values()) {
    tabs.push({
      moduleId: t.moduleId,
      moduleName: t.moduleName,
      tabId: t.id,
      title: t.title,
      order: t.order,
      href: `/modules/${encodeURIComponent(t.moduleId)}/${encodeURIComponent(t.id)}`,
    });
  }
  return tabs.sort(
    (a, b) => a.order - b.order || a.moduleId.localeCompare(b.moduleId)
  );
}

/**
 * Returns module ids that have settings schemas (for the settings nav).
 */
export function getModulesWithSettings(): ReadonlyArray<{ id: string; name: string }> {
  const result: Array<{ id: string; name: string }> = [];
  for (const mod of loaded.values()) {
    if (mod.settings.length > 0) {
      result.push({ id: mod.id, name: mod.name });
    }
  }
  return result;
}

/**
 * Clears the index. Only intended for the verify harness; production code
 * never calls this (the loader runs once at boot).
 */
export function resetRuntimeIndex(): void {
  loaded.clear();
  registeredTabs.clear();
}

