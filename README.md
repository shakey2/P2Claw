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
- High-risk tools open an **approval** panel on the chat page: enter your 6-digit TOTP and submit, or **Cancel**. Wrong codes show an error and you can retry until the challenge times out (120s).

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
- **TOTP approvals** — High-risk tools (e.g., `file_write`, shell commands via modules) ask for your authenticator code. **Telegram:** while a challenge is open, send **only the 6-digit code** (or `APPROVE <8-char-id> <code>`); those messages are handled **before** the AI sees them. **CLI and HTML:** same TOTP code-entry flow — the CLI prompts in the terminal; the loopback HTML UI shows an approval panel and posts codes to a separate `/api/approve` endpoint (not chat). Codes and approval prompts are never added to model context or chat history in any frontend. Set `TOTP_SECRET_BASE32` in `.env` (see `.env.example`).
- **File sandbox** — `file_read` / `file_write` / `file_list` are confined to `data/workspace/`. Hard bans prevent writes to `.env`, source tree, audit log, and `p2claw.db`. Reads are also banned from `.env` family files.
- **MCP isolation** — MCP servers run as separate processes with Core-owned supervision. Permissions come from the module manifest, not the server; undeclared tools are silently ignored.
- **Append-only audit log** — Every permission decision, approval outcome, subprocess execution, file operation, and MCP event is logged to `data/p2claw.audit.log` (JSONL, rotated at 5 MB). Arguments are hashed; secrets are never written.
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
| `/debug` | Developer diagnostics (requires `P2CLAW_DEV_MODE=true`). Subcommands: `list`, `modules`, `audit`, `call`, `perms`, `help`. Not visible when dev mode is off. |
| `/shutdown` | Gracefully stop the bot (saves DB, releases bot lock) |

## 🖥️ CLI Commands

When `UI_MODE=cli`, you can use:

| Command | Description |
|---|---|
| `/help` | Show CLI help |
| `/status` | Check Player2 health, joule balance, active profile |
| `/profile [name]` | List AI profiles or switch to one |
| `/memories` | List recent memories |
| `/compact` | Summarize older conversation history |
| `/clear` | Clear conversation history (memories unaffected) |
| `/cancel` | Abort a pending TOTP approval request |
| `/totp_status` | Whether `TOTP_SECRET_BASE32` is set |
| `/totp_enroll_help` | How to enroll an authenticator app |
| `/shutdown` | Graceful shutdown |
| `/exit` | Quit CLI |

When a high-risk tool runs, the CLI prints the approval summary and prompts for a **6-digit authenticator code** in the terminal (or type `CANCEL` at that prompt to abort). Wrong codes are non-fatal — you can retry within the **120-second** window until the challenge expires or is cancelled.

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
├── index.ts              # Boot sequence — the only entry point
├── config.ts             # Env loading, validation, typed Config object
├── security.ts           # Key resolution (env → embedded fallback)
├── player2.ts            # Player2/OpenAI SDK client + health ping
├── bot.ts                # Telegram bot wiring (frontend implementation)
├── agent.ts              # Agentic tool loop, memory injection, context pruning
├── ui/                   # Frontends (Telegram, CLI, loopback HTML)
│   ├── core.ts           # AgentCore wrapper for multiple frontends
│   ├── frontend.ts       # Frontend interface + hooks types
│   ├── telegram.ts       # Telegram frontend wrapper (optional at runtime)
│   ├── cli.ts            # CLI REPL frontend (optional at runtime)
│   ├── html.ts           # Loopback HTTP server + chat + config page (UI_MODE=html)
│   ├── debug.ts          # Shared /debug command handler (frontend-agnostic)
│   └── html/public/      # Static assets for the local HTML GUI
├── memory/
│   ├── index.ts          # Barrel export
│   ├── db.ts             # sql.js init, schema, debounced persistence
│   ├── store.ts          # Memory CRUD, FTS5 search, context extraction
│   └── module-store.ts   # Per-module KV store (backs ctx.memory in broker)
├── security/
│   ├── totp.ts           # RFC 6238 TOTP verify (crypto only)
│   └── approval.ts       # Pending challenges + TOTP-gated approval
├── tools/
│   ├── registry.ts       # Tool registration, dispatch, high-risk gate
│   ├── tool-types.ts     # Shared ToolDefinition (avoids import cycles)
│   ├── get-current-time.ts
│   ├── remember.ts       # Store a memory
│   ├── recall.ts         # Search memories (FTS5)
│   ├── forget.ts         # Delete a memory
│   ├── high-risk-demo.ts # TOTP gate exerciser (risk: high)
│   ├── file-read.ts      # Safe workspace file read (data/workspace)
│   ├── file-write.ts     # High-risk workspace file write (TOTP-gated)
│   └── file-list.ts      # Safe workspace directory listing
├── modules/              # Module framework (DESIGN.md §4.7)
│   ├── permissions.ts    # Fixed broad permission catalog (Core-owned)
│   ├── manifest.ts       # Strict manifest.json validator (inprocess + mcp)
│   ├── broker.ts         # Capability broker (ModuleContext factory)
│   ├── loader.ts         # Scans src/extensions/*, validates, registers tools
│   ├── audit.ts          # Append-only JSONL decision log (data/p2claw.audit.log)
│   ├── types.ts          # Shared Module / ModuleContext / ModuleTool types
│   ├── subprocess.ts     # Core subprocess execution (timeout, output cap, env allowlist)
│   ├── fs-policy.ts      # Core file-system sandbox + hard-ban policy
│   └── runtime-index.ts  # In-memory loaded-module index for dev-tools
├── mcp/                  # MCP bridge runtime (DESIGN.md §4.7)
│   ├── host.ts           # Core-owned MCP server host (lifecycle, crash restart)
│   ├── client.ts         # MCP stdio client wrapper (SDK-based)
│   ├── bridge.ts         # MCP-to-registry tool bridge
│   ├── registry.ts       # Active MCP host registry + shutdown helper
│   └── types.ts          # Shared MCP types (lifecycle, event entries)
├── extensions/           # First-party modules (allowlisted)
│   ├── demo-safe/        # Demo module using only safe permissions
│   ├── demo-high-risk/   # Demo module exercising real shell.execute via broker
│   ├── dev-tools/        # Developer diagnostics (gated by P2CLAW_DEV_MODE)
│   └── mcp-echo/         # MCP echo fixture (verification harness only)
└── types/
    └── sql.js.d.ts       # Type declarations for sql.js

data/
├── p2claw.db             # SQLite database (created at runtime)
├── p2claw.audit.log      # Append-only JSONL audit log (rotated at 5 MB)
├── workspace/            # Sandboxed file area for file_read/write/list tools
└── personality.md        # User-editable personality config

scripts/
├── encode-key.ts         # Utility to encode your game key for embedding
└── verify-modules.ts     # npm run verify — module framework integration check (90+ checks)
```

### Embedding the Player2 Game Key

End users should never need to deal with the game key. If for some reason you don't want to use my dev key, and do not intend to publish your own distribution with your own dev key. You must embed your dev key as follows to continue using player2 as the model service provider:

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
