/**
 * P2 Claw — MCP bridge/runtime shared types.
 */

import type { PermissionId } from "../core/modules/permissions.js";

export type McpServerStatus = "starting" | "ready" | "crashed" | "stopped";

export interface McpToolMapping {
  mcpServerId: string;
  toolName: string;
  permissions: readonly PermissionId[];
}

export type McpOutcome =
  | "success"
  | "tool_error"
  | "timeout"
  | "disconnected"
  | "protocol_mismatch"
  | "spawn_error";

export interface McpEventEntry {
  kind: "mcp_event";
  serverId: string;
  toolName: string;
  outcome: McpOutcome;
  argsHash: string;
  resultSummary: string;
  durationMs: number;
}

export interface McpLifecycleEntry {
  kind: "mcp_lifecycle";
  serverId: string;
  event: "started" | "crashed" | "restart" | "stopped" | "tools_registered";
  toolCount?: number;
  reason?: string;
}

