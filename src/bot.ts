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
import type { Config } from "./config.js";
import { processMessage, clearHistory, getHistoryLength, setActiveProfile, getActiveProfile, compactHistory } from "./agent.js";
import { checkHealth, getJoules, listProfiles, transcribeAudio, generateSpeech } from "./player2.js";
import { getToolCount } from "./tools/registry.js";
import { listMemories, getMemoryCount, addMemory } from "./memory/index.js";
import { log } from "./logger.js";

/**
 * Creates and configures the Telegram bot.
 */
export function createBot(config: Config): Bot {
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



  // ── Voice & Setup State ──────────────────────────────────────
  const voiceMode = new Map<number, "off" | "tg" | "pc">();
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
      voiceMode.set(ctx.chat.id, args);
      await ctx.reply(`🎙️ Voice Mode set to: *${args}*`, { parse_mode: "Markdown" });
    } else {
      const current = voiceMode.get(ctx.chat.id) || "off";
      await ctx.reply(
        `🎙️ *Current Voice Mode*: ${current}\n\n` +
        `*Usage*: /voice <off | tg | pc>\n` +
        `  • \`off\`  : Text only (Default)\n` +
        `  • \`tg\`   : Ellie sends Voice Messages to Telegram\n` +
        `  • \`pc\`   : Audio plays aloud on host speakers`,
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
    const chatId = ctx.chat.id;
    const count = getMemoryCount(chatId);

    if (count === 0) {
      await ctx.reply(
        "🧠 No memories stored yet.\n\n" +
        "Tell me something and I'll remember it! " +
        'For example: "Remember that I prefer dark mode"'
      );
      return;
    }

    const memories = listMemories(chatId, undefined, 20);
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

  // ── Text message handler ────────────────────────────────────
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text) return;

    // Check if we are in the setup state sequence
    const currentState = setupState.get(ctx.chat.id);
    if (currentState !== undefined) {
      // Save memory as core
      addMemory(ctx.chat.id, `User answer to '${SETUP_QUESTIONS[currentState]}': ${text}`, "core");
      
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

    // Show "typing" indicator
    await ctx.replyWithChatAction("typing");

    try {
      console.log(`   → Sending to agent loop...`);
      const response = await processMessage(
        ctx.chat.id,
        text,
        config.botName,
        config.maxAgentIterations
      );
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

        // Handle possible voice output
        const mode = voiceMode.get(ctx.chat.id) || "off";
        if (mode !== "off") {
          await ctx.replyWithChatAction("record_voice");
          try {
            console.log(`   → Triggering TTS (mode: ${mode})`);
            const speechData = await generateSpeech(response, mode === "pc");
            if (mode === "tg" && speechData) {
              const buffer = Buffer.from(speechData, "base64");
              await ctx.replyWithVoice(new InputFile(buffer));
              console.log(`   ✓ Voice memo sent to Telegram`);
            }
          } catch (err: any) {
            if (err.status === 402 || (err.message && err.message.toLowerCase().includes("patron"))) {
               await ctx.reply("⚠️ *Voice Error*: The current AI voice is a premium ElevenLabs model requiring Patron status on Player2. Free users should switch to the 'Kokoro' voice in the Player2 App settings.", { parse_mode: "Markdown" });
            } else {
               console.error("❌ TTS Error:", err);
               await ctx.reply(`⚠️ *Voice Error*: ${err.message || "Failed to generate speech."}`, { parse_mode: "Markdown" });
            }
          }
        }
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

      // ── Route through agent loop (same as text) ─────────────
      // Keep typing indicator alive while the LLM processes
      await ctx.replyWithChatAction("typing");

      console.log(`   → Sending transcription to agent loop...`);
      const response = await processMessage(
        ctx.chat.id,
        transcript,
        config.botName,
        config.maxAgentIterations
      );
      console.log(`   ← Agent returned ${response.length} chars`);

      // Prepend transcription so user can verify dictation accuracy
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
