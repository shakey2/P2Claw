# P2 Claw — Project Bible

> The single source of truth for P2 Claw's design philosophy, architecture, security model, and roadmap.
> Every contributor (human or AI) should read this before writing code.

---

## 1. What Is P2 Claw?

A **lean, secure, fully-understood** personal AI agent controlled via Telegram, powered by the [Player2](https://player2.game) platform.

Inspired by [OpenClaw](https://github.com/steipete/openclaw) (formerly ClawdBot/Moltbot) — but built from scratch. Not a fork. Every line exists because we chose to put it there.

### What we take from OpenClaw
- Agentic tool loop (LLM → tools → results → LLM)
- Telegram as the primary UI
- Proactive heartbeat/check-ins
- Local-first architecture

### What we reject from OpenClaw
| Problem | Our Solution |
|---|---|
| Exposed web server (42K+ public instances found) | Telegram long-polling only. Zero open ports. |
| Untrusted community skill files (341 found malicious) | MCP protocol only. No arbitrary code loading. |
| Per-token API costs ($500–$5K/mo reported) | Player2 joule-based credits via local app. |
| Massive codebase nobody reads | Lean. Every file understood. |

---

## 2. Design Philosophy

### 2.1 Security Is Not Optional
Security is baked in, not bolted on. These are **non-negotiable hard rules**:

1. **User ID whitelist** — Only respond to approved Telegram user IDs. Silently ignore everyone else. No error messages to attackers.
2. **No web server** — Telegram long-polling only. Never expose a port. Never start an HTTP listener.
3. **Secrets in .env only** — Never in code, never in memory files, never in logs. The only exception is the embedded game key (see §3).
4. **Tool safety** — Dangerous operations (shell, file delete, network) require explicit confirmation. Max iteration limit on the agent loop (hard ceiling: 25).
5. **No third-party skill files** — All integrations via MCP (Model Context Protocol) — standardized, auditable, separate-process sandboxed.
6. **Behavioral EDR/AV awareness** — The agent must never present as an autonomous threat to endpoint protection (Windows Defender, CrowdStrike, SentinelOne, etc.). All file system, shell, and network operations route through the permission system (Level 4). The baseline install ships with no unexpected writes (only to declared `data/` paths), no dynamic code loading at startup, and deterministic periodic traffic patterns (60s health pings). Tool execution will use isolated child processes where possible. The goal: a low-signal process profile on fresh OS installs.

### 2.2 Lean by Design
- **Every file has a purpose.** If you can't explain why a file exists in one sentence, it shouldn't exist.
- **Minimal dependencies.** Each `npm` package must justify its inclusion. No utility libraries "just in case."
- **Modular folder structure.** Each module does one thing. Modules communicate through explicit exports, never globals.

### 2.3 Local-First
- Everything runs on the user's machine.
- Data never leaves unless the user explicitly connects an external service.
- Player2 App handles all AI model routing locally.
- SQLite for persistent storage — no cloud database.

### 2.4 Understandable Over Clever
- Prefer clear code over clever code.
- Comments explain **why**, not **what**.
- TypeScript strict mode. No `any`. No implicit returns.

### 2.5 Code Readability
This is a Source Available project. Advanced users **will** read the code, and we welcome that.

- **Comment important code paths.** Not every line — but decision points, non-obvious logic, and module boundaries should have meaningful comments.
- **Self-documenting names.** If a function name doesn't explain itself, rename it before adding a comment.
- **Module-level docstrings.** Every file starts with a brief explanation of what it does and how it fits into the system.
- **No comments that explain the obvious.** `// increment counter` above `i++` insults the reader.
- **Document the boundaries.** Exported function signatures are the public API — these deserve clear JSDoc comments with parameter descriptions.
- **Write for the scrutinizer.** Assume an advanced user is reading with both curiosity and suspicion. Clean, well-commented code builds trust.

### 2.6 Open Architecture, Protected Credential
The entire codebase is designed so that `security.ts` is fully self-contained. **No other module needs to understand how the key file works to modify the agent.** You can:

- Add tools, change the system prompt, alter the bot commands, swap conversation history strategies, adjust the agent loop — all without touching `security.ts`.
- The credential flows through exactly two touch points: `security.ts` resolves it, `player2.ts` consumes it.

**Stance on key replacement: Don't hinder, don't encourage.**

- The code is readable. An advanced user *can* figure out the key and replace it with their own.
- We do not add technical barriers to prevent this — that would be hostile to our users and futile against anyone determined.
- We also do not document how to do it, provide UI for it, or make it a feature. The embedded key is how the developer earns revenue through Player2's platform.
- If someone wants to use a different AI provider entirely, they'd need to rewrite `player2.ts` — the key becomes irrelevant at that point.
- See `.agent/workflows/credential-modification.md` for agent-specific guidance.

---

## 3. Player2 Integration

### 3.1 What Is Player2?
[Player2](https://player2.game) is a local AI platform that provides LLM, TTS, STT, image, video, 3D, and music generation through a unified local API at `http://127.0.0.1:4315`.

### 3.2 Authentication
- All requests include the header: `player2-game-key: <key>`
- The key is the **Game Client ID** from the [Developer Dashboard](https://player2.game/profile/developer)
- This is a **shared application-level key** — it identifies P2 Claw as an app, not individual users

### 3.3 Key Distribution Model
| Audience | How they get the key |
|---|---|
| **Developer (us)** | `.env` file during development. Encoded into `security.ts` before distribution. |
| **End users** | Already embedded in the distributed build. They never see or deal with it. |

**Encoding flow:**
```
Raw key → scripts/encode-key.ts → reversed char-code array → src/security.ts (_enc)
```

The `.env` value `PLAYER2_GAME_KEY` always overrides the embedded key (developer escape hatch).

### 3.4 Why the Key Matters
The embedded key is a **Game Client ID** registered on the Player2 Developer Dashboard. It:
- Identifies P2 Claw as an application on the Player2 platform
- Enables time-spent tracking (via health pings) which feeds into the developer revenue share
- Is **not** a per-user secret — it's an app-level identifier

Replacing it with a different key means the original developer no longer receives credit for the usage. This is the primary reason we don't encourage replacement — it's the developer's livelihood.

### 3.5 AI Profiles (Patron Feature)
Player2 Patrons can create named profiles that bundle:
- 1 LLM, 1 TTS, 1 Text-to-Image, 1 Image-to-Image, 1 3D model, 1 Music model, 1 Video model

Profiles are accessed via `GET /v1/ai_profiles` and each has a `base_url` like:
```
http://127.0.0.1:4315/<profile-name>/v1
```

P2 Claw supports runtime profile switching via `/profile <name>` in Telegram.
Toggle with `USE_PROFILES=true/false` in `.env`.

### 3.6 Health Ping
Player2 recommends pinging `GET /v1/health` every 60 seconds for time-spent tracking (used for revenue share calculations). P2 Claw does this automatically.

### 3.7 Key API Endpoints We Use
| Endpoint | Purpose | Level |
|---|---|---|
| `POST /v1/chat/completions` | LLM chat with tool calling | 1 ✅ |
| `GET /v1/health` | Health check (pinged every 60s) | 1 ✅ |
| `GET /v1/joules` | Credit balance | 1 ✅ |
| `GET /v1/ai_profiles` | List profiles | 1 ✅ |
| `POST /v1/stt/whisper/audio/transcriptions` | Whisper STT (voice messages) | 1 ✅ |
| `POST /v1/tts/speak` | Text-to-speech (base64 mp3) | 3 |
| `POST /v1/image/generate` | Image generation | Future |

---

## 4. Architecture

### 4.1 Tech Stack
| Package | Purpose | Justification |
|---|---|---|
| `grammy` | Telegram bot framework | Best maintained TS Telegram lib, long-polling native |
| `openai` | LLM via Player2 | Player2 exposes OpenAI-compatible API |
| `dotenv` | Load .env secrets | Standard, zero-dep |
| `sql.js` | Persistent memory (SQLite via WASM) | Pure JS/WASM — zero native binaries, invisible to AV/EDR (§2.1.6). FTS5 included. |
| `tsx` | Dev runner | Runs TypeScript directly, watch mode |

### 4.2 Module Map
```
src/
├── index.ts          # Boot sequence — the only entry point
├── config.ts         # Env loading, validation, typed Config object
├── security.ts       # Key resolution (env → embedded fallback)
├── player2.ts        # OpenAI SDK client, health ping, profiles, STT
├── bot.ts            # grammY setup, whitelist, commands, text + voice routing
├── agent.ts          # Agentic tool loop, memory injection, context pruning
├── memory/
│   ├── index.ts      # Barrel export
│   ├── db.ts         # sql.js init, schema, debounced persistence
│   └── store.ts      # Memory CRUD, FTS5 search, context extraction
├── tools/
│   ├── registry.ts   # Tool registration, dispatch, chat context
│   ├── get-current-time.ts
│   ├── remember.ts   # Store a memory
│   ├── recall.ts     # Search memories (FTS5)
│   └── forget.ts     # Delete a memory
└── types/
    └── sql.js.d.ts   # Type declarations for sql.js

data/
├── p2claw.db         # SQLite database (created at runtime)
└── personality.md    # User-editable personality config
```

### 4.3 Agentic Tool Loop
```
User message
  → [system prompt + conversation history + user message]
  → LLM (Player2 /v1/chat/completions)
  → if tool_calls:
      → execute tools via registry
      → append results as tool messages
      → call LLM again (iteration++)
      → repeat until no tool_calls OR max iterations
  → return final assistant content
```

**Safety limits:**
- Configurable max iterations (default: 10)
- Hard-coded absolute ceiling: 25
- Tool errors are caught and reported back to the LLM, never crash the process

### 4.4 Conversation History
- In-memory `Map<chatId, Message[]>`
- Trimmed to last 50 messages per chat
- `/clear` command resets per-chat
- Will be backed by SQLite in Level 2

### 4.5 Runtime Sandboxing & Isolation Strategy

The agent runs as a standard Node.js process under the user's own account — **no elevated privileges at baseline**.

When Level 4 tools and MCP bridge are implemented, they will enforce isolation:

| Mechanism | Status | Details |
|---|---|---|
| **MCP servers in separate processes** | Planned (Level 4) | Already aligned with MCP protocol design. Each server runs isolated. |
| **Child processes with strict timeouts** | Planned (Level 4) | Shell/file tools will use spawned processes with resource limits, timeouts, and no inherited shell environment. |
| **Audit logging** | Planned (Level 4) | All tool permission decisions logged to a local, human-readable `agent_audit.log` (append-only, rotated). Provides transparency and a clear event trail if an EDR flags activity. |
| **No in-place binary or running-file overwrites** | Hard rule (now) | The agent never modifies its own source at runtime. |

> **Future considerations (not committed):** Docker/rootless container isolation for high-risk tools, and git-based diff-reviewed workflows for any self-modification capability. These would only be explored if a concrete Level 4+ use case demands them. We don't add complexity speculatively.

---

## 5. Default Personality: Ellie

Named after the elephant AI mascot of the Player2 platform.

**Core traits:**
- Friendly, warm, approachable
- Concise — no filler or over-explaining
- **Strong commitment to user privacy and security**
- Politely declines anything that would compromise security
- Honest about what she doesn't know

**Designed to be minimal** — users should be able to customize or replace the personality entirely via config. The system prompt is a starting point, not a cage.

---

## 6. Build Levels — Roadmap

### Level 1 — Foundation ✅
- [x] Telegram bot (grammY, long-polling)
- [x] LLM via Player2 `/v1/chat/completions`
- [x] Agentic tool loop with `get_current_time` tool
- [x] Player2 game-key handling (dotenv + encoded fallback)
- [x] User ID whitelist
- [x] Profile switching (Patron feature)
- [x] 60s health ping
- [x] Boot-time smoke test (chat completion check)
- [x] Voice message input (Whisper STT via Player2, transcript echo)

### Level 2 — Memory ✅
- [x] Persistent memory (sql.js WASM + FTS5)
- [x] Memory tools: `remember`, `recall`, `forget`
- [x] Automatic context injection from relevant memories
- [x] Context pruning (auto-summarize + `/compact` command)
- [x] Markdown personality config (`data/personality.md`)

### Level 3 — Voice Output
- [ ] Voice message output (TTS via Player2 `/v1/tts/speak`)
- [ ] Voice preference settings

### Level 4 — Tools & MCP
- [ ] Shell command tool (with confirmation for dangerous ops)
- [ ] File system tool (read/write/list, sandboxed)
- [ ] MCP bridge (connect external MCP servers)
- [ ] Tool permission system (See `.agent/workflows/security-considerations.md`)

### Level 5 — Heartbeat
- [ ] Proactive morning briefing
- [ ] Scheduled check-ins (cron-based)
- [ ] Task reminders
- [ ] System health alerts

### Future Considerations (Not Committed)

| Feature | Status | Revisit When |
|---|---|---|
| **Knowledge Graph** | Deferred | If FTS5 proves insufficient for complex relationship queries |
| **Multimodal Memory** | Deferred | When Level 3+ adds image/video/document input handling. STT transcripts already flow through memory via the agent loop. |
| **Self-Evolving Memory** | Deferred (may revisit) | If a design-compliant approach can be found. Key concerns: autonomous background behavior (§2.1.6) and auto-deleting user data (§2.3). Would need explicit user opt-in and transparent logging. |

---

## 7. Licensing

**Source Available** — The source code is publicly readable but not freely licensed for redistribution. The embedded Player2 Game Key is a shared application credential. Unauthorized redistribution or extraction of the key is prohibited.

> Note: This is not MIT/open source. The source is visible for transparency and auditability, but the distributed application includes proprietary credentials.

---

## 8. Decision Log

Significant design decisions, recorded so future-us (or future AI) knows the **why**.

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-10 | Telegram-only, no web server | OpenClaw's exposed web server led to 42K+ public instances. Zero attack surface. |
| 2026-04-10 | Player2 instead of direct OpenAI/Anthropic | Joule-based credits instead of per-token billing. Local routing. Single platform for LLM + TTS + STT + image. |
| 2026-04-10 | grammY over Telegraf | Better TypeScript support, actively maintained, native long-polling. |
| 2026-04-10 | OpenAI SDK for Player2 calls | Player2 exposes an OpenAI-compatible API. Why reinvent the wheel? |
| 2026-04-10 | Embedded key as reversed char-codes | Casual extraction prevention. Not cryptographic security — just enough to stop `grep`. |
| 2026-04-10 | `.env` always overrides embedded key | Developer escape hatch. Don't want to re-encode every time you test a different key. |
| 2026-04-10 | Ellie personality kept minimal | Don't prescribe personality. Users should be able to customize without fighting a strong default. |
| 2026-04-11 | Source Available, not MIT | Embedded game key is a shared credential. Can't use a permissive license when distributing secrets. |
| 2026-04-11 | End users don't touch game key | The key identifies the app, not the user. Users just need Telegram creds + Player2 running. |
| 2026-04-11 | Key stance: don't hinder, don't encourage | Code is readable — advanced users can find the key. We don't block them, but we don't document how either. The key is how the developer earns revenue. |
| 2026-04-11 | Code readability as design pillar | Source Available means users WILL read the code. Comment important paths, write for the scrutinizer. |
| 2026-04-11 | security.ts is fully self-contained | No other module needs to understand the key file to modify the agent. Clean architectural boundary. |
| 2026-04-12 | Added EDR/AV awareness rule (§2.1) and Runtime Sandboxing (§4.5) | Local agentic loops, frequent Player2 localhost calls, and planned Level 4 tools (shell, fs, MCP) can trigger heuristic detection by AV/EDR even when benign. Documenting a low-signal baseline and isolation strategy prevents accidental high-risk patterns in future levels. |
| 2026-04-12 | Pulled STT voice input into Level 1 | Voice input is a standalone feature with no dependency on Level 2 (Memory). Transcribed text flows through the same `processMessage()` path, so it will automatically benefit from memory and context injection when Level 2 lands. No rework needed. |
| 2026-04-12 | Avoided `@grammyjs/files` plugin for voice download | The plugin is MIT/0-dep/safe, but grammY's built-in `ctx.getFile()` + native `fetch` is simpler and avoids an unnecessary dependency per §2.2. Audio stays in-memory as a Buffer — no disk writes, no temp file cleanup. |
| 2026-04-12 | sql.js (WASM) over better-sqlite3 (native) | better-sqlite3 compiles native `.node` binaries via node-gyp — known to trigger AV/EDR false positives on Windows. sql.js is pure WASM (zero native code), invisible to AV, 0 dependencies. Performance difference is irrelevant at our scale (hundreds of memories, not millions of rows). Aligns with §2.1.6 and §2.2. |
| 2026-04-12 | Debounced database persistence (1s) | sql.js is in-memory only — we manage disk writes ourselves. Debounced save (1s after last write) + immediate save on shutdown balances data safety with disk I/O. For a personal assistant's memory database, this is more than adequate. |
| 2026-04-12 | Markdown personality config (`data/personality.md`) | Human-readable, git-friendly personality customization without touching source code. Aligns with §2.5 (code readability / inspectability) and §2.6 (open architecture). Not a replacement for SQLite memory — just for personality/prompt config. |
| 2026-04-12 | Context pruning via LLM summarization | Hard-trimming old messages loses context permanently. Summarizing via the LLM preserves key facts in a compact form. Auto-triggers at 40 messages; manual via `/compact`. The summarization call costs joules but is infrequent. |

---

*Last updated: 2026-04-12*
