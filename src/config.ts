/**
 * P2 Claw — Configuration loader and validator.
 *
 * Loads environment variables from .env and validates that all required
 * values are present. Crashes immediately with actionable error messages
 * if anything is missing or invalid.
 */

import "dotenv/config";

/** Text-to-speech delivery: off, Telegram voice note, or Player2 app speakers */
export type VoiceOutputMode = "off" | "tg" | "pc";

export interface Config {
  /** Player2 Game Client ID (resolved by security module) */
  player2GameKey: string;

  /** Telegram Bot API token from @BotFather */
  telegramBotToken: string;

  /** Numeric Telegram user IDs allowed to interact with the bot */
  allowedUserIds: number[];

  /** Whether to use Player2 AI profile switching (Patron feature) */
  useProfiles: boolean;

  /** Default profile name when profiles are enabled */
  defaultProfile: string;

  /** Max iterations for the agentic tool loop */
  maxAgentIterations: number;

  /** Bot display name */
  botName: string;

  /** Default voice output when a chat has no stored preference */
  defaultVoiceMode: VoiceOutputMode;
}

// ── Hard-coded absolute safety ceiling ──────────────────────────
const ABSOLUTE_MAX_ITERATIONS = 25;

function fatal(message: string): never {
  console.error(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.error(`║  P2 CLAW — FATAL CONFIGURATION ERROR                        ║`);
  console.error(`╚══════════════════════════════════════════════════════════════╝`);
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

function parseVoiceOutputMode(raw: string | undefined): VoiceOutputMode {
  const v = (raw ?? "off").trim().toLowerCase();
  if (v === "off" || v === "none" || v === "false" || v === "0") return "off";
  if (v === "tg" || v === "telegram" || v === "voice") return "tg";
  if (v === "pc" || v === "speaker" || v === "local" || v === "app") return "pc";
  console.warn(
    `⚠️  Invalid DEFAULT_VOICE_MODE "${raw ?? ""}". Expected off, tg, or pc. Using off.`
  );
  return "off";
}

export function loadConfig(): Config {
  // ── Telegram Bot Token ──────────────────────────────────────────
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!telegramBotToken || telegramBotToken === "your_telegram_bot_token_here") {
    fatal(
      "TELEGRAM_BOT_TOKEN is missing or still set to placeholder.\n" +
      "  1. Open Telegram and message @BotFather\n" +
      "  2. Send /newbot and follow the prompts\n" +
      "  3. Copy the token into your .env file"
    );
  }

  // ── Allowed User IDs ────────────────────────────────────────────
  const rawUserIds = process.env.TELEGRAM_ALLOWED_USER_IDS?.trim();
  if (!rawUserIds || rawUserIds === "123456789") {
    fatal(
      "TELEGRAM_ALLOWED_USER_IDS is missing or still set to placeholder.\n" +
      "  1. Open Telegram and message @userinfobot\n" +
      "  2. It will reply with your numeric user ID\n" +
      "  3. Paste that number into your .env file"
    );
  }

  const allowedUserIds = rawUserIds.split(",").map((id) => {
    const parsed = parseInt(id.trim(), 10);
    if (isNaN(parsed)) {
      fatal(`Invalid user ID "${id.trim()}" in TELEGRAM_ALLOWED_USER_IDS. Must be numeric.`);
    }
    return parsed;
  });

  // ── Player2 Game Key ────────────────────────────────────────────
  // NOTE: The actual key resolution (including obfuscated fallback)
  // is handled by security.ts. Here we just read the raw env value.
  const player2GameKey = process.env.PLAYER2_GAME_KEY?.trim() ?? "";

  // ── Profiles ────────────────────────────────────────────────────
  const useProfiles = process.env.USE_PROFILES?.toLowerCase() === "true";
  const defaultProfile = process.env.DEFAULT_PROFILE?.trim() ?? "";

  // ── Agent Settings ──────────────────────────────────────────────
  let maxAgentIterations = parseInt(process.env.MAX_AGENT_ITERATIONS ?? "10", 10);
  if (isNaN(maxAgentIterations) || maxAgentIterations < 1) {
    maxAgentIterations = 10;
  }
  if (maxAgentIterations > ABSOLUTE_MAX_ITERATIONS) {
    console.warn(
      `⚠️  MAX_AGENT_ITERATIONS (${maxAgentIterations}) exceeds safety ceiling. ` +
      `Capped to ${ABSOLUTE_MAX_ITERATIONS}.`
    );
    maxAgentIterations = ABSOLUTE_MAX_ITERATIONS;
  }

  // ── Bot Name ────────────────────────────────────────────────────
  const botName = process.env.BOT_NAME?.trim() || "Ellie";

  // ── Voice output default (per-chat override via /voice) ─────────
  const defaultVoiceMode = parseVoiceOutputMode(process.env.DEFAULT_VOICE_MODE);

  return {
    player2GameKey,
    telegramBotToken,
    allowedUserIds,
    useProfiles,
    defaultProfile,
    maxAgentIterations,
    botName,
    defaultVoiceMode,
  };
}
