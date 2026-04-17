# Session handoff — P2 Claw (temp note)

**Purpose:** Quick context for a new chat. Safe to delete when no longer needed.

## Status

- **Latest tested and satisfactory:** fully-hosted localhost HTML GUI (chat at `/`, hosted config at `/config`, same-origin `/api/config`, tightened origin checks).
- **Now landed:** Module framework **Phase 1 + Phase 1.5** (manifest validation, capability broker, TOTP gate, audit log, module-scoped memory, `fs.read_public`, demo modules) plus dev-mode diagnostics (`dev-tools` module + frontend `/debug` command).

## Big-picture vision — Module Hook Framework

Goal: let optional modules contribute capabilities/tools while **Core remains the only code path to any dangerous primitive** and the only approver of high-risk actions.

- **Hybrid runtime**
  - **First-party in-process** modules in `src/extensions/` — faster dev loop, gated by Core-provided capability broker, trust boundary is **code review**, not OS sandbox.
  - **Third-party MCP modules** (Phase 2+) — separate OS processes, OS-level isolation.
- **Fixed broad permission catalog** owned by Core. No custom permission keys, no advisory sub-tags. Adding a category requires a Core release.
- **Capability broker** is the only API a module ever sees. Modules never get raw `child_process`, `fs`, `net`, etc.
- **TOTP-gated high-risk** actions reuse the existing `src/security/approval.ts` flow. Modules cannot bypass because they never hold the primitive.
- **Append-only audit log** at `data/p2claw.audit.log` records every permission decision (hashed args + short summary, no raw secrets).
- **Future phases**
  - Phase 2: MCP runtime — spawn third-party modules as subprocesses; Core mediates all capability requests over JSON-RPC.
  - Phase 3: Cursor/Claude-Code-style **"allow once / this session / always allow"** policy rules. A user opting to "always allow" a high-risk capability still requires a one-time TOTP to create the rule — the rule itself becomes the ongoing approval.
  - Phase 4: Module install UX / curated registry.

## Implemented module-framework baseline

- Fixed permission catalog (~10 broad categories).
- `manifest.json` schema + strict validator (reverse-DNS id, `runtime=inprocess` only, `firstParty` allowlist, permissions must be catalog subset, tools' `requires` must be declared).
- In-process capability broker — per-permission methods that (1) check declared permission, (2) gate via TOTP when risk is high, (3) write audit log, (4) only then touch the primitive.
- Module loader scans `src/extensions/*/manifest.json`, validates, loads, registers module-contributed tools with the existing tools registry.
- Tools registry reuses the existing TOTP approval pipeline — one prompt per LLM tool call, no double-prompting.
- `memory.read/write` now round-trips through module-scoped SQLite storage and `fs.read_public` is live under `data/public/<moduleId>/`.
- High-risk broker primitives remain stubbed in-process; the gate + audit path is real, the dangerous primitive is not.
- Two demo modules: `demo-safe` (safe permissions, sanity check) and `demo-high-risk` (declares `shell.execute`; broker still stubs actual shell execution).
- Dev-mode diagnostics are implemented via `src/extensions/dev-tools/` and the shared `/debug` handler in `src/ui/debug.ts`.

## Explicit non-goals for Phase 1

- MCP runtime / subprocess modules.
- Third-party module loading (`firstParty: false` is validated-and-rejected only).
- "Allow once / this session / always allow" policy rules.
- Per-action whitelisting matchers (string/regex/arg-fingerprint).
- Module install UI, module marketplace.
- Replacing the existing `risk: "high"` path on built-in tools.

## Key paths

| Area | Location |
|------|----------|
| HTML server + APIs | `src/ui/html.ts` |
| Hosted chat + config pages | `src/ui/html/public/` (`index.html`, `config.html`, `assets/app.js`, `assets/config.js`, `assets/styles.css`) |
| Boot / frontends | `src/index.ts`, `src/config.ts` |
| Tools + TOTP | `src/tools/registry.ts`, `src/tools/tool-types.ts`, `src/security/approval.ts`, `src/security/totp.ts` |
| Module framework (Phase 1) | `src/modules/permissions.ts`, `manifest.ts`, `broker.ts`, `loader.ts`, `audit.ts`, `types.ts` |
| First-party modules | `src/extensions/<module-id>/manifest.json` + `index.ts` |
| Audit log | `data/p2claw.audit.log` (append-only JSONL) |

## Intentional non-goals (unless you change them)

- HTML UI is **not** for remote/LAN bind — loopback only.
- Voice/STT remain Telegram-oriented; CLI/HTML don't duplicate that yet.
- In-process modules are not a security sandbox — that's what MCP (Phase 2) is for.

---

*Written: 2026-04-17 — handoff during Module Framework Phase 1.*
