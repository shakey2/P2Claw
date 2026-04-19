# Level 4 Planner Guide

> Planner-facing guide for finishing Level 4 in bounded chunks.
> Use this when you want a planner to tackle one part at a time without
> re-scoping the whole project on every pass.

---

## 1. Purpose

Level 4 is no longer "invent the framework." The security and module boundary
already exist. The remaining work is mostly about turning the current stubs and
placeholders into real runtime surfaces while keeping Core as the trust
boundary.

This guide breaks that work into separate parts so a planner can focus on one
bounded implementation area at a time.

---

## 2. Core Stance

Before planning any part, keep these rules fixed:

- `Core` owns permissions, approvals, audit, tool dispatch, real execution
  primitives, secret access, and any MCP host/runtime logic.
- Modules are capability packs, not trust-boundary owners.
- In-process modules remain first-party only.
- Third-party / untrusted extensibility should flow through MCP subprocesses,
  not direct in-process loading.
- Do not widen the visible tool surface casually. New tools should justify
  their existence and fit the current security model.
- Prefer the smallest design that satisfies the current roadmap and docs.

If a proposed plan weakens those rules, it should be revised before
implementation.

---

## 3. How To Use This Guide

For each part:

1. Give the planner only that part.
2. Ask for an implementation plan first unless the work is already fully
   decided.
3. Keep the planner inside the part's scope and non-goals.
4. Require a verification plan, not just code changes.

Recommended order:

1. Part A - Shell execution surface
2. Part B - File system surface
3. Part C - MCP bridge runtime
4. Part D - Permission / policy expansion
5. Part E - Approval UX outside Telegram
6. Part F - Frontend modularity / parity
7. Part G - Final Level 4 review and polish

---

## 4. Shared Read First

A planner working on any Level 4 part should read these first:

1. `DESIGN.md` sections `2.1`, `2.7`, `2.8`, `4.5`, `4.7`, and the Level 4 roadmap in `6`
2. `README.md` developer architecture / project structure section
3. `src/modules/permissions.ts`
4. `src/modules/manifest.ts`
5. `src/modules/broker.ts`
6. `src/tools/registry.ts`
7. `src/security/approval.ts`
8. `src/modules/audit.ts`
9. `scripts/verify-modules.ts`

These define the boundary that the remaining work must respect.

---

## 5. Parts

## Part A - Shell Execution Surface

### Goal

Replace the current stubbed shell/process execution path with a real, tightly
contained implementation that still routes through Core approval and audit.

### Current state

- `shell.execute` and `process.spawn` exist in the permission catalog.
- High-risk gating and audit are already wired.
- Broker methods are still stubbed.
- `demo_shell` only proves the TOTP path, not real execution.

### Planner should answer

- Should `shell.execute` and `process.spawn` remain separate internal
  primitives with one or two user-facing tools?
- What timeout, output-size, cwd, env, and argument restrictions are required?
- How should dangerous operations be summarized for approval without leaking
  secrets?
- Which behavior belongs in the broker versus dedicated built-in tools?

### Files likely involved

- `src/modules/broker.ts`
- `src/modules/types.ts`
- `src/modules/permissions.ts`
- `src/tools/registry.ts`
- `src/tools/`
- `src/security/approval.ts`
- `src/modules/audit.ts`
- `scripts/verify-modules.ts`

### Deliverables

- Real subprocess execution design
- Guardrails for timeout/output/env/cwd
- Clear approval prompt model
- Audit expansion for real executions
- Verification plan for success, denial, timeout, and bounded failures

### Non-goals

- General policy engine
- MCP runtime
- Self-modification workflow
- Containerization unless strictly required

---

## Part B - File System Surface

### Goal

Design the real file tool surface and the broker-backed file primitives without
breaking the repo's security posture.

### Current state

- `fs.read_public` is real and sandboxed.
- `fs.read_private` and `fs.write_any` are stubbed.
- Level 4 roadmap still calls for a sandboxed file system tool.

### Planner should answer

