# Historical design assessment (superseded)

- This temp note is **not current** and should not be treated as a live repo description.
- At minimum, two early findings below are now stale:
  - the repo now contains Cursor-related references in docs/temp artifacts, so "no Cursor mentions" is no longer reliable
  - the repo now includes a **loopback-only local HTML UI/server**, so "no web server / no open ports" is no longer accurate as written

## Earlier snapshot notes

## Design.md adherence (historical snapshot)
- **Architecture matches the module map**: the `src/` layout described in `DESIGN.md` exists (`index.ts`, `config.ts`, `security.ts`, `player2.ts`, `bot.ts`, `agent.ts`, `memory/*`, `tools/*`). `scripts/encode-key.ts` also exists.
- **No public/LAN web server** was the intent at the time of this note; the current repo now has a loopback-only local HTML UI/server.
- **TypeScript strict mode**: enabled in `tsconfig.json` (`"strict": true`).

## Concrete mismatches / likely “hallucinations” (docs vs repo)
### License is inconsistent across docs + package metadata
`DESIGN.md` states “Source Available … not MIT”:

```285:289:C:\P2Claw\DESIGN.md
## 7. Licensing

**Source Available** — The source code is publicly readable but not freely licensed for redistribution. The embedded Player2 Game Key is a shared application credential. Unauthorized redistribution or extraction of the key is prohibited.

> Note: This is not MIT/open source. The source is visible for transparency and auditability, but the distributed application includes proprietary credentials.
```

…but `package.json` declares MIT:

```18:24:C:\P2Claw\package.json
  "license": "MIT",
  "dependencies": {
    "dotenv": "^16.4.7",
    "grammy": "^1.35.0",
    "openai": "^4.85.0",
    "sql.js": "^1.14.1"
  },
```

…and there is also a plain `LICENSE` file that is standard MIT. `LICENSE.md` adds a “Player2 Revenue Clause” exception—so overall the licensing story is internally contradictory (and the MIT SPDX string is especially at odds with the “not MIT” statement).

### Roadmap vs implementation: Level 3 “Voice Output” is already partially implemented
`DESIGN.md` says Level 3 voice output is not done, but the code already includes:
- `/voice` command + voice mode routing in `src/bot.ts`
- a TTS call to Player2 in `src/player2.ts` (`generateSpeech(...)`)

For example, in `src/bot.ts` you can see voice mode and TTS invocation:

```95:112:C:\P2Claw\src\bot.ts
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
```

and `generateSpeech(...)` exists:

```226:269:C:\P2Claw\src\player2.ts
export async function generateSpeech(text: string, playInApp: boolean): Promise<string | null> {
  const payload = {
    text,
    play_in_app: playInApp,
    speed: 1.0
  };

  const res = await fetch(`${PLAYER2_BASE}/tts/speak`, {
    method: "POST",
    headers: { 
      "player2-game-key": _resolvedKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
  });
  // ...
}
```

So either the roadmap is stale, or the implementation jumped ahead.

### README command list is incomplete vs actual bot commands
`README.md` lists only `/start /status /profile /clear`, but `src/bot.ts` also implements `/setup`, `/cancel`, `/memories`, `/compact`, `/voice` (and likely more later in the file). This is a doc drift issue (not “hallucination” per se, but inaccurate documentation).

## Design/security concerns (implementation deviates from stated principles)
### “Secrets in .env only / never in logs” + privacy posture is weakened by logging
The bot logs message previews (user content) and identifiers:

```29:41:C:\P2Claw\src\bot.ts
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
```

and later:

```311:324:C:\P2Claw\src\bot.ts
    console.log(`💬 Processing message: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
    // ...
    const response = await processMessage(
      ctx.chat.id,
      text,
      config.botName,
      config.maxAgentIterations
    );
```

Additionally, `src/agent.ts` logs raw model output and the chosen model:

```261:267:C:\P2Claw\src\agent.ts
    const assistantMessage = choice.message;
    const rawContent = assistantMessage.content ?? "";
    const activeModel = response.model || "unknown";

    // ── NEW: Log the raw LLM output and active model so we can verify behavior
    console.log(`   🤖 [Model: ${activeModel}] Raw response: "${rawContent.replace(/\n/g, ' ').substring(0, 100)}${rawContent.length > 100 ? '...' : ''}"`);
```

And there is a **file logger** that writes to `data/p2claw.log`:

```1:6:C:\P2Claw\src\logger.ts
 * Writes structured log entries to data/p2claw.log alongside console output.
 * Designed for post-mortem debugging — when a user reports an issue, they
 * can share this log file instead of transcribing terminal output.
```

This doesn’t violate the “writes only to `data/`” idea, but it **does** create a realistic risk of logging sensitive user content (and potentially secrets the user pastes), which conflicts with the spirit of `DESIGN.md`’s privacy/security stance.

## Summary
- **Following `DESIGN.md` well**: overall architecture, strict TS, long-polling/no web server, max-iteration ceiling (25) in config, Player2 localhost integration, sql.js memory with FTS5 attempt.
- **Doc/implementation mismatches (“hallucinations” / drift)**: licensing story (Source Available vs MIT metadata/files), roadmap says voice output not done but TTS + `/voice` exist, README command list is incomplete.
- **Cursor-added files check**: no `cursor` mentions found and no obvious Cursor config files detected.

