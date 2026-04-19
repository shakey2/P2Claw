/**
 * P2 Claw — MCP server host/runtime.
 *
 * Core-owned process lifecycle for MCP stdio servers:
 *   - launch and initialize
 *   - capture stderr for diagnostics
 *   - supervise unexpected disconnects with bounded restart
 *   - expose a callTool() method used by the registry bridge
 */

import { log } from "../logger.js";
import type { ModuleManifest } from "../modules/manifest.js";
import { hashArgs, summariseArgs, writeMcpEvent, writeMcpLifecycle } from "../modules/audit.js";
import { McpClientError, McpStdioClient, type McpListedTool } from "./client.js";
import type { McpOutcome, McpServerStatus } from "./types.js";

const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_MCP_CALL_TIMEOUT_MS = 30_000;
const MAX_MCP_RESTART_ATTEMPTS = 5;
const MAX_STDERR_CHUNK_BYTES = 2 * 1024;
const MAX_RESTART_BACKOFF_MS = 30_000;

export interface McpServerHostOptions {
  defaultCallTimeoutMs?: number;
  maxRestartAttempts?: number;
  cwd?: string;
}

function clampPositiveInt(raw: number | undefined, fallback: number): number {
  if (!Number.isFinite(raw)) return fallback;
  const value = Math.floor(raw as number);
  if (value < 1) return fallback;
  return value;
}

function normalizeCommandForPlatform(
  command: string,
  args: readonly string[]
): { command: string; args: string[] } {
  if (process.platform !== "win32") {
    return { command, args: [...args] };
  }

  // Explicitly wrap .cmd/.bat for consistent behavior under shell:false.
  if (!/\.(?:cmd|bat)$/i.test(command)) {
    return { command, args: [...args] };
  }

  return {
    command: process.env.ComSpec?.trim() || "cmd.exe",
    args: ["/d", "/s", "/c", command, ...args],
  };
}

