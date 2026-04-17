# P2 Claw

A lean, secure personal AI agent powered by [Player2](https://player2.game). Default UI is Telegram; optional **loopback-only** web chat lives at `http://127.0.0.1` (see `DESIGN.md` §2.1.2). No public web server, no untrusted skill loading.

> Inspired by the [OpenClaw](https://github.com/steipete/openclaw) project — rebuilt from scratch so every line is understood.

---

## 🚀 User Setup

### Prerequisites

1. **Player2 App** — Download from [player2.game](https://player2.game) and keep it running. It must be available at `http://127.0.0.1:4315`.
2. **Node.js** — v18 or later.

### Install & Run

```bash
# 1. Download or clone P2 Claw
git clone <repo-url>
cd P2Claw

# 2. Create your config file
cp .env.example .env

# 3. Edit .env with your Telegram details (see table below)

# 4. Install dependencies
npm install

# 5. Start the bot
npm run dev
```

### UI Mode: Telegram, CLI, or local HTML

By default, P2 Claw runs the Telegram frontend.

**CLI** — set:

```env
UI_MODE=cli
```

Then start as usual (interactive REPL). Audio features (STT/TTS) remain Telegram-only for now.
If you use `npm run dev`, it runs a watcher; that's great for development, but it may restart the process when files change. For CLI mode, `npm run start` is usually smoother:

```bash
npm run dev
```

Or:

```bash
npm run start
```

In CLI mode, type `/help` for commands.

**Local HTML** — set `UI_MODE=html`. The app listens on **loopback only** (default `127.0.0.1:3847`) and serves the full GUI from that same origin.

- Windows “double-click to use”: run `start.bat` in the repo root (starts P2 Claw and opens `http://127.0.0.1:3847/`).
- Chat is at `/` and config is at `/config`.

You can also launch CLI directly on Windows:

```bash
cli.bat
```

Or one-shot (non-interactive) with a message:

```bash
cli.bat "hello"
```

### What You Need to Configure

Edit your `.env` file:

| Variable | Where to get it |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram → [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token |
| `TELEGRAM_ALLOWED_USER_IDS` | Telegram → [@userinfobot](https://t.me/userinfobot) → it replies with your numeric ID |
| `DEFAULT_VOICE_MODE` | Optional. `off` (default), `tg` (voice note after replies), or `pc` (speak via Player2 on this PC). Per-chat override: `/voice` |
| `UI_MODE` | Optional. `telegram` (default), `cli`, or `html` (loopback web UI). |
| `HTML_UI_HOST` / `HTML_UI_PORT` | Optional. Loopback bind for `UI_MODE=html` (default `127.0.0.1` / `3847`). |
| `TOTP_SECRET_BASE32` | Optional until you use high-risk tools. RFC 6238 secret (Base32) shared with Google Authenticator / Aegis — same value as in the app. |

**Important:** Never commit your `.env`. It contains secrets (Telegram bot token, allowed user IDs). This repo ignores `.env` by default via `.gitignore`.

That's it. The Player2 API connection is built in — just make sure the Player2 App is running.

---

## 🔒 Security

- **User whitelist** — Only responds to Telegram user IDs listed in your `.env`. Everyone else is silently ignored.
- **No public web server** — Telegram uses long-polling by default, and the optional HTML UI binds to loopback only (`127.0.0.1` / `::1`). Nothing is exposed to the LAN or internet by default.
- **Secrets in .env only** — Your Telegram token never appears in code or logs.
- **Local-first** — Everything runs on your machine. Messages are processed locally via Player2.
- **Level 4 Phase 1 — TOTP approvals** — High-risk tools (demo: `high_risk_demo`) ask for your authenticator code. While a challenge is open, send **only the 6-digit code** in Telegram (or `APPROVE <8-char-id> <code>`). Those messages are handled **before** the AI sees them, so they are not added to model context or chat history. Set `TOTP_SECRET_BASE32` in `.env` (see `.env.example`). See [`.agent/workflows/security-considerations.md`](.agent/workflows/security-considerations.md) for why permission boundaries stay in the bot, not the LLM.
- **Never paste your Base32 secret into Telegram** — only the six-digit rotating code when the bot is waiting for approval.
- **No raw model output logging by default** — set `P2CLAW_LOG_RAW_MODEL=true` in `.env` to print a short raw response preview for debugging.

## 🤖 Bot Commands

| Command | Description |
|---|---|
| `/start` | Welcome message and bot info |
| `/status` | Check Player2 health, joule balance, active profile |
| `/profile` | List AI profiles or switch (`/profile <name>`) |
| `/setup` | Guided setup that stores a few “core” memories (your name, purpose, tone). Use `/cancel` to abort. |
| `/memories` | List stored memories (and how to forget one) |
| `/compact` | Summarize older conversation history to free context space |
| `/voice` | Configure voice output: `/voice off \| tg \| pc` (saved per chat; survives restarts) |
| `/clear` | Reset conversation history |
| `/cancel` | Cancel an in-progress `/setup` session |
| `/totp_status` | Whether `TOTP_SECRET_BASE32` is set (boolean only; never prints the secret) |
| `/totp_enroll_help` | How to enroll an authenticator app and use `APPROVE` messages |
| `/shutdown` | Gracefully stop the bot (saves DB, releases bot lock) |

## 🖥️ CLI Commands

When `UI_MODE=cli`, you can use:

| Command | Description |
|---|---|
| `/help` | Show CLI help |
| `/memories` | List recent memories |
| `/compact` | Summarize older conversation history |
| `/clear` | Clear conversation history (memories unaffected) |
| `/totp_status` | Whether `TOTP_SECRET_BASE32` is set |
| `/shutdown` | Graceful shutdown |
| `/exit` | Quit CLI |

### CLI one-shot mode (works without TTY)

If your terminal does not support interactive prompts (some IDE/Git Bash setups), you can run a single message and exit:

```bash
cli.bat "what is my current status?"
```

Or pipe stdin:

```bash
echo "summarize our last chat" | cli.bat
```

## 🎭 AI Profiles (Patron Feature)

If you're a Player2 Patron, you can create AI profiles in the Player2 App that bundle together:
- 1 LLM (chat model)
- 1 TTS (text-to-speech voice)
- 1 Text-to-image model
- 1 Image-to-image model
- 1 3D model generator
- 1 Music model
- 1 Video model

Enable profile switching by setting `USE_PROFILES=true` in your `.env`.

Switch at runtime via `/profile <name>` in Telegram.

---

## 🛠️ Developer Guide

This section is for developers building or modifying P2 Claw.

### Architecture

```
User (Telegram) ←→ grammY (long-polling) ←→ Agent Loop ←→ Player2 App (local)
                                                ↕
                                           Tool Registry
```

- **No public HTTP server** — Telegram uses long-polling; the optional HTML frontend is a loopback-only local server
- **Agentic loop** — LLM can call tools, inspect results, and iterate (capped at configurable max)
- **Player2 as gateway** — All AI models accessed through the local Player2 App at `127.0.0.1:4315`
- **60s health ping** — Periodically pings Player2 `/v1/health` for time-spent tracking

### Project Structure

```
src/
├── index.ts              # Boot sequence
├── config.ts             # Environment loading & validation
├── security.ts           # API credential resolution & protection
├── player2.ts            # Player2/OpenAI SDK client + health ping
├── bot.ts                # Telegram bot setup & message routing
├── agent.ts              # Agentic tool loop
├── ui/                   # Frontends (Telegram, CLI, loopback HTML)
│   ├── core.ts            # Shared agent core wrapper for frontends
│   ├── frontend.ts        # Frontend interface + hooks types
│   ├── telegram.ts        # Telegram frontend wrapper
│   ├── cli.ts             # CLI REPL frontend
│   ├── html.ts            # Loopback HTTP server + chat + config page
│   └── html/public/       # Static assets for the loopback HTML GUI
├── memory/
│   ├── index.ts          # Provider router + barrel export
│   ├── db.ts             # sql.js init, schema, debounced persistence
│   ├── store.ts          # Memory CRUD + FTS5 search
│   └── module-store.ts   # Per-module KV store (backs ctx.memory in broker)
├── security/
│   ├── totp.ts           # RFC 6238 verification (Node crypto)
│   └── approval.ts       # Pending challenges + TOTP gate
├── tools/
│   ├── registry.ts       # Tool registration, dispatch, high-risk TOTP gate
│   ├── tool-types.ts     # Shared ToolDefinition (avoids import cycles)
│   ├── get-current-time.ts
│   ├── remember.ts
│   ├── recall.ts
│   ├── forget.ts
│   └── high-risk-demo.ts # Stub high-risk tool (Level 4 Phase 1)
├── modules/              # Module framework (DESIGN.md §4.7)
│   ├── permissions.ts    # Fixed broad permission catalog
│   ├── manifest.ts       # Strict manifest.json validator
│   ├── broker.ts         # Capability broker (TOTP-gated)
│   ├── loader.ts         # Scans src/extensions/* and registers tools
│   ├── audit.ts          # Append-only JSONL decision log
│   └── types.ts          # Shared Module / ModuleContext / ModuleTool types
└── extensions/           # First-party modules (allowlisted)
    ├── demo-safe/        # Exercises safe primitives (memory + fs.read_public)
    └── demo-high-risk/   # Exercises TOTP gate (shell.execute stubbed)

scripts/
├── encode-key.ts         # Utility to encode your game key for embedding
└── verify-modules.ts     # npm run verify — module framework integration check
```

### Embedding the Player2 Game Key

End users should never need to deal with the game key. Before distributing, you must embed your real key:

1. **Get your Game Client ID** from the [Player2 Developer Dashboard](https://player2.game/profile/developer)

2. **Encode it:**
   ```bash
   npx tsx scripts/encode-key.ts YOUR_REAL_GAME_CLIENT_ID
   ```

3. **Copy the output array** and paste it into `src/security.ts`, replacing the `_enc` array.

4. **Test the build:**
   ```bash
   # Remove PLAYER2_GAME_KEY from your .env (or comment it out)
   npm run dev
   # Should boot normally using the embedded key
   ```

The `.env` value `PLAYER2_GAME_KEY` always overrides the embedded key — useful for testing with a different key during development.

### Developer .env Override

If you're actively developing and want to use a key different from the embedded one, uncomment the last line in `.env`:

```env
PLAYER2_GAME_KEY=your_dev_key_here
```

This is **not** needed for end users.

---

## 📜 License

Source-available — see `LICENSE`.