- What user-facing file tools are actually needed: read, write, list, delete,
  move, mkdir?
- What should be safe-by-default versus always high-risk?
- What root/sandbox model should apply for user-facing tools?
- How should Core distinguish app data paths from arbitrary user disk access?
- What hard bans should exist for running files, source tree writes, or secret
  file reads?

### Files likely involved

- `src/modules/broker.ts`
- `src/modules/types.ts`
- `src/modules/permissions.ts`
- `src/tools/`
- `src/modules/audit.ts`
- `scripts/verify-modules.ts`
- maybe `src/config.ts`

### Deliverables

- Concrete user-facing file tool set
- Sandbox/root policy
- Safe vs high-risk classification
- Audit / approval behavior for file operations
- Test matrix for containment, missing paths, overwrite, delete, and secret
  boundary cases

### Non-goals

- Module installation UX
- Website bundling/distribution
- Arbitrary repo mutation workflows

---

## Part C - MCP Bridge Runtime

### Goal

Design and implement the actual MCP host/bridge so external integrations can
run out-of-process and still flow through the Core security model.

### Current state

- `runtime: "mcp"` is explicitly rejected in the manifest validator.
- Design docs already point to MCP as the preferred path for heavy or
  third-party integrations.
- No real MCP runtime or server lifecycle exists yet.

### Planner should answer

- What is the smallest viable MCP bridge for Level 4?
- How are MCP servers declared, launched, supervised, and stopped?
- How does Core map MCP-exposed tools into the existing registry?
- How are MCP permissions represented and enforced if the actual code is
  out-of-process?
- How are stdout/stderr, crashes, timeouts, and version mismatches handled?

### Files likely involved

- `src/modules/manifest.ts`
- `src/modules/loader.ts`
- `src/modules/types.ts`
- `src/tools/registry.ts`
- `src/modules/audit.ts`
- `src/config.ts`
- new MCP-specific files under `src/modules/` or `src/mcp/`
- `scripts/verify-modules.ts`

### Deliverables

- Minimal MCP lifecycle architecture
- Clear Core-owned permission / audit path for MCP tools
- Runtime registration model
- Failure handling strategy
- Verify plan covering startup, tool call flow, timeout, crash, and unload

### Non-goals

- Third-party marketplace
- Module download UI
- Hot-reload / live install system

---

## Part D - Permission / Policy Expansion

### Goal

Finish the "tool permission system" beyond the current Phase 1 gate without
drifting into an overbuilt policy engine.

### Current state

- Fixed permission catalog exists.
- Risk promotion works.
- TOTP is one-shot per high-risk tool call.
- Docs still list the fuller permission/policy surface as unfinished.

### Planner should answer

- What exactly is still missing from Level 4 beyond the current manifest +
  broker + TOTP pipeline?
- Do we need per-tool allow/deny metadata, or is the current model already
  sufficient for Level 4?
- What belongs in Level 4 versus a later policy-management phase?
- How should policy state, if any, be stored and audited?

### Files likely involved

- `src/modules/permissions.ts`
- `src/modules/manifest.ts`
- `src/modules/broker.ts`
- `src/tools/registry.ts`
- `src/security/approval.ts`
- `src/modules/audit.ts`
- `DESIGN.md`
- `scripts/verify-modules.ts`

### Deliverables

- Clear gap analysis versus current implementation
- Minimal Level 4 policy design
- Audit/state model if new state is introduced
- Explicit line between "done for Level 4" and "future work"

### Non-goals

- Rich per-user policy UI
- Permanent trust rules unless truly required
- Marketplace / package provenance system

---

## Part E - Approval UX Outside Telegram

### Goal

Add out-of-band or non-Telegram approval paths so CLI and HTML users can safely
approve high-risk actions without relying on Telegram.

### Current state

- Telegram approval flow is the most mature path.
- Approval core is centralized in `src/security/approval.ts`.
- Level 4 roadmap still lists out-of-band 2FA beyond Phase 1 as unfinished.

### Planner should answer

