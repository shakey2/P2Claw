/**
 * P2 Claw — MCP stdio client wrapper.
 *
 * Wraps the official MCP TypeScript SDK with small, Core-friendly helpers for:
 *   - bounded connect/list/call operations
 *   - typed error classification for loader/host decisions
 *   - stable string output for the existing tool registry contract
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { Stream } from "node:stream";

type McpClientErrorCode =
  | "CONNECT_FAILED"
  | "STARTUP_TIMEOUT"
  | "PROTOCOL_MISMATCH"
  | "LIST_TOOLS_FAILED"
  | "CALL_FAILED"
  | "CALL_TIMEOUT";

export class McpClientError extends Error {
  public readonly code: McpClientErrorCode;
  constructor(code: McpClientErrorCode, message: string) {
    super(message);
    this.name = "McpClientError";
    this.code = code;
  }
}

export interface McpListedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolCallResult {
  output: string;
  isError: boolean;
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function looksLikeProtocolMismatch(err: unknown): boolean {
  const msg = toErrorMessage(err).toLowerCase();
  return msg.includes("protocol version") || msg.includes("incompatible protocol");
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutCode: McpClientErrorCode,
  timeoutMessage: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new McpClientError(timeoutCode, timeoutMessage));
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type RawCallToolResult = Awaited<ReturnType<Client["callTool"]>>;

function stringifyToolResult(result: RawCallToolResult): string {
  if ("toolResult" in result) {
    return JSON.stringify({
      toolResult: result.toolResult,
    });
  }
  if (result.structuredContent) {
    return JSON.stringify({
      structuredContent: result.structuredContent,
      content: result.content ?? [],
      isError: result.isError === true,
    });
  }

  const textBlocks = result.content
    .filter(
      (item): item is Extract<(typeof result.content)[number], { type: "text" }> =>
        item.type === "text"
    )
    .map((item) => item.text);
  if (textBlocks.length > 0) {
    return textBlocks.join("\n");
  }

  return JSON.stringify({
    content: result.content ?? [],
    isError: result.isError === true,
  });
}

export class McpStdioClient {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;

  constructor(server: StdioServerParameters) {
    this.client = new Client(
      {
        name: "p2claw-core-mcp-bridge",
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );
    this.transport = new StdioClientTransport(server);
  }

  get pid(): number | null {
    return this.transport.pid;
  }

  get stderrStream(): Stream | null {
    return this.transport.stderr;
  }

  onClose(handler: () => void): void {
    this.transport.onclose = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.transport.onerror = handler;
  }

  async connect(startupTimeoutMs: number): Promise<void> {
    try {
      await withTimeout(
        this.client.connect(this.transport),
        startupTimeoutMs,
        "STARTUP_TIMEOUT",
        `MCP startup timed out after ${startupTimeoutMs}ms`
      );
    } catch (err) {
      if (err instanceof McpClientError) throw err;
      if (looksLikeProtocolMismatch(err)) {
        throw new McpClientError("PROTOCOL_MISMATCH", toErrorMessage(err));
      }
      throw new McpClientError("CONNECT_FAILED", toErrorMessage(err));
    }
  }

  async listTools(): Promise<readonly McpListedTool[]> {
    let result: ListToolsResult;
    try {
      result = await this.client.listTools();
    } catch (err) {
      throw new McpClientError("LIST_TOOLS_FAILED", toErrorMessage(err));
    }

    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<
        string,
        unknown
      >,
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number
  ): Promise<McpToolCallResult> {
    let result: RawCallToolResult;
    try {
      result = await withTimeout(
        this.client.callTool({
          name,
          arguments: args,
        }),
        timeoutMs,
        "CALL_TIMEOUT",
        `MCP tool "${name}" timed out after ${timeoutMs}ms`
      );
    } catch (err) {
      if (err instanceof McpClientError) throw err;
      throw new McpClientError("CALL_FAILED", toErrorMessage(err));
    }

    return {
      output: stringifyToolResult(result),
      isError: "isError" in result && result.isError === true,
    };
  }

  async close(): Promise<void> {
    try {
      await this.transport.close();
    } catch {
      // best effort during shutdown
    }
  }
}

