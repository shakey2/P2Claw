/**
 * P2 Claw — Entry point.
 *
 * Boot sequence:
 *   1. Load and validate configuration
 *   2. Resolve and validate Player2 API credential
 *   3. Health-check the Player2 App
 *   4. Check joule balance
 *   5. Smoke-test chat completions
 *   6. Optionally list AI profiles
 *   7. Initialise SQLite database (memory system)
 *   8. Load personality config (data/personality.md)
 *   9. Start periodic health ping (every 60s)
 *  10. Start Telegram bot (long-polling)
 */

import { loadConfig } from "./config.js";
import { resolveApiCredential, validateCredential } from "./security.js";
import {
  initPlayer2,
  checkHealth,
  getJoules,
  listProfiles,
  smokeTestCompletion,
  startHealthPing,
  stopHealthPing,
} from "./player2.js";
import { setActiveProfile, loadPersonality } from "./agent.js";
import { getToolCount } from "./tools/registry.js";
import { initDatabase, closeDatabase } from "./memory/index.js";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { createTelegramFrontend } from "./ui/telegram.js";
import { createCliFrontend } from "./ui/cli.js";
import type { Frontend } from "./ui/frontend.js";
import { registerGracefulShutdown } from "./graceful-shutdown.js";

// ── Single-instance lock (prevents Telegram 409 conflict) ───────
const LOCK_PATH = join(process.cwd(), "data", "p2claw.bot.lock");

