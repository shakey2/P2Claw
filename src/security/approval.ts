/**
 * P2 Claw — High-risk tool approval (TOTP-gated challenges).
 *
 * In-memory only (Phase 1). Challenges bind to chatId + payload hash so
 * approval cannot be swapped to a different tool invocation.
 */

import { createHash, randomBytes } from "crypto";
import { verifyTotp } from "./totp.js";
import {
  writeApprovalEvent,
  type ApprovalOutcome,
  type ApprovalAttemptOutcome,
} from "../modules/audit.js";

export type { ApprovalOutcome, ApprovalAttemptOutcome };

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

interface CreateChallengeOptions {
  summaryOverride?: string;
}

const challenges = new Map<string, Challenge>();

type Waiter = {
  resolve: (value: ApprovalOutcome) => void;
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
 * Non-sensitive snapshot of the pending challenge for a session (chatId).
 *
 * Deliberately omits `payloadHash` and the full `summary`; exposing the
 * canonical summary to an LLM surface would leak the bound args of a
 * still-pending high-risk call. `/debug perms` uses this to describe
 * the real ephemeral approval model instead of pretending there is durable
 * per-tool "approved/unapproved" state.
 */
export interface PendingChallengeSnapshot {
  challengeId: string;
  toolName: string;
  /** Length of the canonical summary in characters (never the summary itself). */
  summaryLength: number;
  expiresAt: number;
}

export function getPendingChallengeForChat(
  chatId: number
): PendingChallengeSnapshot | null {
  const now = Date.now();
  for (const [id, ch] of challenges) {
    if (ch.chatId === chatId && ch.status === "pending" && now <= ch.expiresAt) {
      return {
        challengeId: id,
        toolName: ch.toolName,
        summaryLength: ch.summary.length,
        expiresAt: ch.expiresAt,
      };
    }
  }
  return null;
}

/**
 * Invalidate other pending challenges for this chat (e.g. new high-risk tool run).
 * Resolves their waiters with "superseded" so the agent does not stay stuck.
 * The waiter's resolve wrapper writes the audit record; the no-waiter path writes
 * directly since there is nobody else to do it.
 */
function expirePendingChallengesForChat(chatId: number): void {
  for (const [id, ch] of [...challenges.entries()]) {
    if (ch.chatId !== chatId || ch.status !== "pending") continue;
    const w = waiters.get(id);
    if (w) {
      w.resolve("superseded");
    } else {
      // Defensive: challenge exists without a waiter — write audit directly.
      writeApprovalEvent({
        kind: "approval_event",
        toolName: ch.toolName,
        challengeId: id,
        outcome: "superseded",
      });
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

function redactSummaryValue(key: string, value: unknown): string {
  const SENSITIVE =
    /(token|secret|password|api[_-]?key|credential|authorization|bearer|cookie|session)/i;
  if (SENSITIVE.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    if (SENSITIVE.test(value)) return "[REDACTED]";
    return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  }
  if (Array.isArray(value)) {
    const preview = value
      .slice(0, 5)
      .map((item) => (typeof item === "string" ? redactSummaryValue(key, item) : String(item)))
      .join(", ");
    return `[${preview}${value.length > 5 ? ", ..." : ""}]`;
  }
  try {
    const s = JSON.stringify(value);
    return s.length > 80 ? `${s.slice(0, 77)}...` : s;
  } catch {
    return "[unserialisable]";
  }
}

function summariseArgsForApproval(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(args).sort()) {
    parts.push(`${key}=${redactSummaryValue(key, args[key])}`);
    if (parts.join(" ").length > 280) break;
  }
  const joined = parts.join(" ");
  return joined.length > 280 ? `${joined.slice(0, 279)}...` : joined;
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
  args: Record<string, unknown>,
  options?: CreateChallengeOptions
): { challengeId: string; summary: string; payloadHash: string } {
  expirePendingChallengesForChat(chatId);

  let challengeId = makeChallengeId();
  while (challenges.has(challengeId)) {
    challengeId = makeChallengeId();
  }

  const payloadHash = hashPayload(args);
  const fallbackSummary = summariseArgsForApproval(args);
  const summary =
    typeof options?.summaryOverride === "string" &&
    options.summaryOverride.trim().length > 0
      ? options.summaryOverride.trim().slice(0, 280)
      : fallbackSummary;

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
 * Wait for TOTP approval or timeout. Register before sending the UI prompt.
 *
 * Returns a specific `ApprovalOutcome` so callers can surface precise error
 * messages and the audit log records the exact reason:
 *   "approved"   – TOTP verified correctly.
 *   "denied"     – explicit reject via `denyChallenge` (future-facing).
 *   "timeout"    – TTL elapsed without a valid code.
 *   "superseded" – a new challenge replaced this one for the same session.
 *
 * The audit event is written here — inside the single convergence point —
 * so it is always recorded regardless of which path resolves the promise.
 */
export function waitForApproval(challengeId: string): Promise<ApprovalOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(challengeId);
      const ch = challenges.get(challengeId);
      if (ch?.status === "pending") {
        writeApprovalEvent({
          kind: "approval_event",
          toolName: ch.toolName,
          challengeId,
          outcome: "timeout",
        });
        challenges.delete(challengeId);
      }
      resolve("timeout");
    }, APPROVAL_TTL_MS);

    waiters.set(challengeId, {
      resolve: (outcome: ApprovalOutcome) => {
        clearTimeout(timer);
        waiters.delete(challengeId);
        const ch = challenges.get(challengeId);
        if (ch) {
          writeApprovalEvent({
            kind: "approval_event",
            toolName: ch.toolName,
            challengeId,
            outcome,
          });
        }
        challenges.delete(challengeId);
        resolve(outcome);
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
    // Non-terminal: the challenge stays pending so the user may retry within TTL.
    writeApprovalEvent({
      kind: "approval_event",
      toolName: ch.toolName,
      challengeId: id,
      outcome: "bad_code",
    });
    return { ok: false, message: "Invalid authenticator code." };
  }

  ch.status = "approved";
  const w = waiters.get(id);
  if (w) {
    w.resolve("approved");
  } else {
    // Waiter already gone (race); write audit directly and clean up.
    writeApprovalEvent({
      kind: "approval_event",
      toolName: ch.toolName,
      challengeId: id,
      outcome: "approved",
    });
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

/**
 * Cancel the pending challenge for this chat. Resolves the waiting `executeTool`
 * call with outcome "cancelled" and writes the audit record.
 *
 * This is the public user-facing action ("CANCEL" keyword / button). Use
 * `denyChallenge` for programmatic/module-workflow denials.
 */
export function cancelPendingForChat(
  chatId: number
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
    return { ok: false, message: "No pending approval to cancel." };
  }

  const ch = challenges.get(foundId)!;
  ch.status = "rejected";
  const w = waiters.get(foundId);
  if (w) {
    w.resolve("cancelled");
  } else {
    writeApprovalEvent({
      kind: "approval_event",
      toolName: ch.toolName,
      challengeId: foundId,
      outcome: "cancelled",
    });
    challenges.delete(foundId);
  }

  return { ok: true, message: "Cancelled. The pending action has been aborted." };
}

/**
 * Explicitly deny a pending challenge by ID. Resolves the waiting `executeTool`
 * call with outcome "denied" and writes the audit record.
 *
 * Returns `{ ok: false }` when the challengeId is unknown, already completed,
 * or does not belong to `chatId` — safe to surface directly to the user.
 *
 * This is the future-facing hook for module workflow deny commands (e.g. a
 * coding module that lets the user approve/deny shell commands). It is wired
 * up now so the approval system is already taxonomy-complete when those
 * modules arrive.
 */
export function denyChallenge(
  chatId: number,
  challengeId: string
): { ok: boolean; message: string } {
  const id = challengeId.trim().toLowerCase();
  const ch = challenges.get(id);
  if (!ch) {
    return { ok: false, message: "Unknown or expired challenge." };
  }
  if (ch.chatId !== chatId) {
    return { ok: false, message: "This challenge does not belong to this chat." };
  }
  if (ch.status !== "pending") {
    return { ok: false, message: "Challenge already completed." };
  }

  ch.status = "rejected";
  const w = waiters.get(id);
  if (w) {
    w.resolve("denied");
  } else {
    writeApprovalEvent({
      kind: "approval_event",
      toolName: ch.toolName,
      challengeId: id,
      outcome: "denied",
    });
    challenges.delete(id);
  }

  return { ok: true, message: "Challenge denied." };
}

/**
 * Shutdown drain: write an "aborted" audit record for every challenge that is
 * still pending when the process exits. Call this synchronously in the shutdown
 * handler before `process.exit()`.
 *
 * Does NOT resolve waiters — the event loop is already closing so any async
 * continuations would never run. The sole purpose is to close the audit trail
 * so no challenge disappears from the log without a terminal event.
 *
 * Returns the number of challenges that were drained (0 in the common case
 * where no high-risk call was in flight at shutdown time).
 */
export function drainPendingChallenges(): number {
  const now = Date.now();
  let count = 0;
  for (const [id, ch] of [...challenges.entries()]) {
    if (ch.status !== "pending") continue;
    writeApprovalEvent({
      kind: "approval_event",
      toolName: ch.toolName,
      challengeId: id,
      outcome: now > ch.expiresAt ? "timeout" : "aborted",
    });
    challenges.delete(id);
    waiters.delete(id);
    count++;
  }
  return count;
}
