/**
 * P2 Claw — High-risk tool approval (TOTP-gated challenges).
 *
 * In-memory only (Phase 1). Challenges bind to chatId + payload hash so
 * approval cannot be swapped to a different tool invocation.
 */

import { createHash, randomBytes } from "crypto";
import { verifyTotp } from "./totp.js";

/** Time to complete APPROVE after the prompt is sent. */
export const APPROVAL_TTL_MS = 120_000;

export type ChallengeStatus = "pending" | "approved" | "rejected";

export interface Challenge {
  chatId: number;
  toolName: string;
  payloadHash: string;
  summary: string;
  expiresAt: number;
  status: ChallengeStatus;
}

const challenges = new Map<string, Challenge>();

type Waiter = {
  resolve: (value: boolean) => void;
};

const waiters = new Map<string, Waiter>();

/** True if this chat has a non-expired pending high-risk challenge. */
export function hasPendingApprovalForChat(chatId: number): boolean {
  const now = Date.now();
  for (const ch of challenges.values()) {
    if (ch.chatId === chatId && ch.status === "pending" && now <= ch.expiresAt) {
      return true;
    }
  }
  return false;
}

/**
 * Invalidate other pending challenges for this chat (e.g. new high-risk tool run).
 * Resolves their waiters with false so the agent does not stay stuck.
 */
function expirePendingChallengesForChat(chatId: number): void {
  for (const [id, ch] of [...challenges.entries()]) {
    if (ch.chatId !== chatId || ch.status !== "pending") continue;
    const w = waiters.get(id);
    if (w) {
      w.resolve(false);
    } else {
      challenges.delete(id);
      waiters.delete(id);
    }
  }
}

function canonicalArgsJson(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  const obj: Record<string, unknown> = {};
  for (const k of keys) {
    obj[k] = args[k];
  }
  return JSON.stringify(obj);
}

export function hashPayload(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalArgsJson(args), "utf8").digest("hex");
}

function makeChallengeId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Registers a pending challenge. Caller must await waitForApproval + send UI prompt.
 */
export function createChallenge(
  chatId: number,
  toolName: string,
  args: Record<string, unknown>
): { challengeId: string; summary: string; payloadHash: string } {
  expirePendingChallengesForChat(chatId);

  let challengeId = makeChallengeId();
  while (challenges.has(challengeId)) {
    challengeId = makeChallengeId();
  }

  const payloadHash = hashPayload(args);
  const canon = canonicalArgsJson(args);
  const summary =
    canon.length > 280 ? `${canon.slice(0, 280)}…` : canon;

  challenges.set(challengeId, {
    chatId,
    toolName,
    payloadHash,
    summary,
    expiresAt: Date.now() + APPROVAL_TTL_MS,
    status: "pending",
  });

  return { challengeId, summary, payloadHash };
}

/**
 * Wait for TOTP approval or timeout. Register before sending the Telegram prompt.
 */
export function waitForApproval(challengeId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(challengeId);
      const ch = challenges.get(challengeId);
      if (ch?.status === "pending") {
        challenges.delete(challengeId);
      }
      resolve(false);
    }, APPROVAL_TTL_MS);

    waiters.set(challengeId, {
      resolve: (v: boolean) => {
        clearTimeout(timer);
        waiters.delete(challengeId);
        challenges.delete(challengeId);
        resolve(v);
      },
    });
  });
}

/**
 * Telegram / CLI: validate TOTP and complete the challenge waiter.
 * Does not log the TOTP code.
 */
export function tryApproveWithTotp(
  chatId: number,
  challengeId: string,
  totpCode: string,
  secretBase32: string
): { ok: boolean; message: string } {
  const id = challengeId.trim().toLowerCase();
  const ch = challenges.get(id);
  if (!ch) {
    return { ok: false, message: "Unknown or expired challenge." };
  }
  if (ch.chatId !== chatId) {
    return { ok: false, message: "This approval does not belong to this chat." };
  }
  if (Date.now() > ch.expiresAt) {
    challenges.delete(id);
    waiters.delete(id);
    return { ok: false, message: "Challenge expired." };
  }
  if (ch.status !== "pending") {
    return { ok: false, message: "Challenge already completed." };
  }

  if (!verifyTotp(secretBase32, totpCode)) {
    return { ok: false, message: "Invalid authenticator code." };
  }

  ch.status = "approved";
  const w = waiters.get(id);
  if (w) {
    w.resolve(true);
  } else {
    challenges.delete(id);
  }

  return { ok: true, message: "Approved." };
}

/**
 * Approve the pending challenge for this chat using only the TOTP code
 * (one pending challenge per chat at a time).
 */
export function tryApprovePendingForChat(
  chatId: number,
  totpCode: string,
  secretBase32: string
): { ok: boolean; message: string } {
  const now = Date.now();
  let foundId: string | undefined;
  for (const [id, ch] of challenges) {
    if (ch.chatId === chatId && ch.status === "pending" && now <= ch.expiresAt) {
      foundId = id;
      break;
    }
  }
  if (!foundId) {
    return { ok: false, message: "No pending approval for this chat." };
  }
  return tryApproveWithTotp(chatId, foundId, totpCode, secretBase32);
}
