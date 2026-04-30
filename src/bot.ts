/**
 * P2 Claw — Telegram bot.
 *
 * Sets up grammY with:
 *   - User ID whitelist middleware (silently ignores unauthorized users)
 *   - /start, /status, /profile, /clear, /memories, /compact commands
 *   - Text + voice message handlers that route to the agent loop
 *
 * Uses long-polling only. No web server. No exposed ports.
 */

import { Bot, InputFile } from "grammy";
import type { Context } from "grammy";
import type { Config, VoiceOutputMode } from "./config.js";
import {
  clearHistory,
  getHistoryLength,
  setActiveProfile,
  getActiveProfile,
  compactHistory,
} from "./agent.js";
import { createAgentCore } from "./ui/core.js";
import {
  tryApproveWithTotp,
  tryApprovePendingForChat,
  selectApprovalOption,
  cancelPendingForChat,
  hasPendingApprovalForChat,
} from "./security/approval.js";
import {
  checkHealth,
  getJoules,
  listProfiles,
  transcribeAudio,
  generateSpeech,
  splitTextForPlayer2Tts,
  PLAYER2_TTS_MAX_TEXT_CHARS,
} from "./player2.js";
import { getToolCount } from "./tools/registry.js";
import {
  listMemories,
  getMemoryCount,
  addMemory,
  getChatVoiceMode,
  setChatVoiceMode,
} from "./memory/index.js";
import { log } from "./logger.js";
import { requestGracefulShutdown } from "./graceful-shutdown.js";
import {
  handleDebugCommand,
  parseDebugTail,
  type DebugResult,
} from "./ui/debug.js";
import {
  listCapabilities,
  revokeCapability,
  revokeAll,
} from "./security/capability-store.js";

/**
 * Player2 TTS chunking: `/v1/tts/speak` fails on long text (often HTTP 500).
 * We split to `PLAYER2_TTS_MAX_TEXT_CHARS` before each API call. Telegram
 * sends one voice note per chunk; `pc` plays each chunk in sequence via
 * Player2. A future local HTML UI can call the same splitter or stream differently.
 */
const MAX_PLAYER2_TTS_CHUNKS_PER_REPLY = 36;

/**
 * Effective voice mode: per-chat DB preference, else `.env` default.
 */
async function effectiveVoiceMode(config: Config): Promise<VoiceOutputMode> {
  try {
    const stored = await getChatVoiceMode(config.memoryScopeId);
    if (stored !== null) return stored;
  } catch {
    /* database unavailable */
  }
  return config.defaultVoiceMode;
}

async function replyWithTtsError(ctx: Context, err: unknown): Promise<void> {
  const anyErr = err as { status?: number; message?: string };
  if (
    anyErr.status === 402 ||
    (anyErr.message && anyErr.message.toLowerCase().includes("patron"))
  ) {
    await ctx.reply(
      "⚠️ *Voice Error*: The current AI voice is a premium ElevenLabs model requiring Patron status on Player2. Free users should switch to the 'Kokoro' voice in the Player2 App settings.",
      { parse_mode: "Markdown" }
    );
  } else {
    console.error("❌ TTS Error:", err);
    await ctx.reply(
      `⚠️ *Voice Error*: ${anyErr.message || "Failed to generate speech."}`,
      { parse_mode: "Markdown" }
    );
  }
}

/**
 * Sends TTS after an assistant text reply (Telegram voice note or Player2 speakers).
 * Uses assistant plain text only (no transcript prefix).
 */
