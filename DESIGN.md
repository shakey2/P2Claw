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
| Publicly reachable web server (42K+ public instances found) | Telegram long-polling by default; optional **loopback-only** local HTML UI (§2.1, §4.6) — never bind `0.0.0.0` for the GUI. |
| Untrusted community skill files (341 found malicious) | MCP protocol only. No arbitrary code loading. |
| Per-token API costs ($500–$5K/mo reported) | Player2 joule-based credits via local app. |
| Massive codebase nobody reads | Lean. Every file understood. |

---

## 2. Design Philosophy

### 2.1 Security Is Not Optional
Security is baked in, not bolted on. These are **non-negotiable hard rules**:

1. **User ID whitelist** — Only respond to approved Telegram user IDs. Silently ignore everyone else. No error messages to attackers.
2. **No remotely reachable HTTP listener** — Default UI is Telegram long-polling (no inbound network surface). **Bounded exception:** the optional **local HTML GUI** may start an HTTP server bound **only to loopback** (`127.0.0.1` or `::1`, never `0.0.0.0` / all interfaces). This exists so everyday users get a friendly chat + config flow without CLI or exposing a port to the LAN or internet. It is not a public web app; it is the same trust model as opening Player2’s localhost Swagger page in a browser.
3. **Secrets in .env only** — Never in code, never in memory files, never in logs. The only exception is the embedded game key (see §3).
4. **Tool safety** — Dangerous operations (shell, file delete, network) require explicit confirmation. Max iteration limit on the agent loop (hard ceiling: 25).
5. **No third-party skill files** — All integrations via MCP (Model Context Protocol) — standardized, auditable, separate-process sandboxed.
6. **Behavioral EDR/AV awareness** — The agent must never present as an autonomous threat to endpoint protection (Windows Defender, CrowdStrike, SentinelOne, etc.). All file system, shell, and network operations route through the permission system (Level 4). The baseline install ships with no unexpected writes (only to declared `data/` paths), no dynamic code loading at startup, and deterministic periodic traffic patterns (60s health pings). Tool execution will use isolated child processes where possible. The goal: a low-signal process profile on fresh OS installs.

*(Rules 3–6 above are unchanged by the loopback HTML GUI; do not treat §2.1.2 as permission to expose a server on the LAN or WAN.)*

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

### 2.7 Core memory vs optional semantic (RAG) modules

Core ships with **persistent memory** (sql.js + FTS5): lexical search, CRUD tools, and context injection. That preserves **minimal dependencies**, **local-first** storage, and alignment with §2.2 and AV/EDR posture (§4.1).

**Honest limit:** FTS-style retrieval is not full **semantic** recall. Strong conversational memory usually needs **embeddings and vector retrieval** (often plus chunking, reranking, and ongoing maintenance). Those approaches frequently imply **extra dependencies** (embedding runtimes, native vector libraries) and/or **networked or hosted** pieces (embedding APIs, managed databases) — tradeoffs against the strictest lean + local-only defaults.

**Product stance:** keep the current core memory in the **base package** as the always-available, inspectable baseline. **Recommend** (not require) one or more **optional RAG / semantic memory packages** for users who want that quality bar. Each optional package must document **dependencies**, **where data lives**, **what leaves the machine** (if anything), and **what trust boundaries change**.

### 2.8 Extensibility & optional modules

Optional capability stays **explicit, auditable, and user-chosen** — consistent with §2.1 (no arbitrary community skill files; MCP for untrusted or heavy integrations).

- **Preference order:** **MCP** and **separate processes** for most third-party integrations; small **first-party** optional modules use a documented layout (see module map).
- **Registration:** optional features declare themselves through a **small, typed surface** (e.g. one registration path consumed at boot) — not scattered import side-effects across the tree.
- **Stable surfaces for extensions:** `tools/registry`, `ToolDefinition` / `tool-types.ts`, `Frontend` / `ui/core` — **not** `security.ts` or credential plumbing unless the change is intentionally security-scoped (rare).
- **LLM / tool surface:** do not grow the **visible tool set** without bounds on every request. Prefer **namespacing**, **profiles or toggles** that enable tool subsets, and/or **MCP** so large optional stacks stay off the default tool list. Enabling an optional module **widens** confusion and attack surface only when the user turns it on.
- **Discoverability:** each extension includes a **module-level header** (§2.5) and a **one-line entry** in the module map when it is non-experimental.

