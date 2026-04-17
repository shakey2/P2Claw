# Dev-Tools Module — Historical Proposal & Handoff Brief

> **Status:** Implemented. The `dev-tools` module and the frontend `/debug`
> command have already landed.
> This file is kept as historical planning context and design rationale.
> Treat the implementation-oriented sections below as background, not as an
> open proposal.
> For current behavior, see `DESIGN.md` §4.7 and the shipped code in
> `src/extensions/dev-tools/`, `src/ui/debug.ts`, and the frontend handlers.

---

## 1. Why we want this

Phase 1 and Phase 1.5 landed a working module framework (manifests, capability
broker, TOTP gates, audit log, module-scoped memory, `fs.read_public`) and a
hermetic automated harness (`npm run verify`). The harness catches regressions
in the validator, the broker, the registry, and the safe primitives.

What it **does not** catch:

- Bugs that only surface through the Telegram, HTML, or CLI frontends (format
  glitches, long-polling quirks, HTML escaping, session routing).
- Bugs where the LLM *picks the wrong tool* or *passes wrong arguments* — and
  a dev can't easily tell whether the bug is in the LLM prompt, the tool
  schema, the registry wrapper, or the module's handler.
- "I want to force-invoke this tool with these exact args right now to see
  what it returns, without coaxing an LLM into calling it."

Dev-tools solves both of those. It is explicitly **not** a feature for normal
users — most installs should never have it loaded. It exists for P2 Claw
contributors and for people writing custom modules.

---

## 2. Two-layer design

The core insight: deterministic tool invocation is useful in two very
different contexts, and they want very different ergonomics and threat models.

```
┌──────────────────────────────────────────────────────────────────┐
│ Layer 1: `dev-tools` module  (LLM-facing, normal agent loop)     │
│   LLM -> tool: debug_call_tool("demo_ping", {"note":"hi"})       │
│   Used to diagnose "why is the LLM failing at this tool call?"   │
│   Everything still goes through the agent loop, registry,        │
│   broker, and audit log.                                         │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│ Layer 2: `/debug` frontend command  (bypasses the LLM entirely)  │
│   User types: /debug call demo_ping {"note":"hi"}                │
│   The frontend parses, calls the registry directly, returns raw  │
│   result. No LLM in the loop. Used to isolate "is the tool       │
│   itself broken, or is the LLM just picking bad args?".          │
└──────────────────────────────────────────────────────────────────┘
```

Both layers share one rule: **they only load / respond when P2 Claw is in
dev mode.** In normal mode they don't exist (module isn't registered, command
returns "unknown command").

---

## 3. Layer 1 — `dev-tools` module

### 3.1 Shape

A new first-party module at `src/extensions/dev-tools/` with:

- `manifest.json` — id `com.p2claw.dev-tools`, `firstParty: true`, added to
  `FIRST_PARTY_ALLOWLIST` in [src/modules/manifest.ts](../src/modules/manifest.ts)
  (note the folder->id binding from the 2026-04-18 decision log entry —
  both the folder name and the expected id must go in the map).
- `index.ts` — exports a module that registers the debug tools below.

### 3.2 Tools (LLM-callable)

| Tool | Purpose | Required permissions |
|---|---|---|
| `debug_list_tools` | Returns the full registry: every tool's name, description, parameter schema, owner module id, and required permissions. Lets the LLM (and the dev reading the transcript) see exactly what's registered. | none (pure registry read) |
| `debug_inspect_module` | Given a module id, returns its manifest: declared permissions, tools, runtime, firstParty status, entry. | none |
| `debug_tail_audit` | Returns the last N entries from the **active audit log path** (resolved the same way [src/modules/audit.ts](../src/modules/audit.ts) does, including `P2CLAW_AUDIT_LOG_PATH`). N defaults to 20, hard-capped at e.g. 200. | none (reads the resolved audit log path directly) |
| `debug_call_tool` | Given a target tool name and a structured `args` object, invokes that tool through the normal registry path and returns its raw result plus metadata (target owner, effective risk). It should reject `target === "debug_call_tool"` to prevent accidental recursion loops. | none declared on the manifest; per-call behavior mirrors the **target** tool |