async function maybeSendTtsAfterReply(
  ctx: Context,
  assistantPlainText: string,
  mode: VoiceOutputMode
): Promise<void> {
  const trimmed = assistantPlainText.trim();
  if (mode === "off" || !trimmed) return;

  const chunks = splitTextForPlayer2Tts(trimmed);
  const limited = chunks.slice(0, MAX_PLAYER2_TTS_CHUNKS_PER_REPLY);
  const omitted = chunks.length - limited.length;

  if (mode === "pc") {
    await ctx.replyWithChatAction("record_voice");
    try {
      for (let i = 0; i < limited.length; i++) {
        const chunk = limited[i];
        if (!chunk.trim()) continue;
        console.log(
          `   → TTS Player2 (pc) chunk ${i + 1}/${limited.length} (${chunk.length} chars, max ${PLAYER2_TTS_MAX_TEXT_CHARS})`
        );
        await generateSpeech(chunk, true);
      }
      if (omitted > 0) {
        console.warn(
          `   ⚠️ TTS (pc): omitted ${omitted} chunk(s) after cap — full text was sent as messages above`
        );
      }
    } catch (err: unknown) {
      await replyWithTtsError(ctx, err);
    }
    return;
  }

  // mode === "tg" — one Telegram voice note per Player2-sized chunk
  try {
    for (let i = 0; i < limited.length; i++) {
      const chunk = limited[i];
      if (!chunk.trim()) continue;

      console.log(
        `   → TTS Telegram chunk ${i + 1}/${limited.length} (${chunk.length} chars, max ${PLAYER2_TTS_MAX_TEXT_CHARS})`
      );
      await ctx.replyWithChatAction("record_voice");
      const speechData = await generateSpeech(chunk, false);
      if (speechData) {
        const buffer = Buffer.from(speechData, "base64");
        await ctx.replyWithVoice(new InputFile(buffer));
      }
    }

    if (omitted > 0) {
      await ctx
        .reply(
          `_(Voice: ${omitted} segment(s) not spoken — full answer is in the text above.)_`,
          { parse_mode: "Markdown" }
        )
        .catch(() =>
          ctx.reply(
            "Voice: some segments were not spoken; the full answer is in the text above."
          )
        );
    }

    console.log(
      `   ✓ Voice memo(s) sent to Telegram (${limited.length} part(s)${omitted ? `, ${omitted} omitted` : ""})`
    );
  } catch (err: unknown) {
    await replyWithTtsError(ctx, err);
  }
}

function escapeMarkdownV1(text: string): string {
  return text.replace(/([_*`\[])/g, "\\$1");
}

/**
 * Renders a DebugResult into Telegram-ready message chunks. Each chunk is
 * ≤ 4096 chars so we can reply directly. Structured sections use Markdown
 * for readability; raw tool output is wrapped in a triple-backtick block
 * so the caller can safely fall back to plain text if Markdown parsing
 * fails (the existing text-message handler already does this dance).
 */
function renderDebugForTelegram(result: DebugResult): string[] {
  const body = (() => {
    switch (result.kind) {
      case "help":
        return ["*Dev-tools — /debug subcommands*", ...result.lines].join("\n");
      case "list": {
        const lines = result.tools.map((t) => {
          const owner = escapeMarkdownV1(t.ownerModuleId ?? "core");
          const perms = t.requiredPermissions.length
            ? t.requiredPermissions.map((p) => escapeMarkdownV1(p)).join(", ")
            : "(none)";
          return `• *${escapeMarkdownV1(t.name)}* [${t.effectiveRisk}] owner=${owner} perms=${perms}`;
        });
        return `*Tools (${result.tools.length})*\n${lines.join("\n")}`;
      }
      case "modules": {
        if (result.modules.length === 0) return "_No loaded modules._";
        const lines = result.modules.map(
          (m) =>
            `• *${escapeMarkdownV1(m.id)}* v${escapeMarkdownV1(m.version)} — perms=[${m.permissions.join(", ") || "none"}] tools=${m.tools.length}`
        );
        return `*Loaded modules (${result.modules.length})*\n${lines.join("\n")}`;
      }
      case "inspect_module":
        if (!result.module) {
          return `No loaded module with id \`${escapeMarkdownV1(result.moduleId)}\`.`;
        }
        return "```\n" + JSON.stringify(result.module, null, 2) + "\n```";
      case "audit": {
        const header = result.note
          ? `*Audit*: \`${result.path}\`\n_${result.note}_`
          : `*Audit*: \`${result.path}\`\nLast ${result.entries.length} of ${result.n} requested:`;
        // Raw JSONL — never Markdown-format each line; users pipe through jq.
        const block = result.entries.length
          ? "\n```\n" + result.entries.join("\n") + "\n```"
          : "";
        return header + block;
      }
      case "call": {
        const m = result.meta;
        const meta =
          `*debug call*\n` +
          `target: \`${escapeMarkdownV1(m.target)}\`\n` +
          `owner: \`${escapeMarkdownV1(m.targetOwnerModuleId ?? "core")}\`\n` +
          `risk: ${m.effectiveRisk}\n` +
          `outcome: ${m.outcome}`;
        // Wrap raw in a fenced block so backticks/angles in the payload
        // don't collide with Markdown.
        return meta + "\n*raw:*\n```\n" + m.raw + "\n```";
      }
      case "perms": {
        const i = result.info;
        const pending = i.pendingChallenge
          ? `pending: tool=\`${escapeMarkdownV1(i.pendingChallenge.toolName)}\` expires=${new Date(i.pendingChallenge.expiresAt).toISOString()}`
          : "pending: _(none — approvals are ephemeral one-shot challenges)_";
        return (
          `*perms* \`${escapeMarkdownV1(i.tool)}\`\n` +
          `owner: \`${escapeMarkdownV1(i.ownerModuleId ?? "core")}\`\n` +
          `required: ${i.requiredPermissions.join(", ") || "(none)"}\n` +
          `effectiveRisk: ${i.effectiveRisk}\n` +
          `totpConfigured: ${i.totpConfigured}\n` +
          pending
        );
      }
      case "unknown_subcommand":
        return `Unknown /debug subcommand: \`${escapeMarkdownV1(result.subcommand)}\`. Try \`/debug help\`.`;
      case "error":
        return `Error: ${result.message}`;
      case "disabled":
        return "";
    }
  })();
  return splitMessage(body, 4096);
}