**AI-assisted development:** when adding a **top-level** area, update the module map; prefer **vertical slices** (one folder per feature); keep files within a **soft size band** when practical (guidance: [docs/DESIGN_DOC_SPLITTING.md](docs/DESIGN_DOC_SPLITTING.md)) so humans and coding agents can load whole units.

### 2.9 Maintaining this document

`DESIGN.md` should remain the **index of truth**, not an unbounded dump of every table and story. If it becomes hard to navigate or expensive to load in tools, **move depth** into `docs/` and link back. See [docs/DESIGN_DOC_SPLITTING.md](docs/DESIGN_DOC_SPLITTING.md) for **when to split** and a **practical pattern** (thin core + linked deep dives).

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
| `POST /v1/tts/speak` | Text-to-speech (base64 mp3) | 3 ✅ |
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
├── bot.ts            # Telegram bot wiring (frontend implementation)
├── agent.ts          # Agentic tool loop, memory injection, context pruning
├── ui/
│   ├── frontend.ts   # Frontend interface + hooks types
│   ├── core.ts       # AgentCore wrapper for multiple frontends
│   ├── telegram.ts   # Telegram frontend wrapper (optional at runtime)
│   ├── cli.ts        # CLI REPL frontend (optional at runtime)
│   ├── html.ts       # Loopback HTTP server + chat + config page (UI_MODE=html)
│   ├── debug.ts      # Shared /debug command handler (frontend-agnostic)
│   └── html/public/  # Static assets for the local HTML GUI
├── memory/
│   ├── index.ts      # Barrel export
│   ├── db.ts         # sql.js init, schema, debounced persistence
│   ├── store.ts      # Memory CRUD, FTS5 search, context extraction
│   └── module-store.ts # Per-module KV store (backs ctx.memory in broker)
├── security/
│   ├── totp.ts       # RFC 6238 TOTP verify (crypto only)
│   └── approval.ts   # Pending challenges + TOTP-gated approval
├── tools/
│   ├── registry.ts   # Tool registration, dispatch, high-risk gate
│   ├── tool-types.ts # Shared ToolDefinition (avoids import cycles)
│   ├── get-current-time.ts
│   ├── remember.ts   # Store a memory
│   ├── recall.ts     # Search memories (FTS5)
│   ├── forget.ts     # Delete a memory
│   ├── high-risk-demo.ts  # TOTP gate exerciser (risk: high)
│   ├── file-read.ts  # Safe workspace file read (data/workspace)
│   ├── file-write.ts # High-risk workspace file write (TOTP-gated)
│   └── file-list.ts  # Safe workspace directory listing
├── modules/          # Module framework — §4.7
│   ├── permissions.ts # Fixed broad permission catalog (Core-owned)
│   ├── manifest.ts    # Strict manifest.json validator (inprocess + mcp)
│   ├── broker.ts      # Capability broker (ModuleContext factory)
│   ├── loader.ts      # Scans src/extensions/*, validates, registers tools
│   ├── audit.ts       # Append-only JSONL decision log (data/p2claw.audit.log)
│   ├── types.ts       # Shared Module / ModuleContext / ModuleTool types
│   ├── subprocess.ts  # Core subprocess execution (timeout, output cap, env allowlist)
│   ├── fs-policy.ts   # Core file-system sandbox + hard-ban policy
│   └── runtime-index.ts # In-memory loaded-module index for dev-tools introspection
├── mcp/              # MCP bridge runtime — §4.7
│   ├── host.ts       # Core-owned MCP server host (lifecycle, crash restart)
│   ├── client.ts     # MCP stdio client wrapper (SDK-based)
│   ├── bridge.ts     # MCP-to-registry tool bridge
│   ├── registry.ts   # Active MCP host registry + shutdown helper
│   └── types.ts      # Shared MCP types (lifecycle, event entries)
├── extensions/       # First-party modules — manifest.json + entry (§2.8, §4.7)
│   ├── demo-safe/         # Demo module using only safe permissions
│   ├── demo-high-risk/    # Demo module exercising real shell.execute via broker
│   ├── dev-tools/         # Developer diagnostics (gated by P2CLAW_DEV_MODE)
│   └── mcp-echo/          # MCP echo fixture (verification harness only)
└── types/
    └── sql.js.d.ts   # Type declarations for sql.js