`debug_call_tool` is the interesting one. It *re-enters* the registry, which
means:

- Every broker gate still fires (safe perms resolve, high-risk perms require
  TOTP approval exactly as if the LLM had called them directly).
- The tool's effective risk must be derived from the **target** tool, not from
  dev-tools declaring a superset manifest.
- Broker permission decisions still log under the target module's broker path,
  and the debug surface should emit its own explicit "debug invocation" event
  (see §5.3) so operators can tell the call came from dev-tools.
- The tool being invoked runs under its real `ownerModuleId` — so
  module-scoped memory reads/writes hit the right namespace, `fs.readPublic`
  hits the right `data/public/<moduleId>/`, etc.

This is the "force tool call from the LLM" pathway. It lets a dev prompt
the LLM with "invoke demo_ping via debug_call_tool with note='abc'" and see
the exact result, with full audit.

### 3.3 Permission strategy for `debug_call_tool`

Do **not** declare every permission on the dev-tools manifest.

That sounds simple, but under the current registry it has a bad side effect:
if `debug_call_tool.requiredPermissions` includes any high-risk permission, the
registry promotes the tool itself to `risk: "high"` before it even looks at the
target tool. That would force TOTP for *every* debug call, including safe tools
like `demo_ping` or `get_current_time`.

Recommended design:

1. `debug_call_tool` itself declares **no broker permissions**.
2. It introspects the target tool's metadata from the registry.
3. It invokes the target through the normal `executeTool(...)` path so the
   target tool's own effective risk still controls whether TOTP is required.
4. If the target is a module-contributed tool, the existing registry
   `runWithGrants(...)` wrapper for **that target tool** continues to supply
   the target module's broker grants for the duration of the handler call.

This keeps the permission footprint honest, preserves the current security
model, and avoids turning dev-tools into a permanently-high-risk trampoline.

---

## 4. Layer 2 — `/debug` frontend command

A slash command the user types directly into Telegram, CLI, or HTML GUI.
It **does not** go through the LLM. It is parsed by the frontend and routed
to a shared handler.

### 4.1 Subcommands

| Command | Effect |
|---|---|
| `/debug help` | Lists subcommands. |
| `/debug list` | Same output as `debug_list_tools` above. |
| `/debug modules` | Lists loaded modules with their declared permissions. |
| `/debug audit [N]` | Tails last N audit entries (default 20, cap 200). |
| `/debug call <tool_name> <json_args>` | Invokes a tool through the registry, bypassing the LLM. Returns the raw result plus metadata. JSON stays string-based here because it is user-typed input, unlike the LLM-facing tool. |
| `/debug perms <tool_name>` | Shows the tool's required permissions, effective risk, whether TOTP is configured, and whether this frontend/session currently has a pending approval challenge. **Do not** describe approvals as persistent approved/unapproved state; the current system only has short-lived in-flight challenges. |

### 4.2 Where the shared handler lives

Currently each frontend has its own slash-command dispatch:

- CLI: switch statement in [src/ui/cli.ts](../src/ui/cli.ts) (see `handleSlashCommand`).
- Telegram: `bot.command("...")` registrations in [src/bot.ts](../src/bot.ts).
- HTML: POSTs against the loopback API ([src/ui/html.ts](../src/ui/html.ts)).

For consistency the planner should add a small shared `handleDebugCommand`
function (probably in `src/ui/debug.ts` or inside `src/ui/core.ts`) that
takes `(sessionId, subcommand, args)` and returns a **structured result**
object, not just a string. Each frontend then renders that result using its
own UX rules (Telegram chunking + Markdown fallback, CLI plain text, HTML JSON
render).

