/**
 * P2 Claw — Shared module framework types.
 */

import type OpenAI from "openai";
import type { PermissionId } from "./permissions.js";

/** Result of running a stubbed shell / process invocation. */
export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number;
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

/**
 * The shape every first-party module default-exports.
 * Called once at boot via the loader.
 */
export interface Module {
  register(args: {
    ctx: ModuleContext;
    contributeTool: (tool: ModuleTool) => void;
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
