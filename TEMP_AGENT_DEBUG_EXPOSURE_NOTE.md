# Agent debug exposure — later consideration

**Purpose:** Capture a product note for later. Safe to delete or fold into a plan/doc when this becomes active work.

## Current stance

- External exposure for third-party agent frameworks like Cursor, Claude Code, etc. is **not a high priority right now**.
- The near-term focus should stay on the in-repo/core module and frontend debug surfaces already being built.

## Working conclusion

- If/when agent-facing debug exposure is revisited, prefer exposing the **structured dev-tools tool surface** rather than the raw `/debug ...` text command surface.
- Keep any future exposure **dev-mode only** and routed through the existing registry / broker / approval / audit path.
- Avoid designing a separate privilege path for external agents; reuse the same enforcement model as first-party tool execution.

## Why this was deferred

- The current developer need is primarily first-party debugging and deterministic local diagnostics.
- Third-party agent integration adds extra product/design work around transport, approval handoff, UX, and trust boundaries.
- That work is easier to evaluate after the current debug/tooling flow settles.

## Revisit questions

- Should external agents talk to a thin adapter over the existing dev-tools module, or to a separate API surface?
- How should TOTP / approval prompts be relayed back into third-party agent workflows?
- Which debug capabilities should be exposed externally, if any, beyond inspection + safe invocation?
- What should remain frontend-only for humans versus tool-only for agents?

---

*Written: 2026-04-17.*
