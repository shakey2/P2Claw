/**
 * P2 Claw — In-memory MCP host registry.
 *
 * Keeps track of started MCP server hosts so Core can stop them during
 * graceful shutdown and verify/test harnesses can reset cleanly.
 */

import type { McpServerHost } from "./host.js";

const hosts = new Map<string, McpServerHost>();

export async function registerMcpHost(
  serverId: string,
  host: McpServerHost
): Promise<void> {
  const existing = hosts.get(serverId);
  if (existing && existing !== host) {
    await existing.stop();
  }
  hosts.set(serverId, host);
}

export function getMcpHost(serverId: string): McpServerHost | undefined {
  return hosts.get(serverId);
}

export async function stopAllMcpHosts(): Promise<void> {
  const active = Array.from(hosts.values());
  hosts.clear();
  await Promise.all(
    active.map(async (host) => {
      await host.stop();
    })
  );
}

export async function resetMcpHostRegistry(): Promise<void> {
  await stopAllMcpHosts();
}

