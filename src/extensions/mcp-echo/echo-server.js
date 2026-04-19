/**
 * P2 Claw verify fixture — minimal MCP stdio echo server.
 *
 * This file is launched by src/extensions/mcp-echo/manifest.json and is only
 * loaded by the verify harness (`loadModules(..., { mcpVerify: true })`).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "p2claw-mcp-echo-fixture",
  version: "0.1.0",
});

const echoInputSchema = {
  message: z.string().optional(),
  payload: z.record(z.any()).optional(),
  delayMs: z.number().int().min(0).max(10_000).optional(),
  crash: z.boolean().optional(),
};

async function buildEchoText(args) {
  if (args?.crash === true) {
    process.exit(91);
  }
  const delayMs = typeof args?.delayMs === "number" ? Math.max(0, args.delayMs) : 0;
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const message = typeof args?.message === "string" ? args.message : "";
  const payload =
    args && typeof args.payload === "object" && args.payload !== null ? args.payload : null;
  return JSON.stringify({
    ok: true,
    message,
    payload,
    ts: new Date().toISOString(),
  });
}

server.registerTool(
  "mcp_echo",
  {
    description: "Echoes structured input for MCP bridge verification.",
    inputSchema: echoInputSchema,
  },
  async (args) => ({
    content: [
      {
        type: "text",
        text: await buildEchoText(args),
      },
    ],
  })
);

server.registerTool(
  "mcp_echo_high_risk",
  {
    description: "High-risk fixture echo tool used to verify TOTP + MCP dispatch.",
    inputSchema: echoInputSchema,
  },
  async (args) => ({
    content: [
      {
        type: "text",
        text: await buildEchoText(args),
      },
    ],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);

