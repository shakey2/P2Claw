/**
 * P2 Claw — MCP-to-registry bridge.
 *
 * Converts MCP server-discovered tools into ToolDefinition entries registered
 * in Core's existing tool registry.
 */

import type OpenAI from "openai";
import type { ModuleManifest } from "../core/modules/manifest.js";
import { registerModuleTool } from "../tools/registry.js";
import type { McpListedTool } from "./client.js";
import type { McpServerHost } from "./host.js";

export interface RegisterMcpToolsResult {
  registered: number;
  undeclaredByManifest: string[];
  declaredButMissingFromServer: string[];
}

function toOpenAiToolSchema(tool: McpListedTool): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? `MCP tool "${tool.name}"`,
      parameters: tool.inputSchema,
    },
  };
}

export function registerMcpTools(
  manifest: ModuleManifest,
  discoveredTools: readonly McpListedTool[],
  host: McpServerHost
): RegisterMcpToolsResult {
  const discoveredByName = new Map(discoveredTools.map((tool) => [tool.name, tool]));
  const declaredByName = new Map(manifest.tools.map((tool) => [tool.name, tool]));

  const undeclaredByManifest: string[] = [];
  for (const tool of discoveredTools) {
    if (!declaredByName.has(tool.name)) {
      undeclaredByManifest.push(tool.name);
    }
  }

  const declaredButMissingFromServer: string[] = [];
  let registered = 0;

  for (const declaredTool of manifest.tools) {
    const discovered = discoveredByName.get(declaredTool.name);
    if (!discovered) {
      declaredButMissingFromServer.push(declaredTool.name);
      continue;
    }

    registerModuleTool({
      schema: toOpenAiToolSchema(discovered),
      handler: async (args) => host.callTool(declaredTool.name, args),
      ownerModuleId: manifest.id,
      requiredPermissions: declaredTool.requires,
    });
    registered += 1;
  }

  return {
    registered,
    undeclaredByManifest,
    declaredButMissingFromServer,
  };
}