data/
├── p2claw.db         # SQLite database (created at runtime)
├── p2claw.audit.log  # Append-only JSONL audit log (rotated at 5 MB)
├── workspace/        # Sandboxed file area for file_read/write/list tools
└── personality.md    # User-editable personality config
```

*Packaged optional modules (npm or local) register via the §2.8 surfaces; MCP servers run out-of-process with Core-owned permissions.*

### 4.6 Frontends (Telegram optional)

P2 Claw supports multiple UI surfaces by keeping the agent loop single-sourced and implementing thin frontends:

- **Telegram frontend** (default): grammY long-polling + audio features (STT/TTS).
- **CLI frontend**: local REPL for power users/devs.
- **HTML frontend** (`UI_MODE=html`): **loopback-only** HTTP server (see §2.1.2) serving a local chat UI. Binds `HTML_UI_HOST` / `HTML_UI_PORT` (defaults `127.0.0.1` / `3847`). Same `Frontend` interface + `createAgentCore`; no remote exposure.
- The HTML GUI is fully server-hosted on localhost (`/` for chat, `/config` for settings). No `file://` shell is used.

Runtime selection is via `UI_MODE` (`telegram`, `cli`, or `html`). The intent is: new features land in the **core** once, and each frontend only handles input/output/UX.

### 4.7 Module framework (Phase 1)

Optional capabilities and tools register through a strict module framework so Core remains the only entity that reaches dangerous primitives (shell, fs, net, credentials).

**Trust model.** The framework supports two runtimes: **in-process** (`runtime: "inprocess"`) for first-party modules from a hardcoded allowlist, and **MCP** (`runtime: "mcp"`) for out-of-process MCP stdio servers. In-process modules are a **code-review** trust boundary, not an OS sandbox. MCP modules run in separate child processes with Core-owned supervision (startup timeout, crash-restart, call-level timeouts). The `firstParty: true` manifest flag is a required informational marker, **not** a security claim — the `FIRST_PARTY_ALLOWLIST` map (which binds each allowed folder to a specific reverse-DNS id) plus the capability broker's permission and TOTP gates are the authoritative boundary.

**Fixed permission catalog.** Core owns a fixed set of 11 broad permission categories (`time.now`, `log.info`, `memory.read`, `memory.write`, `fs.read_public`, `fs.read_private`, `fs.write_any`, `shell.execute`, `process.spawn`, `net.outbound`, `credentials.read`). Each is labelled `safe` or `high`. Modules cannot declare custom permissions — adding a category requires a Core release. See [src/modules/permissions.ts](src/modules/permissions.ts).

