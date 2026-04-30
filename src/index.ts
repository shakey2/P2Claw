/**
 * P2 Claw — Entry point.
 *
 * Boot sequence: load config → Player2 credential (skippable in HTML setup mode)
 * → health / joules / smoke / profiles when client is live → SQLite → personality
 * → health ping → start frontend (Telegram, CLI, or loopback HTML).
 */

import { loadConfig } from "./config.js";
import { resolveApiCredential, validateCredential, isCredentialConfigured } from "./security.js";
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
import { loadModules, stopAllMcpHosts } from "./core/modules/loader.js";
import { initDatabase, closeDatabase } from "./memory/index.js";
import { readModuleMemory, writeModuleMemory } from "./memory/module-store.js";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { createTelegramFrontend } from "./ui/telegram.js";
import { createCliFrontend } from "./ui/cli.js";
import { createHtmlFrontend } from "./ui/html.js";
import type { Frontend } from "./ui/frontend.js";
import { registerGracefulShutdown } from "./graceful-shutdown.js";
import { drainPendingChallenges } from "./security/approval.js";
import {
  closeCoreSecurityDatabase,
  initCoreSecurityDatabase,
} from "./security/core-security-db.js";
import {
  clearSessionCapabilities,
  loadPersistentCapabilities,
} from "./security/capability-store.js";

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

  if (config.devMode) {
    console.warn("");
    console.warn("   ⚠️  ================================================");
    console.warn("   ⚠️  P2CLAW_DEV_MODE=true — developer diagnostics ON");
    console.warn("   ⚠️  Dev-tools module + /debug command are loaded.");
    console.warn("   ⚠️  Set P2CLAW_DEV_MODE=false for normal installs.");
    console.warn("   ⚠️  (DESIGN.md §4.7)");
    console.warn("   ⚠️  ================================================");
    console.warn("");
  }

  // Acquire early so a watcher restart can't overlap two listeners (Telegram / HTML).
  // CLI mode does not use Telegram polling and should not be locked.
  if (config.uiMode === "telegram" || config.uiMode === "html") {
    acquireBotLock();
  }

  // ── Step 2: Resolve API credential ────────────────────────────
  console.log("\n🔑 Resolving Player2 credentials...");
  const credential = resolveApiCredential(config.player2GameKey);
  const player2Live = isCredentialConfigured(credential);
  if (player2Live) {
    validateCredential(credential);
    initPlayer2(credential);
    console.log("   ✓ Credential validated");
    console.log("   ✓ Player2 client initialized");
  } else {
    validateCredential(credential);
  }

  // ── Step 4–7: Player2 checks (skip if no client) ───────────────
  if (player2Live) {
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

    try {
      const joules = await getJoules();
      console.log(`   ⚡ Joule balance: ${joules.joules.toLocaleString()}`);
      if (joules.patron_tier) {
        console.log(`   👑 Patron tier: ${joules.patron_tier}`);
      }
    } catch {
      console.warn("   ⚠️  Could not fetch joule balance");
    }

    console.log("\n🧪 Smoke-testing chat completions...");
    try {
      const smokeResult = await smokeTestCompletion();
      console.log(`   ✓ LLM responded: "${smokeResult}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`   ❌ Chat completion FAILED: ${msg}`);
      console.error("      This means LLM requests will not work.");
      console.error("      Check that Player2 is running and a model is selected.");
    }
  }

  // ── Step 7: Profiles ──────────────────────────────────────────
  if (player2Live && config.useProfiles) {
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

  // ── Step 8: Initialise database ───────────────────────────────
  console.log("\n🧠 Initialising memory database...");
  try {
    await initDatabase();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`   ❌ Database init failed: ${msg}`);
    console.error("      Memory features will not work.");
  }

  console.log("\n🔐 Initialising core security database...");
  try {
    await initCoreSecurityDatabase();
    const capabilityCount = loadPersistentCapabilities();
    console.log(
      `   ✓ Loaded ${capabilityCount} persisted capability grant${capabilityCount === 1 ? "" : "s"}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`   ❌ Core security database init failed: ${msg}`);
    console.error("      Persistent capability grants will not be available.");
  }

  // ── Step 9: Load personality ──────────────────────────────────
  console.log("\n🎭 Loading personality...");
  loadPersonality();

  // ── Step 10: Start health ping ─────────────────────────────────
  if (player2Live) {
    console.log("\n💓 Starting periodic health ping...");
    startHealthPing();
  }

  // ── Step 10b: Load first-party modules ────────────────────────
  console.log("\n🧩 Loading modules...");
  const moduleResult = await loadModules(
    {
      memory: {
        read: async (moduleId, key) => readModuleMemory(moduleId, key),
        write: async (moduleId, key, value) => {
          writeModuleMemory(moduleId, key, value);
        },
      },
    },
    {
      devMode: config.devMode,
      mcpCallTimeoutMs: config.mcpCallTimeoutMs,
    }
  );
  if (moduleResult.loaded.length === 0 && moduleResult.rejected.length === 0) {
    console.log("   ℹ️  No modules found in src/modules/");
  } else {
    for (const m of moduleResult.loaded) {
      console.log(`   ✓ ${m.id} (+${m.toolCount} tool${m.toolCount === 1 ? "" : "s"})`);
    }
    for (const r of moduleResult.rejected) {
      console.warn(`   ⚠️  Rejected ${r.folder}: [${r.code}] ${r.reason}`);
    }
    console.log(
      `   → ${moduleResult.loaded.length} loaded, ${moduleResult.rejected.length} rejected`
    );
  }

  // ── Step 11: Start frontend (Telegram, CLI, or HTML) ──────────
  console.log(`\n🤖 Starting frontend...`);
  console.log(`   ✓ Tools loaded: ${getToolCount()}`);

  const frontend: Frontend =
    config.uiMode === "cli"
      ? createCliFrontend(config)
      : config.uiMode === "html"
        ? createHtmlFrontend(config)
        : createTelegramFrontend(config);

  // Graceful shutdown — save database before exiting
  let shutdownStarted = false;
  const shutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    void (async () => {
      console.log("\n👋 Shutting down P2 Claw...");
      if (process.env.npm_lifecycle_event === "dev") {
        console.log(
          "   Under `npm run dev`, tsx may restart this process. Press Ctrl+C in the terminal to stop the watcher."
        );
      }
      stopHealthPing();
      const drained = drainPendingChallenges();
      if (drained > 0) {
        console.log(
          `   ✓ Drained ${drained} pending TOTP challenge${drained === 1 ? "" : "s"} (audit records written)`
        );
      }
      try {
        await stopAllMcpHosts();
        console.log("   ✓ MCP servers stopped");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`   ⚠️  Failed to stop MCP servers cleanly: ${message}`);
      }
      closeDatabase();
      console.log("   ✓ Database saved");
      const clearedCapabilities = clearSessionCapabilities();
      if (clearedCapabilities > 0) {
        console.log(
          `   ✓ Cleared ${clearedCapabilities} session capability grant${clearedCapabilities === 1 ? "" : "s"}`
        );
      }
      closeCoreSecurityDatabase();
      console.log("   ✓ Core security database saved");
      try {
        await frontend.stop();
      } catch {
        // best effort; proceed with process exit
      }
      if (config.uiMode === "telegram" || config.uiMode === "html") {
        releaseBotLock();
      }
      process.exit(0);
    })();
  };
  registerGracefulShutdown(shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", () => {
    if (config.uiMode === "telegram" || config.uiMode === "html") {
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