That matters because this feature explicitly exists to diagnose frontend/tool
integration bugs. If the shared handler returns only a raw string, Telegram
still needs ad-hoc escaping/chunk splitting and HTML still needs object-aware
rendering, which would recreate avoidable frontend divergence.

### 4.3 High-risk tools from `/debug call`

When the dev runs `/debug call demo_shell {"cmd":"git"}`, the registry will
still trigger the TOTP approval hook. The frontend's existing
`sendPendingApproval` hook must be reachable from the debug handler — that's
already the case conceptually for the CLI and Telegram, and is where most of
the frontend integration work actually lives.

Two implementation notes that the original sketch glossed over:

1. Telegram / CLI / HTML already have **different** approval UX, so the shared
   debug handler should accept hooks just like the agent loop does rather than
   trying to prompt directly.
2. The `/debug perms` output must reflect the real approval model in
   [src/security/approval.ts](../src/security/approval.ts): there is at most
   one pending challenge per chat/session, it expires quickly, and a new
   challenge replaces the previous one. There is no durable per-tool approval
   cache to report.

---

## 5. Security model — making sure this never loads for a normal user

### 5.1 The dev-mode gate

Introduce `P2CLAW_DEV_MODE` as a boolean env var (default: `false`). Surface
it through [src/config.ts](../src/config.ts) as `config.devMode`.

Two gates are driven by this flag:

1. **Loader gate.** [src/modules/loader.ts](../src/modules/loader.ts) skips
   the `dev-tools` folder when `devMode === false`. Add a dedicated check
   so the dev-tools module is *never* registered in normal mode — its tools
   are not in the registry, its module id isn't loaded, the LLM cannot see
   it.
2. **Frontend gate.** Every frontend's `/debug` dispatch short-circuits to
   "unknown command" when `devMode === false`. This matters because a user
   could otherwise type `/debug call demo_shell ...` before the command is
   even parsed into debug-handler land. Treating it as "unknown command" is
   the right behavior — no information leak about the feature's existence.

### 5.2 Production safety checklist for the planner

- `.env.example` must document `P2CLAW_DEV_MODE=false` with a comment that
  end users should leave it off.
- `npm run verify` should add a case that loads modules with `devMode=false`
  and asserts `dev-tools` is absent from the registry.
- `npm run verify` should add a case that loads modules with `devMode=true`
  and asserts `dev-tools` **is** present and its tools are registered.
- Consider printing a prominent banner on startup when dev mode is on, so
  a misconfigured production box is immediately obvious in logs.
- TOTP approval must still be required for high-risk tools — dev mode is
  not "disable security", it's "enable extra diagnostics".

### 5.3 Audit expectations

- Do **not** assume the existing broker audit entries are enough. Today
  [src/modules/audit.ts](../src/modules/audit.ts) records **permission
  decisions**, not top-level tool invocations, and it has no `caller` field.
- Add a small explicit debug-invocation event writer (same JSONL file, or a
  clearly-related sibling writer in the same module) for:
  - `surface`: `llm_debug_tool` vs `frontend_debug_command`
  - `callerId`: `com.p2claw.dev-tools` or a stable frontend debug id
  - `targetTool`
  - `targetOwnerModuleId`
  - `argsHash` / short redacted summary
  - `result`: success / error / approval_timeout / approval_denied
  - `debug: true`
- Keep the existing broker permission audit lines too. The two record types
  answer different questions:
  - debug event = "who intentionally triggered this debug call?"
  - broker event = "which primitive permission decisions happened underneath?"
- `debug_tail_audit` / `/debug audit` must resolve the audit file path through
  the same helper that the writer uses; do not hardcode `data/p2claw.audit.log`.

---

## 6. File touchpoints (for the planner)

Referenced paths use the repo layout as of 2026-04-18.