**Manifest.** Each module ships a `manifest.json` validated in [src/modules/manifest.ts](src/modules/manifest.ts): reverse-DNS id, semver version, `runtime: "inprocess"` or `"mcp"`, `firstParty: true` (the module's folder name must be a key in `FIRST_PARTY_ALLOWLIST` **and** `manifest.id` must equal the reverse-DNS id that folder is bound to — this folder->id binding prevents a rename-and-swap spoof of first-party identity), permissions must be a subset of the catalog, and each tool's `requires` must be a subset of the module's declared permissions. MCP manifests additionally declare a `mcp` config block (command, args, startup timeout, restart policy, optional env) validated for shell-metacharacter injection and secret-passthrough bans.

**Capability broker.** Modules never import Node builtins directly. The loader hands each module a typed `ModuleContext` ([src/modules/broker.ts](src/modules/broker.ts), [src/modules/types.ts](src/modules/types.ts)) whose methods each (1) verify the caller's manifest declared the matching permission, (2) gate high-risk permissions through the existing TOTP approval path ([src/security/approval.ts](src/security/approval.ts)), (3) write a decision to the append-only audit log, and (4) only then dispatch the primitive. The **safe** primitives (`log.info`, `time.now`, `memory.read/write`, `fs.read_public`) are real: `memory.*` is backed by the `module_memory` SQLite table and namespaced to the caller's module id ([src/memory/module-store.ts](src/memory/module-store.ts)); `fs.read_public` is scoped to `data/public/<moduleId>/` with path-containment and a 1 MiB read cap. The **high-risk** primitives `shell.execute` and `process.spawn` dispatch real subprocess execution via [src/modules/subprocess.ts](src/modules/subprocess.ts) (bounded timeout, output cap, env allowlist); `fs.read_private` and `fs.write_any` dispatch real file I/O enforced by [src/modules/fs-policy.ts](src/modules/fs-policy.ts) (hard bans on `.env`, source tree, audit log, `p2claw.db`; size caps). `net.outbound` and `credentials.read` remain gate-only stubs — no current module needs raw in-process HTTP or credential access, and real implementations would require URL allowlisting / response-size policy and extreme capability-escalation justification respectively.

**Tool integration.** Module-contributed tools are registered through the existing tools registry with `ownerModuleId` + `requiredPermissions`. [src/tools/registry.ts](src/tools/registry.ts) derives an effective risk (any high-risk permission promotes the tool to `risk: "high"`), runs the one-shot TOTP approval for the whole tool call, and wraps the handler in `runWithGrants(...)` so broker methods inside the handler see those permissions as pre-approved — no double prompting per LLM tool invocation. Broker calls made outside a tool-call context are refused for high-risk permissions. MCP-contributed tools are bridged through [src/mcp/bridge.ts](src/mcp/bridge.ts): the manifest declares permitted tools and their `requires`; Core bridges only those, ignoring any undeclared tools the server reports.

**Audit log.** [src/modules/audit.ts](src/modules/audit.ts) writes structured JSONL records to `data/p2claw.audit.log` (size-rotated at 5 MB). Record kinds: permission decisions, approval events, subprocess events, file-system events, MCP lifecycle/tool events, and debug invocations. Arguments are SHA-256 hashed; only a short redacted summary is logged alongside the decision.

**Explicit non-goals (current):** third-party module marketplace, "allow once / this session / always allow" policy rules, per-action whitelisting matchers, module install UI, hot-reload.

**Developer diagnostics (dev mode).** `P2CLAW_DEV_MODE` (boolean env var, default `false`) gates an in-tree `dev-tools` module (`com.p2claw.dev-tools`) and a `/debug` slash command in every frontend (Telegram, CLI, HTML). When dev mode is off, the loader skips `src/extensions/dev-tools/` entirely and each frontend treats `/debug` as an unknown command — the feature's existence is not leaked on normal installs. When dev mode is on, the LLM sees four read-style tools (`debug_list_tools`, `debug_inspect_module`, `debug_tail_audit`, `debug_call_tool`) and the developer can type `/debug <subcommand>` to bypass the LLM entirely; both paths go through the existing registry, capability broker, TOTP gate, and audit pipeline. `debug_call_tool` declares no permissions of its own so its effective risk stays `safe`; the **target** tool's risk continues to control whether TOTP is required on re-entry into `executeTool`. Self-recursion and nested debug calls are rejected. Every top-level debug invocation writes an explicit `kind: "debug_invocation"` record into the same JSONL audit file alongside the broker's permission decisions. Dev mode does **not** relax any security gate.

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
- Auto-summarization at 40 messages; manual via `/compact`

### 4.5 Runtime Sandboxing & Isolation Strategy

The agent runs as a standard Node.js process under the user's own account — **no elevated privileges at baseline**.

Level 4 tools and MCP bridge enforce isolation:

| Mechanism | Status | Details |
|---|---|---|
| **MCP servers in separate processes** | Live (Level 4) | Each MCP server runs as a supervised child process with startup timeout, crash-restart with backoff, and call-level timeouts. Permissions come from the manifest, not the server. |
| **Child processes with strict timeouts** | Live (Level 4) | `shell.execute` and `process.spawn` use `child_process.spawn` with 10s default / 60s max timeout, 64 KiB output caps, and an allowlisted environment (no credential leak to children). |
| **Audit logging** | Live (full coverage) | Permission decisions, subprocess events, file-system events, MCP lifecycle/tool events, approval outcomes, and debug invocations are all written to the local JSONL audit log at `data/p2claw.audit.log` (append-only, rotated at 5 MB). |
| **No in-place binary or running-file overwrites** | Hard rule (now) | The agent never modifies its own source at runtime. File-system hard bans prevent writes to `src/`, `dist/`, `scripts/`, `.env`, `p2claw.db`, and the audit log. |

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

## Agent automation rules (must follow)

- **No rogue PIDs**: if you (human or AI) start `npm run dev` / any watcher during a task, **you must stop it before summarizing or ending the task**. The user should never be left cleaning up background Node processes.
- **Use the cleaner**: run `npm run dev:clean` at the end of any task that may have spawned P2 Claw dev processes (kills P2 Claw `tsx watch src/index.ts` processes; does not start the bot).
- **Keep `.env` aligned**: whenever you change `.env.example`, run `npm run env:sync` to regenerate `.env` from the updated example **while preserving existing values**. This avoids forcing the user to re-enter credentials or hunt for reordered keys.
- **Always typecheck**: run `npm run build` after substantive edits.

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

### Level 3 — Voice Output ✅
- [x] Voice message output (TTS via Player2 `/v1/tts/speak`)
- [x] Voice preference settings (per-chat persistence in SQLite + `DEFAULT_VOICE_MODE` in `.env`)

### Level 4 — Tools & MCP ✅
- [x] **Phase 1 (foundation):** RFC 6238 TOTP in `.env` (`TOTP_SECRET_BASE32`), short-lived approval challenges with payload binding, Telegram `APPROVE <challengeId> <6-digit-code>` handled in `bot.ts` before the agent (codes never reach the LLM). Stub tool `high_risk_demo` exercises the high-risk path.
- [x] Shell command tool (real subprocess execution via `child_process.spawn` with 10s default / 60s max timeout, 64 KiB output caps, env allowlist, TOTP-gated approval, subprocess audit events — see `src/modules/subprocess.ts`, `src/modules/broker.ts`.)
- [x] File system tool (`file_read` / `file_write` / `file_list` sandboxed to `data/workspace/`; hard bans on `.env`, source tree, audit log, `p2claw.db`; `file_write` is high-risk / TOTP-gated; broker `fs.read_private` / `fs.write_any` also real with policy enforcement — see `src/modules/fs-policy.ts`.)
- [x] MCP bridge (Core-owned MCP stdio host with startup timeout, crash-restart with backoff, call-level timeouts, protocol mismatch detection; manifest-declared tools bridged to registry with manifest-sourced permissions; `mcp_lifecycle` and `mcp_event` audit records — see `src/mcp/`.)
- [x] Tool permission system (full manifest / policy surface — fixed Core-owned permission catalog, strict manifest validation, broker-enforced permission checks, effective risk derivation, one-shot TOTP approval, append-only audit, and real subprocess/fs policy surfaces are in place. `net.outbound` and `credentials.read` remain gate-only stubs until a concrete need justifies their dispatch design.)
- [x] Out-of-band 2FA (CLI terminal prompt and HTML approval panel + `/api/approve` endpoint; same TOTP code-entry flow across all frontends; non-terminal bad-code retry within 120s TTL; codes never enter LLM context — see decision log 2026-04-19.)
- [x] Local HTML GUI (loopback HTTP, chat + config page) — `UI_MODE=html`; see §4.6
- [x] Modular Frontends (CLI/HTML-only installs are first-class; agent core single-sourced via `createAgentCore` for Telegram, CLI, and HTML; shared `/debug` tail parsing; CLI parity commands; HTML parity APIs + richer status — see decision log 2026-04-19.)

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

**Source-Available** — This project is not MIT/open source. The source is visible for transparency and auditability.

The canonical license text is in `LICENSE`. In particular, it includes a **Player2 key restriction** intended to prevent redistributing a Player2-connected build that swaps out the embedded Player2 developer attribution key stored in `src/security.ts` (`_enc`).

---

## 8. Decision Log

Significant design decisions, recorded so future-us (or future AI) knows the **why**.

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-10 | Telegram-first, no public web server | OpenClaw's exposed web server led to 42K+ public instances. Keep the default posture at zero remotely reachable attack surface; later loopback-only HTML remains a bounded local exception. |
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
| 2026-04-14 | Level 3 voice parity + persisted preferences | TTS after voice-in replies matches text-in; `/voice` stored per chat in SQLite with `DEFAULT_VOICE_MODE` fallback in `.env`. |
| 2026-04-14 | Level 4 Phase 1 — TOTP + Telegram approval gate | RFC 6238 via Node `crypto` only; challenges bind tool args; `APPROVE` handled in `bot.ts` before the agent so codes never reach the LLM; `high_risk_demo` stub proves the suspend/resume path. |
| 2026-04-15 | Core memory vs optional RAG modules (§2.7) | Core keeps FTS/sql.js as the default, auditable baseline. Semantic RAG is recommended via optional packages that declare deps, data residency, and trust boundaries — avoids pretending lexical memory is sufficient for all use cases. |
| 2026-04-15 | Extensibility + tool-surface discipline (§2.8) | Optional integrations register through explicit surfaces; MCP preferred for heavy/third-party; bounded visible tools and module map updates keep the codebase and LLM coherent as optional modules accumulate. |
| 2026-04-15 | `DESIGN.md` maintenance + splitting guidance | Document growth managed via `docs/DESIGN_DOC_SPLITTING.md` — thin index, linked depth, split when ~800+ lines or TOC pain. |
| 2026-04-15 | Loopback HTTP for local HTML GUI (§2.1.2) | Bounded exception to “no HTTP listener”: `127.0.0.1`/`::1` only, for user-friendly chat + hosted config page — aligns with Player2’s everyday-user audience; does not permit LAN/WAN binding. |
| 2026-04-17 | Module framework Phase 1 — hybrid runtime, in-process first (§4.7) | Hybrid plan: first-party modules in-process (fast iteration, code-review trust), third-party via MCP later (OS-level isolation). Phase 1 ships the gate pipeline — fixed broad permission catalog, strict manifest validator, capability broker, TOTP-gated high-risk calls, append-only audit log — with primitives stubbed so the security surface is provable before real shell/fs/net land. `runtime: "mcp"` is explicitly rejected in this phase. |
| 2026-04-18 | Module framework Phase 1.5 — unstub safe primitives (§4.7) | `memory.read/write` now round-trips through a new `module_memory` SQLite table namespaced by caller module id; `fs.read_public` reads under `data/public/<moduleId>/` with path-containment + 1 MiB cap. High-risk primitives stay stubbed until Phase 2 subprocess isolation. Adds `npm run verify` harness and lazy `P2CLAW_DB_PATH` override so the harness runs hermetically. |
| 2026-04-18 | Module framework — bind first-party folder to expected module id (§4.7) | Prevents a folder-rename + content-swap spoof that could impersonate a first-party identity in logs and audit entries. `FIRST_PARTY_ALLOWLIST` is now a `folderName -> expected reverse-DNS id` map; validator adds `ERR_FIRST_PARTY_ID_MISMATCH` and a `npm run verify` case. Broker permission gates remain the authoritative security boundary; `firstParty: true` is now explicitly informational. |
| 2026-04-17 | Dev-tools module + `/debug` command, env-gated (§4.7) | Adds deterministic tool invocation for both LLM-side diagnostics (`debug_call_tool`) and frontend-side diagnostics (`/debug call`) without loosening the security model. Gated by `P2CLAW_DEV_MODE`: loader skips the `src/extensions/dev-tools/` folder and every frontend treats `/debug` as unknown command when off, so normal installs carry zero extra surface. `debug_call_tool` declares no permissions itself — the target tool's effective risk still controls TOTP — and self-recursion / nested debug calls are rejected. A new `kind: "debug_invocation"` audit record sits alongside the broker's permission decisions in the same JSONL file, resolved through the now-exported `resolveAuditLogPath()` helper so the tail path never drifts from the writer path. |
| 2026-04-18 | Level 4 Part D complete — keep policy minimal and Core-owned | The Level 4 permission system is complete once Core owns the fixed permission catalog, manifest validation, broker semantics, one-shot TOTP approval, effective tool-risk derivation, and append-only audit, with real subprocess and file-system dispatch behind those gates. No durable per-tool or per-module allow/deny state was added: session or permanent trust shortcuts would create a prompt-injection escalation path and weaken the explicit approval model. `net.outbound` remains a gate-only stub because no current Level 4 module needs raw in-process HTTP and a real implementation would need URL allowlisting, redirect handling, and response-size policy that are not justified yet; MCP stays the preferred path for network-heavy integrations. `credentials.read` also remains a gate-only stub because exposing the live TOTP secret, Telegram bot token, or Player2 key to module code would be an extreme capability escalation without a concrete Level 4 use case. |
| 2026-04-19 | Level 4 Part F — modular frontends / parity | Telegram text and voice handlers now call `createAgentCore` (`src/ui/core.ts`) so the agent loop stays single-sourced; `parseDebugTail` centralises `/debug` tail parsing; CLI gains `/status`, `/profile`, `/totp_enroll_help`; loopback HTML gains parity APIs (`/api/memories`, `/api/clear`, `/api/compact`, expanded `/api/status`) with `assertTrustedOrigin` on mutating/list-memory routes. Core remains the trust boundary (TOTP, registry, audit unchanged). |
| 2026-04-19 | Level 4 Part A — real shell execution surface | `shell.execute` and `process.spawn` broker primitives dispatch real subprocess execution via `src/modules/subprocess.ts`. Policy: 10s default / 60s max timeout, 64 KiB stdout/stderr caps with truncation flags, allowlisted environment (no credential leak), deterministic cwd. `subprocess_event` audit records log outcome class (success, nonzero_exit, timeout, spawn_error). Approval summary redacts sensitive-looking arguments. |
| 2026-04-19 | Level 4 Part B — real file system surface | Three built-in tools (`file_read`, `file_write`, `file_list`) sandboxed to `data/workspace/`. `file_write` is high-risk / TOTP-gated. Core file policy (`src/modules/fs-policy.ts`) enforces hard bans on `.env` family, source tree, audit log, and `p2claw.db` for writes; `.env` family for reads. Broker `fs.readPrivate` (4 MiB cap) and `fs.writeAny` (10 MiB cap) are real with policy enforcement and `fs_event` audit records. Path summaries in audit never expose absolute paths. |
| 2026-04-19 | Level 4 Part C — MCP bridge runtime | `src/mcp/` implements a Core-owned MCP stdio host (`McpServerHost`) with startup timeout, crash-restart with exponential backoff, call-level timeouts, and protocol mismatch detection. `McpStdioClient` wraps the official `@modelcontextprotocol/sdk`. `registerMcpTools()` bridges only manifest-declared tools (undeclared server tools are ignored by Core). Manifest validation now accepts `runtime: "mcp"` with a validated `mcp` config block; command shell-metacharacter injection and env secret-passthrough are banned. `mcp_lifecycle` and `mcp_event` audit records cover startup, crashes, restarts, tool calls (success/timeout/disconnected/error). First-party `mcp-echo` fixture gated by `mcpVerify` flag — never loaded in production. |
| 2026-04-19 | Level 4 Part E — approval UX outside Telegram | CLI prompts for TOTP code in the terminal; HTML UI shows an approval panel and posts to `/api/approve`. All frontends share the same `createChallenge` / `waitForApproval` / `tryApproveWithTotp` / `cancelPendingForChat` primitives from `src/security/approval.ts`. Bad codes are non-terminal (user can retry within 120s TTL). TOTP codes and approval prompts never enter LLM context or chat history in any frontend. |
| 2026-04-19 | Level 4 complete — closeout review | All 8 Level 4 roadmap bullets verified complete against code. 90+ automated checks pass (`scripts/verify-modules.ts`). TypeScript build clean. Documentation aligned. `net.outbound` and `credentials.read` remain intentional gate-only stubs. |

---

*Last updated: 2026-04-19*
