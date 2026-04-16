/**
 * P2 Claw — Tool definition types (shared; avoids circular imports with registry).
 */

import type OpenAI from "openai";

export type ToolRisk = "safe" | "high";

export interface ToolDefinition {
  schema: OpenAI.Chat.Completions.ChatCompletionTool;
  handler: (args: Record<string, unknown>, chatId?: number) => Promise<string>;
  risk?: ToolRisk;
}

export type ExecuteToolOptions = {
  /** Session / UI channel id (e.g. Telegram chat.id, CLI session). Used for TOTP challenge binding. */
  chatId?: number;
  /** Stable id for SQLite memory rows; shared across all frontends. */
  memoryScopeId?: number;
  sendPendingApproval?: (text: string) => Promise<void>;
  totpSecretBase32?: string;
};
