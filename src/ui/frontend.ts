/**
 * P2 Claw — Frontend interface.
 *
 * Frontends are thin adapters (Telegram, CLI, future local HTML GUI) that
 * translate user input into calls to the shared agent core.
 */

export type ApprovalHooks = {
  /** Show a high-risk approval prompt to the user (plain text). */
  sendPendingApproval: (text: string) => Promise<void>;
};

export type AgentHooks = Partial<ApprovalHooks>;

export interface Frontend {
  /** Start receiving input and producing output. */
  start(): Promise<void>;
  /** Stop the frontend and release any resources. */
  stop(): Promise<void>;
}