function classifyCallFailure(err: unknown): { outcome: McpOutcome; message: string } {
  if (err instanceof McpClientError) {
    if (err.code === "CALL_TIMEOUT") {
      return { outcome: "timeout", message: err.message };
    }
    if (err.code === "PROTOCOL_MISMATCH") {
      return { outcome: "protocol_mismatch", message: err.message };
    }
    if (err.code === "CONNECT_FAILED" || err.code === "STARTUP_TIMEOUT") {
      return { outcome: "disconnected", message: err.message };
    }
    if (err.code === "CALL_FAILED") {
      return { outcome: "disconnected", message: err.message };
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return { outcome: "tool_error", message };
}

export class McpServerHost {
  private readonly manifest: ModuleManifest;
  private readonly defaultCallTimeoutMs: number;
  private readonly maxRestartAttempts: number;
  private readonly cwd: string;

  private client: McpStdioClient | null = null;
  private statusValue: McpServerStatus = "stopped";
  private stopRequested = false;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private tools: readonly McpListedTool[] = [];

  constructor(manifest: ModuleManifest, options: McpServerHostOptions = {}) {
    if (manifest.runtime !== "mcp" || !manifest.mcp) {
      throw new Error(
        `McpServerHost requires runtime "mcp" with manifest.mcp (got runtime=${manifest.runtime})`
      );
    }
    this.manifest = manifest;
    this.defaultCallTimeoutMs = clampPositiveInt(
      options.defaultCallTimeoutMs,
      DEFAULT_MCP_CALL_TIMEOUT_MS
    );
    this.maxRestartAttempts = clampPositiveInt(
      options.maxRestartAttempts,
      MAX_MCP_RESTART_ATTEMPTS
    );
    this.cwd = options.cwd && options.cwd.trim().length > 0 ? options.cwd : process.cwd();
  }

  get serverId(): string {
    return this.manifest.id;
  }

  get status(): McpServerStatus {
    return this.statusValue;
  }

  get discoveredTools(): readonly McpListedTool[] {
    return this.tools;
  }

  private buildClient(): McpStdioClient {
    const mcp = this.manifest.mcp!;
    const normalized = normalizeCommandForPlatform(mcp.command, mcp.args);
    return new McpStdioClient({
      command: normalized.command,
      args: normalized.args,
      env: mcp.env ? { ...mcp.env } : undefined,
      cwd: this.cwd,
      stderr: "pipe",
    });
  }

  private attachDiagnostics(client: McpStdioClient): void {
    client.onError((error) => {
      log.warn(`[mcp:${this.serverId}] transport error: ${error.message}`);
    });

    const stderr = client.stderrStream;
    if (!stderr) return;
    stderr.on("data", (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const bounded =
        Buffer.byteLength(text, "utf8") > MAX_STDERR_CHUNK_BYTES
          ? Buffer.from(text, "utf8").subarray(0, MAX_STDERR_CHUNK_BYTES).toString("utf8")
          : text;
      const trimmed = bounded.trim();
      if (trimmed.length > 0) {
        log.info(`[mcp:${this.serverId}] ${trimmed}`);
      }
    });
  }

  private async handleUnexpectedClose(): Promise<void> {
    if (this.stopRequested) {
      return;
    }
    this.statusValue = "crashed";
    writeMcpLifecycle({
      kind: "mcp_lifecycle",
      serverId: this.serverId,
      event: "crashed",
      reason: "transport_closed",
    });

    const restartOnCrash = this.manifest.mcp?.restartOnCrash ?? true;
    if (!restartOnCrash) return;
    if (this.restartAttempts >= this.maxRestartAttempts) {
      log.warn(
        `[mcp:${this.serverId}] max restart attempts reached (${this.maxRestartAttempts}); leaving server offline`
      );
      return;
    }

    this.restartAttempts += 1;
    const backoff = Math.min(
      1000 * 2 ** Math.max(0, this.restartAttempts - 1),
      MAX_RESTART_BACKOFF_MS
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.restartAfterCrash();
    }, backoff);
    this.restartTimer.unref();
  }

  private async restartAfterCrash(): Promise<void> {
    if (this.stopRequested) return;
    writeMcpLifecycle({
      kind: "mcp_lifecycle",
      serverId: this.serverId,
      event: "restart",
      reason: `attempt ${this.restartAttempts}`,
    });
    try {
      await this.connectAndDiscoverTools(false);
      this.restartAttempts = 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[mcp:${this.serverId}] restart failed: ${message}`);
      await this.handleUnexpectedClose();
    }
  }

  private async connectAndDiscoverTools(initialStart: boolean): Promise<readonly McpListedTool[]> {
    this.statusValue = "starting";

    const client = this.buildClient();
    this.attachDiagnostics(client);
    client.onClose(() => {
      this.client = null;
      void this.handleUnexpectedClose();
    });

    const startupTimeoutMs = clampPositiveInt(
      this.manifest.mcp?.startupTimeoutMs,
      DEFAULT_MCP_STARTUP_TIMEOUT_MS
    );
    try {
      await client.connect(startupTimeoutMs);
    } catch (err) {
      this.client = null;
      this.statusValue = "crashed";
      const classified = classifyCallFailure(err);
      writeMcpLifecycle({
        kind: "mcp_lifecycle",
        serverId: this.serverId,
        event: "crashed",
        reason: classified.message,
      });
      throw err;
    }

    let listed: readonly McpListedTool[];
    try {
      listed = await client.listTools();
    } catch (err) {
      await client.close();
      this.client = null;
      this.statusValue = "crashed";
      const message = err instanceof Error ? err.message : String(err);
      writeMcpLifecycle({
        kind: "mcp_lifecycle",
        serverId: this.serverId,
        event: "crashed",
        reason: `tools/list failed: ${message}`,
      });
      throw err;
    }

    this.client = client;
    this.tools = listed;
    this.statusValue = "ready";

    writeMcpLifecycle({
      kind: "mcp_lifecycle",
      serverId: this.serverId,
      event: "started",
      reason: initialStart ? "boot" : "restart",
    });
    writeMcpLifecycle({
      kind: "mcp_lifecycle",
      serverId: this.serverId,
      event: "tools_registered",
      toolCount: listed.length,
    });

    return listed;
  }

  async start(): Promise<readonly McpListedTool[]> {
    this.stopRequested = false;
    this.restartAttempts = 0;
    return this.connectAndDiscoverTools(true);
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<string> {
    const startedAt = Date.now();
    const payloadHash = hashArgs(args);
    if (!this.client || this.statusValue !== "ready") {
      const message = `MCP server "${this.serverId}" is not connected`;
      writeMcpEvent({
        kind: "mcp_event",
        serverId: this.serverId,
        toolName,
        outcome: "disconnected",
        argsHash: payloadHash,
        resultSummary: message,
        durationMs: Date.now() - startedAt,
      });
      throw new Error(message);
    }

    const resolvedTimeout = clampPositiveInt(timeoutMs, this.defaultCallTimeoutMs);
    try {
      const result = await this.client.callTool(toolName, args, resolvedTimeout);
      writeMcpEvent({
        kind: "mcp_event",
        serverId: this.serverId,
        toolName,
        outcome: result.isError ? "tool_error" : "success",
        argsHash: payloadHash,
        resultSummary: summariseArgs({ output: result.output }),
        durationMs: Date.now() - startedAt,
      });
      return result.output;
    } catch (err) {
      const classified = classifyCallFailure(err);
      writeMcpEvent({
        kind: "mcp_event",
        serverId: this.serverId,
        toolName,
        outcome: classified.outcome,
        argsHash: payloadHash,
        resultSummary: summariseArgs({ error: classified.message }),
        durationMs: Date.now() - startedAt,
      });
      throw new Error(`MCP tool "${toolName}" failed: ${classified.message}`);
    }
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.statusValue = "stopped";
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.client) {
      const closing = this.client;
      this.client = null;
      await closing.close();
    }
    writeMcpLifecycle({
      kind: "mcp_lifecycle",
      serverId: this.serverId,
      event: "stopped",
      reason: "shutdown",
    });
  }
}

