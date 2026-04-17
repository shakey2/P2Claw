/**
 * P2 Claw — Tool definition types (shared; avoids circular imports with registry).
 */

import type OpenAI from "openai";

export type ToolRisk = "safe" | "high";

export interface ToolDefinition {
  schema: OpenAI.Chat.Completions.ChatCompletionTool;
  handler: (args: Record<string, unknown>, chatId?: number) => Promise<string>;
  risk?: ToolRisk;
  /**
   * If this tool was contributed by a module, the module's id. Built-in tools
   * leave this `undefined`.
   */
  ownerModuleId?: string;
  /**
   * Permissions this tool's handler will consume via the broker. The registry
   * uses this list to derive the effective risk (any high-risk permission
   * promotes the tool to `risk: "high"`) and to pre-approve the grant set for
   * the duration of the handler call.
   */
  requiredPermissions?: readonly string[];
}

export type ExecuteToolOptions = {
  /** Session / UI channel id (e.g. Telegram chat.id, CLI session). Used for TOTP challenge binding. */
  chatId?: number;
  /** Stable id for SQLite memory rows; shared across all frontends. */
  memoryScopeId?: number;
  sendPendingApproval?: (text: string) => Promise<void>;
  totpSecretBase32?: string;
};