- What is the minimum viable approval UX for CLI and HTML?
- Should CLI/HTML use the same TOTP code entry flow, just with different
  presentation?
- What shared abstraction should frontends implement for pending approvals?
- How do we avoid approval prompts leaking into the LLM context?

### Files likely involved

- `src/security/approval.ts`
- `src/tools/registry.ts`
- `src/ui/core.ts`
- `src/ui/frontend.ts`
- `src/ui/cli.ts`
- `src/ui/html.ts`
- `src/bot.ts`

### Deliverables

- Shared approval interface across frontends
- CLI and HTML approval UX design
- Verification plan for happy path, wrong code, cancel, timeout, replacement

### Non-goals

- Full account system
- Push notifications
- Mobile/web auth stack

---

## Part F - Frontend Modularity / Parity

### Goal

Finish the remaining "modular frontends" work so Telegram, CLI, and HTML feel
like thin surfaces over the same agent core and approval/tool plumbing.

### Current state

- Core frontend abstraction exists.
- HTML UI exists.
- Level 4 roadmap still flags modular frontends as incomplete.

### Planner should answer

- What frontend logic is still duplicated?
- What should move into shared UI/core helpers versus staying frontend-specific?
- Are slash-command and approval behaviors consistent enough across Telegram,
  CLI, and HTML?
- What would make CLI/HTML-only installs truly first-class?

### Files likely involved

- `src/ui/core.ts`
- `src/ui/frontend.ts`
- `src/ui/cli.ts`
- `src/ui/html.ts`
- `src/ui/telegram.ts`
- `src/bot.ts`

### Deliverables

- Gap list for current frontend divergence
- Minimal refactor plan for shared behavior
- Manual verification plan for all three frontends

### Non-goals

- New public web app
- Packaging website
- Feature redesign unrelated to parity

---

## Part G - Final Level 4 Review And Polish

### Goal

Perform a final Level 4 pass once Parts A-F are done so the repo can move into
review, beta, and polish work without architectural uncertainty.

### Planner should answer

- Does the implementation now satisfy the Level 4 roadmap as written?
- Which roadmap bullets should be marked complete, adjusted, or deferred?
- What doc updates are required in `README.md` and `DESIGN.md`?
- What manual test checklist should exist before trusted-user beta?

### Files likely involved

- `DESIGN.md`
- `README.md`
- `scripts/verify-modules.ts`
- any touched runtime files

### Deliverables

- Level 4 completion review
- Remaining risk list
- Documentation update checklist
- Beta-readiness verification plan

### Non-goals

- Website distribution work
- Level 5 heartbeat planning
- Broad new feature additions

---

## 6. Ready-To-Paste Planner Prompt Template

Use this template with any single part above:

```md
Task: produce an implementation plan only. Do not implement code.

Focus only on `Part X - <name>` from `docs/LEVEL4_PLANNER_GUIDE.md`.

Read these first:
1. `docs/LEVEL4_PLANNER_GUIDE.md` (the selected part plus shared sections)
2. `DESIGN.md` sections `2.1`, `2.8`, `4.5`, `4.7`, and the Level 4 roadmap
3. The exact files listed under "Files likely involved" for the selected part
4. `scripts/verify-modules.ts`

Required constraints:
- Keep Core as the trust boundary.
- Do not weaken TOTP / audit / permission enforcement.
- Prefer the smallest design that completes the part.
- Call out anything that should remain future work instead of expanding scope.
- Include verification, not just implementation steps.

Output format:
1. `Current state validated against code`
2. `Implementation plan`
3. `Key design decisions`
4. `Verification plan`
5. `Out of scope`
```

---

## 7. Recommended First Planner Task

If only one planner chunk should go next, start with `Part A - Shell Execution
Surface`.

Reason:

- It converts the most obvious remaining stub into a real Level 4 capability.
- It exercises the approval and audit model under real side effects.
- It will likely shape the file and MCP implementations that follow.

Once that is stable, `Part B` and `Part C` become much easier to scope
cleanly.
