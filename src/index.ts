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
import { createBot } from "./bot.js";
import { getToolCount } from "./tools/registry.js";
import { initDatabase, closeDatabase } from "./memory/index.js";

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

  // ── Step 10: Start Telegram bot ───────────────────────────────
  console.log(`\n🤖 Starting Telegram bot...`);
  console.log(`   ✓ Tools loaded: ${getToolCount()}`);

  const bot = createBot(config);

  // Graceful shutdown — save database before exiting
  const shutdown = () => {
    console.log("\n👋 Shutting down P2 Claw...");
    stopHealthPing();
    closeDatabase();
    console.log("   ✓ Database saved");
    bot.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Error handling for the bot
  bot.catch((err) => {
    console.error("🔥 Bot error:", err);
  });

  // Start long-polling
  await bot.start({
    onStart: (botInfo) => {
      console.log(`   ✓ Online as @${botInfo.username}`);
      console.log("");
      console.log("═══════════════════════════════════════════════════════════════");
      console.log(`  ${config.botName} is ready! Send a message on Telegram.`);
      console.log("  Press Ctrl+C to stop.");
      console.log("═══════════════════════════════════════════════════════════════");
      console.log("");
    },
  });
}

// ── Run ─────────────────────────────────────────────────────────
boot().catch((err) => {
  console.error("\n💀 Fatal error during boot:", err);
  process.exit(1);
});