function processAlive(pid: number): boolean {
  try {
    // Signal 0: check existence without killing
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireBotLock(): void {
  const dir = dirname(LOCK_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (existsSync(LOCK_PATH)) {
    try {
      const raw = readFileSync(LOCK_PATH, "utf8").trim();
      const pid = parseInt(raw, 10);
      if (!isNaN(pid) && processAlive(pid)) {
        console.error(
          "\n╔══════════════════════════════════════════════════════════════╗\n" +
          "║  P2 CLAW — BOT ALREADY RUNNING                              ║\n" +
          "╚══════════════════════════════════════════════════════════════╝\n" +
          `\n  Another bot instance is already running (pid ${pid}).\n` +
          "  Stop it first (Ctrl+C in that window), then start again.\n"
        );
        process.exit(1);
      }
      // Stale lock (pid not alive)
      unlinkSync(LOCK_PATH);
    } catch {
      // If the lock is corrupt or unreadable, remove it (safe) and continue.
      try {
        unlinkSync(LOCK_PATH);
      } catch {
        /* ignore */
      }
    }
  }

  writeFileSync(LOCK_PATH, String(process.pid), "utf8");
}

function releaseBotLock(): void {
  try {
    if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH);
  } catch {
    /* ignore */
  }
}

async function boot(): Promise<void> {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║                                                              ║");
  console.log("║    🦞  P2 CLAW  v1.0.0                                      ║");
  console.log("║    Secure AI Agent · Powered by Player2                      ║");
  console.log("║                                                              ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");

  // ── Step 1: Load config ───────────────────────────────────────
  console.log("🔧 Loading configuration...");
  const config = loadConfig();
  console.log(`   ✓ Bot name: ${config.botName}`);
  console.log(`   ✓ Allowed users: ${config.allowedUserIds.join(", ")}`);
  console.log(`   ✓ Max agent iterations: ${config.maxAgentIterations}`);
  console.log(`   ✓ Profiles: ${config.useProfiles ? "Enabled" : "Disabled"}`);
  console.log(`   ✓ Default voice output: ${config.defaultVoiceMode} (per-chat: /voice)`);
  console.log(`   ✓ UI mode: ${config.uiMode}`);

  // Acquire early so a watcher restart can't overlap two long-pollers.
  // CLI mode does not use Telegram polling and should not be locked.
  if (config.uiMode === "telegram") {
    acquireBotLock();
  }

  // ── Step 2: Resolve API credential ────────────────────────────
  console.log("\n🔑 Resolving Player2 credentials...");
  const credential = resolveApiCredential(config.player2GameKey);
  validateCredential(credential);
  console.log("   ✓ Credential validated");

  // ── Step 3: Init Player2 client ───────────────────────────────
  initPlayer2(credential);
  console.log("   ✓ Player2 client initialized");

  // ── Step 4: Health check ──────────────────────────────────────
  console.log("\n🏥 Checking Player2 App health...");
  try {
    const health = await checkHealth();
    console.log(`   ✓ Player2 App online (v${health.client_version})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`   ⚠️  Player2 App is not reachable: ${msg}`);
    console.warn("      Make sure the Player2 App is running at http://127.0.0.1:4315");
    console.warn("      The bot will start but LLM requests will fail until Player2 is available.");
  }

  // ── Step 5: Joule balance ─────────────────────────────────────
  try {
    const joules = await getJoules();
    console.log(`   ⚡ Joule balance: ${joules.joules.toLocaleString()}`);
    if (joules.patron_tier) {
      console.log(`   👑 Patron tier: ${joules.patron_tier}`);
    }
  } catch {
    console.warn("   ⚠️  Could not fetch joule balance");
  }

  // ── Step 6: Chat completion smoke test ────────────────────────
  console.log("\n🧪 Smoke-testing chat completions...");
  try {
    const smokeResult = await smokeTestCompletion();
    console.log(`   ✓ LLM responded: "${smokeResult}"`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`   ❌ Chat completion FAILED: ${msg}`);
    console.error("      This means LLM requests will not work.");
    console.error("      Check that Player2 is running and a model is selected.");
    // Don't crash — let the bot start so the user can see /status
  }

  // ── Step 7: Profiles ──────────────────────────────────────────
  if (config.useProfiles) {
    console.log("\n🎭 Loading AI profiles...");
    try {
      const profiles = await listProfiles();
      if (profiles.length > 0) {
        console.log(`   ✓ Found ${profiles.length} profile(s):`);
        for (const p of profiles) {
          console.log(`     • ${p.name} → ${p.base_url}`);
        }

        // Set default profile if configured
        if (config.defaultProfile) {
          const found = profiles.find(
            (p) => p.name.toLowerCase() === config.defaultProfile.toLowerCase()
          );
          if (found) {
            setActiveProfile(found.name);
            console.log(`   ✓ Active profile: ${found.name}`);
          } else {
            console.warn(`   ⚠️  Default profile "${config.defaultProfile}" not found`);
          }
        }
      } else {
        console.log("   ℹ️  No profiles configured in Player2 App");
      }
    } catch {
      console.warn("   ⚠️  Could not fetch profiles");
    }
  }

  // ── Step 7: Initialise database ───────────────────────────────
  console.log("\n🧠 Initialising memory database...");
  try {
    await initDatabase();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`   ❌ Database init failed: ${msg}`);
    console.error("      Memory features will not work.");
  }

  // ── Step 8: Load personality ──────────────────────────────────
  console.log("\n🎭 Loading personality...");
  loadPersonality();

  // ── Step 9: Start health ping ─────────────────────────────────
  console.log("\n💓 Starting periodic health ping...");
  startHealthPing();

  // ── Step 10: Start frontend (Telegram or CLI) ─────────────────
  console.log(`\n🤖 Starting frontend...`);
  console.log(`   ✓ Tools loaded: ${getToolCount()}`);

  const frontend: Frontend =
    config.uiMode === "cli"
      ? createCliFrontend(config)
      : createTelegramFrontend(config);

  // Graceful shutdown — save database before exiting
  let shutdownStarted = false;
  const shutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.log("\n👋 Shutting down P2 Claw...");
    if (process.env.npm_lifecycle_event === "dev") {
      console.log(
        "   Under `npm run dev`, tsx may restart this process. Press Ctrl+C in the terminal to stop the watcher."
      );
    }
    stopHealthPing();
    closeDatabase();
    console.log("   ✓ Database saved");
    void frontend.stop();
    if (config.uiMode === "telegram") {
      releaseBotLock();
    }
    process.exit(0);
  };
  registerGracefulShutdown(shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", () => {
    if (config.uiMode === "telegram") {
      releaseBotLock();
    }
  });

  await frontend.start();
}

// ── Run ─────────────────────────────────────────────────────────
boot().catch((err) => {
  console.error("\n💀 Fatal error during boot:", err);
  process.exit(1);
});