| Area | File(s) | What the planner will touch |
|---|---|---|
| New module | `src/extensions/dev-tools/manifest.json`, `src/extensions/dev-tools/index.ts` | Create the module itself. |
| Allowlist | [src/modules/manifest.ts](../src/modules/manifest.ts) | Add `"dev-tools": "com.p2claw.dev-tools"` to `FIRST_PARTY_ALLOWLIST`. |
| Config / env | [src/config.ts](../src/config.ts), `.env.example` | Add `P2CLAW_DEV_MODE` boolean; thread `devMode` into Config. |
| Loader | [src/modules/loader.ts](../src/modules/loader.ts) | Skip dev-tools folder when `devMode === false`. |
| Registry access | [src/tools/registry.ts](../src/tools/registry.ts) | Add a public metadata accessor that returns registered tools with schema, owner module id, required permissions, and effective risk. `debug_call_tool` needs metadata lookup for the target tool and should reject self-recursion. |
| Module metadata index | [src/modules/loader.ts](../src/modules/loader.ts) (and possibly a new small helper) | Loader currently only returns `{ id, toolCount }`. Add a retained runtime index of loaded module manifests / summaries so `debug_inspect_module` and `/debug modules` can answer without rescanning disk ad hoc. |
| Broker | [src/modules/broker.ts](../src/modules/broker.ts) | No core gate change expected. The important change is **not** declaring every permission on dev-tools; target tools continue to use the existing grant path. |
| Audit | [src/modules/audit.ts](../src/modules/audit.ts) | Add a shared "resolve audit log path" helper and an explicit debug-invocation event writer; do not just tack `debug: boolean` onto broker permission entries and call it done. |
| Shared debug handler | `src/ui/debug.ts` (new) or inside [src/ui/core.ts](../src/ui/core.ts) | Parse subcommand, dispatch, return a structured result object each frontend can render safely. |
| CLI frontend | [src/ui/cli.ts](../src/ui/cli.ts) | Add `case "/debug":` that calls shared handler when `devMode`. |
| Telegram frontend | [src/bot.ts](../src/bot.ts) | Add `bot.command("debug", ...)` when `devMode`. |
| HTML frontend | [src/ui/html.ts](../src/ui/html.ts) | Add a POST endpoint or chat-string parse for `/debug` when `devMode`; render structured results and reuse the existing pending-approval plumbing. |
| Verify harness | [scripts/verify-modules.ts](../scripts/verify-modules.ts) | Add `[8] Dev-tools module` block: off-by-default check, on-behavior check, safe target via `debug_call_tool`, high-risk target still requiring TOTP, module-inspection path, audit path resolution path, and recursion rejection. |
| Design doc | [DESIGN.md](../DESIGN.md) §4.7, §8 Decision Log | Document the dev-mode gate and add a Decision Log row. |

---

## 7. Open questions the planner should decide first

1. **Is dev mode per-session or global?** Recommend global (env var at
   startup). A runtime toggle invites footguns (attacker tricks the bot
   into enabling dev mode for one session).
2. **Should `/debug call` also accept pretty-printed multi-line JSON?** For
   Telegram this matters — messages get split weirdly. A reasonable default
   is "args must be a single JSON object on one line; if you need complex
   args, use the HTML frontend or CLI".
3. **Scope of `/debug audit`:** raw JSONL dump vs. pretty-formatted table?
   Recommend raw JSONL for dev predictability; users wanting formatting can
   pipe through `jq`.
4. **Where should the runtime module metadata index live?** Loader-local
   singleton, a tiny `modules/runtime-index.ts`, or an expanded loader return
   surface cached at boot. Recommend a tiny explicit runtime index so the
   debug surfaces do not rescan disk and risk drifting from what was actually
   loaded.
5. **Do we want a `/debug replay <audit_id>` or is that scope creep?**
   Recommend deferring; audit entries don't preserve raw args (only hashes +
   summaries), so replay isn't trivially possible. Call it out as a
   non-goal.

---

## 8. Non-goals for v1

