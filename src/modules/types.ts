/**
 * P2 Claw — Shared module framework types.
 */

import type OpenAI from "openai";
import type { PermissionId } from "./permissions.js";

/** Result of running a shell / process invocation. */
export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number;
  signal?: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/**
 * The typed capability object handed to a module at load time.
 *
 * Modules receive EXACTLY this object and nothing else. They do not import
 * `child_process`, `fs`, `net`, etc. directly. If they try to, those calls
 * will simply not go through the broker and — since only in-process
 * first-party modules are allowed in Phase 1 — such imports are caught in
 * code review.
 *
 * Every method below is routed through the broker which (1) verifies the
 * caller's manifest declares the corresponding permission, (2) runs the TOTP
 * gate if the permission is high-risk, (3) writes an audit entry, and
 * (4) only then performs the primitive.
 */
export interface ModuleContext {
  moduleId: string;
  log: {
    info(msg: string): Promise<void>;
  };
  time: {
    now(): Promise<Date>;
  };
  memory: {
    read(key: string): Promise<string | null>;
    write(key: string, value: string): Promise<void>;
  };
  settings: {
    /**
     * Read a module setting value. Returns the stored value or the manifest
     * default if no value has been written. Returns `null` if the key is not
     * declared in the module's settings schema.
     */
    read(key: string): Promise<string | number | boolean | null>;
    /**
     * Write a module setting value. Core validates the value against the
     * declared schema and stores it in the module_settings table.
     */
    write(key: string, value: string | number | boolean): Promise<void>;
  };
  fs: {
    readPublic(rel: string): Promise<string>;
    readPrivate(abs: string): Promise<string>;
    writeAny(abs: string, data: string): Promise<void>;
  };
  shell: {
    execute(cmd: string, args: string[]): Promise<ProcessResult>;
  };
  process: {
    spawn(cmd: string, args: string[]): Promise<ProcessResult>;
  };
  net: {
    fetch(
      url: string,
      init?: { method?: string; body?: string; headers?: Record<string, string> }
    ): Promise<{ status: number; body: string }>;
  };
  credentials: {
    read(kind: "player2" | "telegram" | "totp"): Promise<string>;
  };
}

/**
 * Tool contributed by a module. Passed to the registry at load time.
 * The registry wraps `handler` so the LLM-facing execution path always
 * funnels through the TOTP gate for any high-risk permission in `requires`.
 */
export interface ModuleTool {
  schema: OpenAI.Chat.Completions.ChatCompletionTool;
  handler: (args: Record<string, unknown>, chatId?: number) => Promise<string>;
  requires: readonly PermissionId[];
}

// ── Part H: Module Settings types ───────────────────────────────

/** Allowed primitive types for a settings field. */
export type SettingFieldType = "string" | "number" | "boolean" | "select";

/**
 * A single field in a module's settings schema. Declared in manifest.json
 * and validated by Core at boot time. Core renders the settings form and
 * validates submitted values against this descriptor.
 */
export interface SettingFieldDescriptor {
  /** Unique key within the module's settings namespace. */
  key: string;
  type: SettingFieldType;
  label: string;
  description: string;
  required: boolean;
  /** If true, display value is masked and writes require TOTP. */
  sensitive: boolean;
  default: string | number | boolean;
  /** type: "number" only — minimum allowed value. */
  min?: number;
  /** type: "number" only — maximum allowed value. */
  max?: number;
  /** type: "string" only — regex pattern the value must match. */
  pattern?: string;
  /** type: "string" only — maximum character length. */
  maxLength?: number;
  /** type: "select" only — fixed list of allowed values. */
  options?: readonly string[];
}

// ── Part H: Module Tab types ────────────────────────────────────

/**
 * Content block types a module tab can return. Core renders all of these
 * using its own HTML templates — no module-supplied HTML/JS/CSS.
 */
export type TabContentBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "kv-table"; rows: ReadonlyArray<{ key: string; value: string }> }
  | { kind: "status"; label: string; value: "ok" | "warning" | "error"; detail?: string }
  | { kind: "settings-form"; moduleId: string }
  | { kind: "pre"; text: string };

/** Structured content descriptor returned by a module tab's renderContent(). */
export interface TabContentDescriptor {
  title: string;
  blocks: readonly TabContentBlock[];
}

/**
 * A tab contributed by a module at registration time. Core adds this
 * to the HTML navigation and calls `renderContent()` on each request.
 */
export interface ModuleTab {
  /** Unique tab id within this module (must match a manifest `tabs` entry). */
  id: string;
  title: string;
  /** Sort order for navigation. Core pages use 0–99; modules start at 100+. */
  order: number;
  /**
   * Called by Core when the tab route is requested. Must return structured
   * data (not HTML). Core renders it using its own templates.
   */
  renderContent: () => Promise<TabContentDescriptor>;
}

/**
 * The shape every first-party module default-exports.
 * Called once at boot via the loader.
 */
export interface Module {
  register(args: {
    ctx: ModuleContext;
    contributeTool: (tool: ModuleTool) => void;
    /** Part H: declare settings fields (must match manifest `settings` block). */
    contributeSettings: (fields: SettingFieldDescriptor[]) => void;
    /** Part H: register a tab in the HTML UI (must match manifest `tabs` entry). */
    contributeTab: (tab: ModuleTab) => void;
  }): void | Promise<void>;
}

/**
 * Error thrown when a module attempts a broker call it did not declare in its
 * manifest, or when approval is denied / times out.
 */
export class PermissionDeniedError extends Error {
  public readonly code: "NOT_DECLARED" | "DENIED" | "TIMEOUT" | "NO_TOTP" | "NO_CHANNEL";
  constructor(
    code: "NOT_DECLARED" | "DENIED" | "TIMEOUT" | "NO_TOTP" | "NO_CHANNEL",
    message: string
  ) {
    super(message);
    this.name = "PermissionDeniedError";
    this.code = code;
  }
}
