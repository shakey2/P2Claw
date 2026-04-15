# P2 Claw

A lean, secure personal AI agent powered by [Player2](https://player2.game), controlled entirely via Telegram. No web server, no exposed ports, no untrusted code.

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

### What You Need to Configure

Edit your `.env` file:

| Variable | Where to get it |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram → [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token |
| `TELEGRAM_ALLOWED_USER_IDS` | Telegram → [@userinfobot](https://t.me/userinfobot) → it replies with your numeric ID |
| `DEFAULT_VOICE_MODE` | Optional. `off` (default), `tg` (voice note after replies), or `pc` (speak via Player2 on this PC). Per-chat override: `/voice` |

**Important:** Never commit your `.env`. It contains secrets (Telegram bot token, allowed user IDs). This repo ignores `.env` by default via `.gitignore`.

That's it. The Player2 API connection is built in — just make sure the Player2 App is running.

---

## 🔒 Security

- **User whitelist** — Only responds to Telegram user IDs listed in your `.env`. Everyone else is silently ignored.
- **No web server** — Uses Telegram's long-polling. Zero open ports. Nothing to scan or attack.
- **Secrets in .env only** — Your Telegram token never appears in code or logs.
- **Local-first** — Everything runs on your machine. Messages are processed locally via Player2.

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

- **No HTTP server** — grammY polls Telegram's API directly
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
└── tools/
    ├── registry.ts       # Tool registration & dispatch
    └── get-current-time.ts   # Built-in: current time tool

scripts/
└── encode-key.ts         # Utility to encode your game key for embedding
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