- Replaying historical audit entries (requires full-arg capture we don't do).
- Modifying manifests at runtime.
- Reloading modules without a restart.
- Arbitrary SQLite queries against `p2claw.db` (separate tool if ever needed).
- Running dev-tools on normal user installs — this must remain env-gated.
- Durable "approved/unapproved" policy state for tools. Phase 1 approvals are
  still one-shot TOTP challenges, not a policy engine.

---

## 9. Hand-off prompt template

Use this as the opening message when kicking off the planning session:

> Task: produce an implementation plan only. Do not implement code.
>
> Read these files first, in this exact order:
> 1. `docs/DEV_TOOLS_PROPOSAL.md` (read the whole file)
> 2. `DESIGN.md` §4.7
> 3. `src/modules/manifest.ts`
> 4. `src/modules/loader.ts`
> 5. `src/tools/registry.ts`
> 6. `src/modules/audit.ts`
> 7. `src/security/approval.ts`
> 8. `src/ui/cli.ts`
> 9. `src/bot.ts`
> 10. `src/ui/html.ts`
> 11. `scripts/verify-modules.ts`
>
> Before writing the plan, explicitly validate the proposal against the current
> code and treat the following as required constraints, not suggestions:
> - `debug_call_tool` must not declare every permission on the dev-tools
>   manifest. Under the current registry, that would make it permanently
>   high-risk even when targeting safe tools.
> - The current audit log records permission decisions, not top-level debug
>   invocations. The plan must include an explicit debug-invocation audit path.
> - `/debug perms` must describe the real approval model in the current code:
>   ephemeral pending challenges, not persistent approved/unapproved state.
> - The shared debug handler must return structured results that each frontend
>   can render safely; do not assume one raw string format works equally well
>   for Telegram, CLI, and HTML.
> - `debug_tail_audit` / `/debug audit` must use the active audit log path
>   resolution logic, not a hardcoded `data/p2claw.audit.log` path.
> - `debug_inspect_module` and `/debug modules` need a runtime module metadata
>   source; do not assume the current loader already retains that information.
> - `debug_call_tool` must reject self-recursion / debug-call nesting unless
>   you identify a strong reason to support it.
>
> Output format: use exactly these sections, in this order:
> 1. `Assumptions validated against code`
> 2. `Implementation plan`
> 3. `Open questions and proposed defaults`
> 4. `Verification plan`
> 5. `Out-of-scope / do not change`
>
> Requirements for each section:
> - In `Assumptions validated against code`, list the concrete proposal claims
>   you checked and whether each one matches current code, needs adjustment, or
>   requires a new supporting mechanism.
> - In `Implementation plan`, give a step-by-step plan grouped by subsystem.
>   Name the exact files you expect to change. Be explicit about new helper
>   modules if you think they are needed.
> - In `Open questions and proposed defaults`, answer every open question in
>   §7 of `docs/DEV_TOOLS_PROPOSAL.md` and propose one default for each.
> - In `Verification plan`, list the exact behaviors that should be tested in
>   `scripts/verify-modules.ts` and any manual checks needed for Telegram, CLI,
>   and HTML frontend wiring.
> - In `Out-of-scope / do not change`, call out tempting adjacent refactors that
>   should not be pulled into this work unless they are strictly required.
>
> Scope constraints:
> - Stay within the dev-tools proposal. Do not broaden this into a general tool
>   framework redesign unless a change is strictly required for this proposal.
> - Prefer the smallest design that satisfies the proposal and the current code
>   constraints.
> - If you believe part of the proposal should be changed before implementation,
>   say so explicitly and state the minimum wording or design correction needed.
> - Do not silently generalize from one frontend or one tool path to all others;
>   call out per-frontend differences where they matter.
>
> Expected size: medium plan. The likely work should remain bounded to a new
> first-party module, a dev-mode gate, registry metadata access, a runtime
> module metadata index, a shared debug handler, three frontend integrations,
> audit support, verify coverage, and a `DESIGN.md` update with one Decision Log
> row.

---

*Authored 2026-04-18. If the codebase has moved on significantly, verify
each "file touchpoint" path before writing a plan.*