/**
 * Per-chat FIFO queue so long agent runs (e.g. waiting on TOTP) do not block
 * grammY's update loop: the next Telegram update (your 6-digit code) can run
 * immediately instead of sitting behind a still-awaiting processMessage().
 */
const agentJobTailByChat = new Map<number, Promise<void>>();

function enqueueAgentJob(chatId: number, job: () => Promise<void>): void {
  const prev = agentJobTailByChat.get(chatId) ?? Promise.resolve();
  const next = prev.then(job).catch((err: unknown) => {
    console.error("Agent job error:", err);
  });
  agentJobTailByChat.set(chatId, next);
}

/**
 * Creates and configures the Telegram bot.
 */
export function createBot(config: Config): Bot {
  const core = createAgentCore(config);
  const bot = new Bot(config.telegramBotToken);

  // ── Whitelist middleware ─────────────────────────────────────
  // This MUST be the first middleware. Unauthorized users are
  // silently ignored — no response, no error, no acknowledgment.
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !config.allowedUserIds.includes(userId)) {
      // Log blocked attempts so we can debug whitelist issues
      if (userId) {
        console.log(`🚫 Blocked message from unauthorized user: ${userId}`);
      }
      return;
    }
    // Log authorized message receipt
    console.log(`📩 Message from user ${userId} in chat ${ctx.chat?.id ?? "unknown"}`);
    await next();
  });

  // ── TOTP approval interception (before agent / commands) ────
  // Codes and APPROVE lines must never reach the LLM or conversation history.
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text?.trim();
    if (!text) {
      await next();
      return;
    }
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      await next();
      return;
    }

    const secret = config.totpSecretBase32?.trim();
    const pending = !!(secret && hasPendingApprovalForChat(chatId));

    // While a challenge is open, a 6-digit message (optionally spaced) is a TOTP attempt (not chat).
    // e.g. "111111" or "111 111"
    const digitsOnly = text.replace(/\s+/g, "");
    if (pending && secret && /^\d{6}$/.test(digitsOnly)) {
      const result = tryApprovePendingForChat(chatId, digitsOnly, secret);
      console.log(`   TOTP approval attempt (code-only) ok=${result.ok}`);
      await ctx.reply(
        result.ok
          ? "Approved. The pending action will continue."
          : `Not approved: ${result.message}`
      );
      return;
    }
    // If there's no pending approval, never forward 6-digit codes to the agent.
    // This avoids accidental tool triggers from "extra" codes sent right after approval.
    if (!pending && secret && /^\d{6}$/.test(digitsOnly)) {
      await ctx.reply("No pending high-risk action is waiting for approval.");
      return;
    }

    // Any line starting with APPROVE: never forward to the model (avoids backlog weirdness).
    if (secret && /^APPROVE\b/i.test(text)) {
      if (!pending) {
        await ctx.reply("There is no pending high-risk action waiting for approval.");
        return;
      }
      const short = text.match(/^APPROVE\s+(\d{6})\s*$/i);
      const full = text.match(/^APPROVE\s+([a-f0-9]{8})\s+(\d{6})\s*$/i);
      const optioned = text.match(/^APPROVE\s+([a-f0-9]{8})\s+(\d+)(?:\s+(\d{6}))?\s*$/i);
      let result;
      if (full) {
        result = tryApproveWithTotp(chatId, full[1]!.toLowerCase(), full[2]!, secret);
        console.log(`   TOTP approval attempt challenge=${full[1]!.toLowerCase()} ok=${result.ok}`);
      } else if (optioned) {
        result = selectApprovalOption(
          chatId,
          optioned[1]!.toLowerCase(),
          Number(optioned[2]) - 1,
          secret,
          optioned[3]
        );
        console.log(`   Approval option attempt challenge=${optioned[1]!.toLowerCase()} option=${optioned[2]} ok=${result.ok}`);
      } else if (short) {
        result = tryApprovePendingForChat(chatId, short[1]!, secret);
        console.log(`   TOTP approval attempt (APPROVE code) ok=${result.ok}`);
      } else {
        await ctx.reply(
          "Send only the 6-digit code from your authenticator, or:\n" +
            "APPROVE <8-char-id> <option> [code]\n" +
            "APPROVE <8-char-id> <code>\n" +
            "(Check the pending message for the id if you use the long form.)"
        );
        return;
      }
      await ctx.reply(
        result.ok
          ? "Approved. The pending action will continue."
          : `Not approved: ${result.message}`
      );
      return;
    }

    // CANCEL: user aborts the pending TOTP challenge without providing a code.
    if (/^CANCEL\s*$/i.test(text)) {
      if (!pending) {
        await ctx.reply("There is no pending high-risk action to cancel.");
        return;
      }
      const result = cancelPendingForChat(chatId);
      console.log(`   TOTP cancel ok=${result.ok}`);
      await ctx.reply(
        result.ok
          ? "Cancelled. The pending action has been aborted. The bot has been informed."
          : `Could not cancel: ${result.message}`
      );
      return;
    }

    // If an approval is pending, do not allow other chat messages to queue behind the agent.
    // Let commands through (e.g. /status) so the bot stays operable.
    if (pending && secret) {
      if (text.startsWith("/")) {
        await next();
        return;
      }
      await ctx.reply(
        "Approval pending. Send the 6-digit code from your authenticator app."
      );
      return;
    }

    await next();
  });

  // ── Setup State ──────────────────────────────────────────────
  const setupState = new Map<number, number>();
  const SETUP_QUESTIONS = [
    "What should I call you?",
    "What's my main purpose?",
    "What tone would you prefer me to speak in? (eg: Friendly, professional, etc)"
  ];

  // ── /setup command ──────────────────────────────────────────
  bot.command("setup", async (ctx) => {
    setupState.set(ctx.chat.id, 0);
    await ctx.reply(
      `Welcome to the Core Setup! I'll ask you a few questions.\n` +
      `Your answers will form my fundamental memory so I never forget them.\n\n` +
      `Type /cancel at any time to exit.\n\n` +
      `1: ${SETUP_QUESTIONS[0]}`
    );
  });

  // ── /cancel command ─────────────────────────────────────────
  bot.command("cancel", async (ctx) => {
    if (setupState.has(ctx.chat.id)) {
      setupState.delete(ctx.chat.id);
      await ctx.reply("❌ Setup cancelled.");
    } else {
      await ctx.reply("Nothing to cancel.");
    }
  });

  // ── /totp_status — Level 4 TOTP configured? ───────────────
  bot.command("totp_status", async (ctx) => {
    const ok = !!config.totpSecretBase32?.trim();
    await ctx.reply(
      ok
        ? "TOTP: configured (secret present in .env)."
        : "TOTP: not configured. Use /totp_enroll_help."
    );
  });

  // ── /totp_enroll_help — manual enrollment instructions ─────
  bot.command("totp_enroll_help", async (ctx) => {
    await ctx.reply(
      [
        "TOTP (RFC 6238) for high-risk tools (Google Authenticator, Aegis, etc.):",
        "",
        "1. Generate a random Base32 secret (20+ bytes of entropy).",
        "2. In your authenticator app, add a manual key with that secret.",
        "3. Put the same value in .env as TOTP_SECRET_BASE32= (no quotes).",
        "4. Restart the bot. Check with /totp_status.",
        "",
        "When a high-risk tool runs, reply with only the 6-digit code, or:",
        "APPROVE <challengeId> <6-digit-code>",
        "",
        "To abort without approving, reply:",
        "CANCEL",
      ].join("\n")
    );
  });

  // ── /shutdown command (whitelist-only) ───────────────────────
  // Gracefully stops the process so Ctrl+C / terminal state isn't required.
  bot.command("shutdown", async (ctx) => {
    await ctx.reply("👋 Shutting down P2 Claw...");
    // Same path as Ctrl+C — self-SIGINT is unreliable under `tsx watch` on Windows.
    requestGracefulShutdown();
  });

  // ── /debug command (DEV MODE ONLY) ───────────────────────────
  // Registered only when P2CLAW_DEV_MODE=true. When dev mode is off the
  // command is simply not bound — grammY will not respond, matching the
  // "unknown command" contract in DESIGN.md §4.7 (no information leak).
  if (config.devMode) {
    bot.command("debug", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      const { subcommand, rest } = parseDebugTail((ctx.match ?? "").trimStart());
      const result = await handleDebugCommand({
        devMode: true,
        sessionId: chatId,
        subcommand,
        rest,
        uiMode: "telegram",
        totpSecretBase32: config.totpSecretBase32,
        memoryScopeId: config.memoryScopeId,
        sendPendingApproval: async (text: string) => {
          await ctx.reply(text);
        },
      });
      const chunks = renderDebugForTelegram(result);
      for (const chunk of chunks) {
        if (!chunk) continue;
        await ctx.reply(chunk, { parse_mode: "Markdown" }).catch(() => {
          return ctx.reply(chunk);
        });
      }
    });
  }

  // ── /start command ──────────────────────────────────────────
  bot.command("start", async (ctx) => {
    const name = config.botName;
    await ctx.reply(
      `👋 Hi! I'm *${name}*, your personal AI assistant.\n\n` +
      `I'm running locally on your machine via P2 Claw, powered by Player2.\n\n` +
      `🔒 *Security*: Only you can talk to me. Your messages stay on your device.\n\n` +
      `📋 *Commands*:\n` +
      `  /status — Check system health\n` +
      `  /profile — View/switch AI profiles\n` +
      `  /memories — List stored memories\n` +
      `  /compact — Summarize conversation history\n` +
      `  /voice — Configure voice output\n` +
      `  /caps — Manage capabilities\n` +
      `  /totp_status — TOTP configured? (Level 4)\n` +
      `  /totp_enroll_help — Set up Google Authenticator\n` +
      `  /shutdown — Stop the bot safely\n` +
      `  /clear — Reset conversation history\n\n` +
      `I can remember things you tell me across conversations. ` +
      `Just send me a message to get started!`,
      { parse_mode: "Markdown" }
    );
  });

  // ── /voice command ──────────────────────────────────────────
  bot.command("voice", async (ctx) => {
    const args = ctx.match?.trim().toLowerCase();
    if (args === "off" || args === "tg" || args === "pc") {
      const ok = await setChatVoiceMode(config.memoryScopeId, args);
      if (!ok) {
        await ctx.reply(
          "⚠️ Could not save voice preference (database unavailable). Check that memory init succeeded, then try again."
        );
        return;
      }
      await ctx.reply(
        `🎙️ Voice Mode set to: *${args}* (saved; shared across all interfaces)`,
        { parse_mode: "Markdown" }
      );
    } else {
      const current = await effectiveVoiceMode(config);
      await ctx.reply(
        `🎙️ *Current Voice Mode*: ${current}\n\n` +
        `*Usage*: /voice <off | tg | pc>\n` +
        `  • \`off\`  : Text only\n` +
        `  • \`tg\`   : Voice note on Telegram (after each reply)\n` +
        `  • \`pc\`   : Audio on host via Player2 App\n\n` +
        `Default for new chats: \`${config.defaultVoiceMode}\` (\`DEFAULT_VOICE_MODE\` in \`.env\`).`,
        { parse_mode: "Markdown" }
      );
    }
  });

  // ── /status command ─────────────────────────────────────────
  bot.command("status", async (ctx) => {
    await ctx.reply("⏳ Checking systems...");

    const lines: string[] = ["📊 *P2 Claw Status*\n"];

    // Player2 health
    try {
      const health = await checkHealth();
      lines.push(`✅ Player2 App: Online (v${health.client_version})`);
    } catch {
      lines.push("❌ Player2 App: Offline or unreachable");
    }

    // Joule balance
    try {
      const joules = await getJoules();
      lines.push(`⚡ Joules: ${joules.joules.toLocaleString()}`);
      lines.push(`👑 Patron: ${joules.patron_tier || "None"}`);
    } catch {
      lines.push("⚡ Joules: Unable to fetch");
    }

    // Profile info
    const activeProfile = getActiveProfile();
    lines.push(`\n🤖 Active profile: ${activeProfile || "Default"}`);
    lines.push(`🔧 Tools loaded: ${getToolCount()}`);
    lines.push(
      `💬 Conversation history: ${getHistoryLength(ctx.chat.id)} messages`
    );

    const voiceOut = await effectiveVoiceMode(config);
    lines.push(`🎙️ Voice output: ${voiceOut} (/voice to change)`);

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  });

  // ── /profile command ────────────────────────────────────────
  bot.command("profile", async (ctx) => {
    if (!config.useProfiles) {
      await ctx.reply(
        "🔒 Profile switching is disabled.\n\n" +
        "To enable it, set `USE_PROFILES=true` in your .env file.\n" +
        "This is a Player2 Patron feature."
      );
      return;
    }

    const args = ctx.match?.trim();

    // If a profile name was given, switch to it
    if (args) {
      try {
        const profiles = await listProfiles();
        const found = profiles.find(
          (p) => p.name.toLowerCase() === args.toLowerCase()
        );

        if (found) {
          setActiveProfile(found.name);
          await ctx.reply(
            `✅ Switched to profile: *${found.name}*\n` +
            `Base URL: \`${found.base_url}\``,
            { parse_mode: "Markdown" }
          );
        } else {
          const available = profiles.map((p) => `  • ${p.name}`).join("\n");
          await ctx.reply(
            `❌ Profile "${args}" not found.\n\nAvailable profiles:\n${available}`
          );
        }
      } catch (err) {
        await ctx.reply("❌ Failed to fetch profiles from Player2.");
      }
      return;
    }

    // No args — list all profiles
    try {
      const profiles = await listProfiles();
      if (profiles.length === 0) {
        await ctx.reply(
          "No profiles configured.\n" +
          "Create profiles in the Player2 App settings."
        );
        return;
      }

      const active = getActiveProfile();
      const profileList = profiles
        .map((p) => {
          const marker = p.name === active ? " ✅" : "";
          return `  • *${p.name}*${marker}`;
        })
        .join("\n");

      await ctx.reply(
        `🎭 *AI Profiles*\n\n${profileList}\n\n` +
        `To switch: \`/profile <name>\`\n` +
        `Current: *${active || "Default"}*`,
        { parse_mode: "Markdown" }
      );
    } catch {
      await ctx.reply("❌ Failed to fetch profiles from Player2.");
    }
  });

  // ── /clear command ──────────────────────────────────────────
  bot.command("clear", async (ctx) => {
    const count = getHistoryLength(ctx.chat.id);
    clearHistory(ctx.chat.id);
    await ctx.reply(
      `🗑️ Conversation cleared (${count} messages removed).\n` +
      `ℹ️ Your stored memories are not affected. Use /memories to view them.`
    );
  });

  // ── /memories command ──────────────────────────────────────
  bot.command("memories", async (ctx) => {
    const scope = config.memoryScopeId;
    const count = await getMemoryCount(scope);

    if (count === 0) {
      await ctx.reply(
        "🧠 No memories stored yet.\n\n" +
        "Tell me something and I'll remember it! " +
        'For example: "Remember that I prefer dark mode"'
      );
      return;
    }

    const memories = await listMemories(scope, undefined, 20);
    const lines = memories.map(
      (m) => `  • *#${m.id}* (${m.category}) ${m.content}`
    );

    await ctx.reply(
      `🧠 *Stored Memories* (${count} total)\n\n${lines.join("\n")}\n\n` +
      `To forget: tell me "forget memory #ID"`,
      { parse_mode: "Markdown" }
    ).catch(() => {
      // Fallback if memory content breaks Markdown
      const plainLines = memories.map(
        (m) => `  • #${m.id} (${m.category}) ${m.content}`
      );
      return ctx.reply(
        `🧠 Stored Memories (${count} total)\n\n${plainLines.join("\n")}\n\nTo forget: tell me "forget memory #ID"`
      );
    });
  });

  // ── /compact command ───────────────────────────────────────
  bot.command("compact", async (ctx) => {
    const histLen = getHistoryLength(ctx.chat.id);
    if (histLen < 4) {
      await ctx.reply(
        "ℹ️ Not enough conversation history to compact " +
        `(${histLen} messages). Keep chatting!`
      );
      return;
    }

    await ctx.reply("⏳ Compacting conversation history...");

    const result = await compactHistory(ctx.chat.id);

    if (result.error) {
      await ctx.reply(`❌ Compaction failed: ${result.error}`);
    } else {
      await ctx.reply(
        `✅ Conversation compacted!\n` +
        `  Before: ${result.before} messages\n` +
        `  After: ${result.after} messages\n\n` +
        `Older messages were summarized to free up context space.`
      );
    }
  });

  // ── /caps command — capability management ───────────────────
  bot.command("caps", async (ctx) => {
    const args = (ctx.match ?? "").trim();
    const parts = args.split(/\s+/);
    const sub = parts[0]?.toLowerCase();

    if (sub === "revoke-all") {
      const count = revokeAll();
      await ctx.reply(`Revoked ${count} capability(ies).`);
      return;
    }

    if (sub === "revoke" && parts.length > 1) {
      const id = parts.slice(1).join(" ").trim();
      const revoked = revokeCapability(id);
      await ctx.reply(revoked ? `Revoked capability ${id}.` : `Capability ${id} not found.`);
      return;
    }

    // Default: list
    const caps = listCapabilities();
    if (caps.length === 0) {
      await ctx.reply("No active capabilities.");
      return;
    }
    const lines = caps.map((cap) => {
      const scope = cap.scope.path ?? cap.scope.pattern ?? cap.scope.command ?? cap.scope.type;
      const expiry = cap.expiresAt
        ? `expires ${new Date(cap.expiresAt).toISOString()}`
        : cap.persistent ? "permanent" : "session";
      return `• *${cap.tool}* [${cap.riskLevel}]\n  ${cap.permission} · scope=${scope}\n  ${expiry} · via=${cap.grantedVia}\n  id: \`${cap.id.slice(0, 8)}\``;
    });
    await ctx.reply(
      `🔐 *Active Capabilities* (${caps.length})\n\n${lines.join("\n\n")}\n\nUse \`/caps revoke <id>\` or \`/caps revoke-all\`.`,
      { parse_mode: "Markdown" }
    ).catch(() => {
      const plain = caps.map((cap) => {
        const scope = cap.scope.path ?? cap.scope.pattern ?? cap.scope.command ?? cap.scope.type;
        return `${cap.id.slice(0, 8)}  ${cap.tool}  [${cap.riskLevel}]  ${cap.permission}  scope=${scope}`;
      });
      return ctx.reply(`Active Capabilities (${caps.length}):\n${plain.join("\n")}\n\nUse /caps revoke <id> or /caps revoke-all.`);
    });
  });

  // ── Text message handler ────────────────────────────────────
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text) return;

    // Check if we are in the setup state sequence
    const currentState = setupState.get(ctx.chat.id);
    if (currentState !== undefined) {
      // Save memory as core
      await addMemory(config.memoryScopeId, `User answer to '${SETUP_QUESTIONS[currentState]}': ${text}`, "core");
      
      const nextState = currentState + 1;
      if (nextState < SETUP_QUESTIONS.length) {
        setupState.set(ctx.chat.id, nextState);
        await ctx.reply(`Got it.\n\n${nextState + 1}: ${SETUP_QUESTIONS[nextState]}`);
      } else {
        setupState.delete(ctx.chat.id);
        await ctx.reply("✅ Setup complete! My core memories have been established. What would you like to do now?");
      }
      return;
    }

    console.log(`💬 Processing message: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);

    enqueueAgentJob(ctx.chat.id, async () => {
      try {
        await ctx.replyWithChatAction("typing");
        console.log(`   → Sending to agent loop...`);
      const response = await core.process(ctx.chat.id, text, {
        sendPendingApproval: async (promptText: string) => {
          await ctx.reply(promptText);
        },
      });
      console.log(`   ← Agent returned ${response.length} chars`);

      if (response) {
        // Split long messages (Telegram limit: 4096 chars)
        if (response.length <= 4096) {
          await ctx.reply(response, { parse_mode: "Markdown" }).catch(() => {
            // Fallback to plain text if Markdown parsing fails
            console.log(`   ⚠️  Markdown parse failed, falling back to plain text`);
            return ctx.reply(response);
          });
        } else {
          // Split into chunks
          const chunks = splitMessage(response, 4096);
          for (const chunk of chunks) {
            await ctx.reply(chunk, { parse_mode: "Markdown" }).catch(() => {
              return ctx.reply(chunk);
            });
          }
        }
        console.log(`   ✓ Reply sent to Telegram`);

        const mode = await effectiveVoiceMode(config);
        await maybeSendTtsAfterReply(ctx, response, mode);
      } else {
        console.log(`   ⚠️  Agent returned empty response`);
        await ctx.reply("🤔 I didn't get a response. Please try again.");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      log.error(`Agent error (text): ${message}`);
      console.error("❌ Agent error:", err);

      if (message.includes("ECONNREFUSED")) {
        await ctx.reply(
          "❌ Cannot reach Player2 App.\n\n" +
          "Make sure the Player2 App is running at http://127.0.0.1:4315"
        );
      } else {
        await ctx.reply(
          `❌ Something went wrong:\n\`${message}\`\n\nPlease try again.`,
          { parse_mode: "Markdown" }
        ).catch(() => {
          // If the error message itself has bad Markdown chars
          return ctx.reply(`❌ Something went wrong: ${message}\n\nPlease try again.`);
        });
      }
    }
    });
  });

  // ── Voice message handler ──────────────────────────────────────
  // Downloads the voice .ogg from Telegram, transcribes it via
  // Player2's Whisper endpoint, then routes the text through the
  // same agent loop as typed messages. The transcription is
  // prepended to the reply so the user can verify dictation accuracy.
  bot.on("message:voice", async (ctx) => {
    console.log(`🎤 Voice message received (${ctx.message.voice.duration}s, ${ctx.message.voice.file_size ?? "?"} bytes)`);

    // Show "typing" while we download and transcribe
    await ctx.replyWithChatAction("typing");

    try {
      // ── Download voice file into memory ──────────────────────
      const file = await ctx.getFile();
      const filePath = file.file_path;
      if (!filePath) {
        await ctx.reply("❌ Couldn't retrieve the voice file from Telegram.");
        return;
      }

      const downloadUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${filePath}`;
      const downloadRes = await fetch(downloadUrl);
      if (!downloadRes.ok) {
        throw new Error(`Telegram file download failed: ${downloadRes.status}`);
      }
      const audioBuffer = Buffer.from(await downloadRes.arrayBuffer());
      console.log(`   → Downloaded ${audioBuffer.length} bytes from Telegram`);

      // ── Transcribe via Player2 Whisper ───────────────────────
      console.log(`   → Sending to Player2 Whisper STT...`);
      const transcript = await transcribeAudio(audioBuffer, "voice.ogg");

      if (!transcript) {
        await ctx.reply(
          "🎤 I received your voice message but couldn't make out any words. " +
          "Try speaking a bit louder or longer."
        );
        return;
      }

      console.log(`   ← Transcribed: "${transcript.substring(0, 80)}${transcript.length > 80 ? "..." : ""}"`);

      console.log(`   → Queueing transcription for agent loop...`);
      enqueueAgentJob(ctx.chat.id, async () => {
        await ctx.replyWithChatAction("typing");
        const response = await core.process(ctx.chat.id, transcript, {
          sendPendingApproval: async (promptText: string) => {
            await ctx.reply(promptText);
          },
        });
        console.log(`   ← Agent returned ${response.length} chars`);

        const fullReply = `🎤 *I heard:* "${transcript}"\n\n${response}`;

        if (fullReply.length <= 4096) {
          await ctx.reply(fullReply, { parse_mode: "Markdown" }).catch(() => {
            console.log(`   ⚠️  Markdown parse failed, falling back to plain text`);
            return ctx.reply(fullReply);
          });
        } else {
          const chunks = splitMessage(fullReply, 4096);
          for (const chunk of chunks) {
            await ctx.reply(chunk, { parse_mode: "Markdown" }).catch(() => {
              return ctx.reply(chunk);
            });
          }
        }
        console.log(`   ✓ Voice reply sent to Telegram`);

        const mode = await effectiveVoiceMode(config);
        await maybeSendTtsAfterReply(ctx, response, mode);
      });

    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      log.error(`Voice processing error: ${message}`);
      console.error("❌ Voice processing error:", err);

      if (message.includes("ECONNREFUSED")) {
        await ctx.reply(
          "❌ Cannot reach Player2 App for speech-to-text.\n\n" +
          "Make sure the Player2 App is running at http://127.0.0.1:4315"
        );
      } else {
        await ctx.reply(
          `❌ Voice processing failed:\n\`${message}\`\n\nPlease try again or send a text message.`,
          { parse_mode: "Markdown" }
        ).catch(() => {
          return ctx.reply(`❌ Voice processing failed: ${message}\n\nPlease try again or send a text message.`);
        });
      }
    }
  });

  return bot;
}

/**
 * Splits a long message into chunks at line boundaries.
 */
function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = maxLength;
    }
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}
