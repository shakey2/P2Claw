/**
 * P2 Claw — Agent core wrapper for multiple frontends.
 *
 * This keeps the agent/tool loop single-sourced while allowing frontends
 * (Telegram, CLI, future HTML GUI) to supply UI hooks such as approval prompts.
 */

import type { Config } from "../config.js";
import { processMessage, type ProcessMessageOptions } from "../agent.js";
import type { AgentHooks } from "./frontend.js";

export type AgentCore = {
  process: (sessionId: number, text: string, hooks?: AgentHooks) => Promise<string>;
};

export function createAgentCore(config: Config): AgentCore {
  return {
    process: async (sessionId: number, text: string, hooks?: AgentHooks) => {
      const opts: ProcessMessageOptions = {
        totpSecretBase32: config.totpSecretBase32,
        sendPendingApproval: hooks?.sendPendingApproval,
        memoryScopeId: config.memoryScopeId,
      };
      return processMessage(
        sessionId,
        text,
        config.botName,
        config.maxAgentIterations,
        opts
      );
    },
  };
}

