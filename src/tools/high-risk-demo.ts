/**
 * P2 Claw — high_risk_demo tool (Level 4 scaffold).
 *
 * Declares risk: "high" so execution is gated by TOTP + APPROVE challenge.
 * Does not run shell or touch the filesystem — proves the approval pipeline only.
 */

import type { ToolDefinition } from "./tool-types.js";

const highRiskDemo: ToolDefinition = {
  risk: "high",
  schema: {
    type: "function" as const,
    function: {
      name: "high_risk_demo",
      description:
        "Demo high-risk tool: runs only after the user sends their 6-digit authenticator code in Telegram (while a challenge is open). Use when testing Level 4 approvals — does not execute system commands.",
      parameters: {
        type: "object",
        properties: {
          intention: {
            type: "string",
            description:
              "Short description of what a future high-risk tool would do (for audit / binding only).",
          },
        },
        required: ["intention"],
      },
    },
  },

  handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
    const intention = String(rawArgs.intention ?? "");
    return JSON.stringify({
      ok: true,
      message:
        "High-risk demo completed after TOTP approval. No system commands were run.",
      intention,
    });
  },
};

export default highRiskDemo;
