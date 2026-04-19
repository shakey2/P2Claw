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
export type UiMode = "telegram" | "cli" | "html";

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

  /**
   * Persona / assistant display name (`BOT_NAME`). Default **Ellie** — Player2’s elephant mascot.
   * Used in the system prompt, Telegram copy, and the local HTML UI title.
   */
  botName: string;

  /** Default voice output when a chat has no stored preference */
  defaultVoiceMode: VoiceOutputMode;

  /** Which UI frontend to run. */
  uiMode: UiMode;

  /** Loopback bind address for `UI_MODE=html` (must stay loopback — see DESIGN.md §2.1.2). */
  htmlBindHost: string;

  /** TCP port for the local HTML GUI. */
  htmlBindPort: number;

  /**
   * RFC 6238 TOTP shared secret (Base32) for high-risk tool approval.
   * Optional until you use high-risk tools. Never commit — keep in `.env` only.
   */
  totpSecretBase32?: string;

  /**
   * Stable numeric key for persisted memories (and shared voice prefs in DB).
   * All frontends (Telegram, CLI, future UIs) use this so the same SQLite rows
   * are read/written regardless of Telegram `chat.id` or CLI session id.
   */
  memoryScopeId: number;

  /**
   * Developer diagnostics mode (`P2CLAW_DEV_MODE`). Default false.
   *
   * When true:
   *   - the loader scans `src/extensions/dev-tools/` and registers its tools
   *     (debug_list_tools, debug_inspect_module, debug_tail_audit,
   *     debug_call_tool).
   *   - every frontend enables the `/debug` slash command.
   *
   * When false, neither surface exists — `/debug` is treated as "unknown
   * command" so the feature does not leak in normal installs. Does NOT
   * relax the TOTP gate or the broker audit. See DESIGN.md §4.7.
   */
  devMode: boolean;

  /** Default timeout for MCP tool calls routed through Core (ms). */
  mcpCallTimeoutMs: number;
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

function parseUiMode(raw: string | undefined): UiMode {
  const v = (raw ?? "telegram").trim().toLowerCase();
  if (v === "telegram" || v === "tg") return "telegram";
  if (v === "cli" || v === "terminal") return "cli";
  if (v === "html" || v === "web" || v === "gui") return "html";
  console.warn(
    `⚠️  Invalid UI_MODE "${raw ?? ""}". Expected telegram, cli, or html. Using telegram.`
  );
  return "telegram";
}

const PLACEHOLDER_BOT = "your_telegram_bot_token_here";
const PLACEHOLDER_USER_IDS = "123456789";

function parseHtmlBindHost(raw: string | undefined): string {
  const v = (raw ?? "127.0.0.1").trim().toLowerCase();
  if (v === "127.0.0.1" || v === "localhost" || v === "::1") {
    return v === "localhost" ? "127.0.0.1" : v;
  }
  console.warn(
    `⚠️  HTML_UI_HOST "${v}" is not a loopback address. Forcing 127.0.0.1 (DESIGN.md §2.1.2).`
  );
  return "127.0.0.1";
}

function parseHtmlBindPort(raw: string | undefined): number {
  const n = parseInt(raw ?? "3847", 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    console.warn(`⚠️  Invalid HTML_UI_PORT. Using 3847.`);
    return 3847;
  }
  return n;
}

function parseMemoryScopeId(raw: string | undefined): number {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return 1;
  const n = parseInt(trimmed, 10);
  if (!Number.isFinite(n)) {
    console.warn(
      `Invalid P2CLAW_MEMORY_CHAT_ID "${raw ?? ""}". Using default 1.`
    );
    return 1;
  }
  return n;
}

function parseMcpCallTimeoutMs(raw: string | undefined): number {
  const n = parseInt(raw ?? "30000", 10);
  if (!Number.isFinite(n) || n < 1000) {
    console.warn(`⚠️  Invalid MCP_CALL_TIMEOUT_MS. Using 30000.`);
    return 30000;
  }
  if (n > 300000) {
    console.warn(`⚠️  MCP_CALL_TIMEOUT_MS too high (${n}). Capping to 300000.`);
    return 300000;
  }
  return n;
}

export function loadConfig(): Config {
  const uiMode = parseUiMode(process.env.UI_MODE);
  const htmlBindHost = parseHtmlBindHost(process.env.HTML_UI_HOST);
  const htmlBindPort = parseHtmlBindPort(process.env.HTML_UI_PORT);

  // ── Telegram Bot Token & allowlist ───────────────────────────────
  let telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  let rawUserIds = process.env.TELEGRAM_ALLOWED_USER_IDS?.trim() ?? "";

  // Telegram settings are only required when using the Telegram UI.
  // HTML + CLI can run without Telegram configured.
  if (uiMode === "telegram") {
    if (!telegramBotToken || telegramBotToken === PLACEHOLDER_BOT) {
      fatal(
        "TELEGRAM_BOT_TOKEN is missing or still set to placeholder.\n" +
          "  1. Open Telegram and message @BotFather\n" +
          "  2. Send /newbot and follow the prompts\n" +
          "  3. Copy the token into your .env file\n"
      );
    }
    if (!rawUserIds || rawUserIds === PLACEHOLDER_USER_IDS) {
      fatal(
        "TELEGRAM_ALLOWED_USER_IDS is missing or still set to placeholder.\n" +
          "  1. Open Telegram and message @userinfobot\n" +
          "  2. It will reply with your numeric user ID\n" +
          "  3. Paste that number into your .env file"
      );
    }
  } else {
    // Keep placeholders benign for non-Telegram modes.
    if (!telegramBotToken) telegramBotToken = PLACEHOLDER_BOT;
    if (!rawUserIds) rawUserIds = "";
  }

  const allowedUserIds =
    rawUserIds.trim().length === 0
      ? []
      : rawUserIds.split(",").map((id) => {
          const parsed = parseInt(id.trim(), 10);
          if (isNaN(parsed)) {
            fatal(
              `Invalid user ID "${id.trim()}" in TELEGRAM_ALLOWED_USER_IDS. Must be numeric.`
            );
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

  // ── TOTP (Level 4 high-risk approvals) ─────────────────────────
  const totpRaw = process.env.TOTP_SECRET_BASE32?.trim() ?? "";
  const totpSecretBase32 = totpRaw.length > 0 ? totpRaw : undefined;

  const memoryScopeId = parseMemoryScopeId(process.env.P2CLAW_MEMORY_CHAT_ID);

  const devMode = parseBool(process.env.P2CLAW_DEV_MODE);
  const mcpCallTimeoutMs = parseMcpCallTimeoutMs(process.env.MCP_CALL_TIMEOUT_MS);

  return {
    player2GameKey,
    telegramBotToken,
    allowedUserIds,
    useProfiles,
    defaultProfile,
    maxAgentIterations,
    botName,
    defaultVoiceMode,
    uiMode,
    htmlBindHost,
    htmlBindPort,
    totpSecretBase32,
    memoryScopeId,
    devMode,
    mcpCallTimeoutMs,
  };
}

/**
 * Accept "true" / "1" / "yes" / "on" as truthy. Anything else (including
 * empty / unset) is false. Used for opt-in developer-only switches where
 * we specifically want fail-closed behaviour.
 */
function parseBool(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}
