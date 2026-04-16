/**
 * P2 Claw — Telegram frontend (grammY).
 *
 * This wraps the existing bot wiring (`createBot`) behind the shared Frontend
 * interface so Telegram can be enabled/disabled at runtime.
 */

import type { Config } from "../config.js";
import type { Frontend } from "./frontend.js";
import { createBot } from "../bot.js";

export function createTelegramFrontend(config: Config): Frontend {
  const bot = createBot(config);

  const shutdown = () => {
    // Existing shutdown handler in index.ts will also call bot.stop(),
    // but we keep this idempotent for frontend.stop().
    bot.stop();
  };

  bot.catch((err) => {
    console.error("🔥 Bot error:", err);
  });

  return {
    start: async () => {
      await bot.start({
        // Avoid re-processing commands (e.g. /shutdown) left in the Telegram queue from a prior run.
        drop_pending_updates: true,
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
    },
    stop: async () => {
      shutdown();
    },
  };
}

