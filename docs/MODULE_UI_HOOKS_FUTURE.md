# Module UI / Config Hooks — Future Design Note

> Future-facing design note for module-owned settings and HTML UI contributions.
> This captures the post-Level-4 assessment so we do not need to re-evaluate
> the same design questions from scratch later.

---

## 1. Why this note exists

After reviewing the current architecture and a proposed "module tabs +
config hooks" direction, the conclusion was:

- The feature is **worth supporting** if modules are expected to become
  first-class HTML experiences.
- It should **not** be implemented as arbitrary plugin-style UI injection.
- It is **not required** to honestly close out the current Level 4 roadmap.
- It may become a strong candidate for the **next bounded implementation part**
  after Part G / Level 4 closeout, especially if beta modules need their own
  settings pages or dashboards.

This note records the recommended direction so future planning can start from a
stable baseline instead of revisiting the same tradeoffs again.

---

## 2. Current repo reality

### What already exists

- A strict module system with:
  - allowlisted first-party module loading
  - declarative `manifest.json` validation
  - Core-owned permission catalog
  - broker-gated capability access
  - TOTP approval for high-risk operations
  - audit logging
- A local HTML frontend with:
  - fixed routes
  - fixed APIs for chat, approval, status, memories, config, debug
  - static pages served from `src/ui/html/public/`

### What does not exist

- No module-owned HTML tab registry
- No module-owned settings/config registry
- No UI contribution API in `Module.register(...)`
- No generic module settings storage layer
- No safe sandbox for module-supplied frontend code in the main HTML UI

### Important current boundary

Modules currently contribute **tools**, not UI or config surfaces.

That is visible in the current runtime contract:

- `Module.register({ ctx, contributeTool })`
- no `contributeTab`, `contributeRoute`, `contributeSettings`, or equivalent

This matters because any future hook system is a **Core surface expansion**, not
just a small extension of an existing pattern.

---

## 3. Bottom-line recommendation

Support **both** of these eventually:

1. **Module settings hooks**
2. **Module HTML UI contributions**

But do so in a **tight, Core-owned, declarative way**.

Do **not** build:

- arbitrary HTML injection into the main page
- arbitrary JS execution from modules in the main UI context
- manifest-declared string handler resolution
- a broad plugin framework or marketplace abstraction
- a design that mixes global app config and module config into one loose blob

The safest direction is:

- **settings first**
- **route/tab registry second**
- **rich interactive widgets last, only if clearly needed**

---

## 4. Assessment of the earlier proposal

The earlier proposal had the right overall instinct:

- modules needing their own settings is real
- modules adding their own HTML destinations/tabs is a logical next step

But several parts should **not** be adopted directly.

### 4.1 Good instincts worth keeping

- Add a Core-owned registry for module settings
- Add a Core-owned registry for module HTML contributions
- Keep everything allowlisted, validated, and auditable
- Start with a lightweight version rather than a giant plugin platform

### 4.2 Parts to reject or revise

#### A. Avoid manifest string handlers

Do not put runtime handler references like:

```json
{
  "config": {
    "handler": "configHandler"
  }
}
```

into `manifest.json`.

Reason:

- the manifest is currently a **strict declarative validation surface**
- runtime behavior belongs in module code loaded by Core
- string-based handler lookup adds indirection and complexity without clear gain

#### B. Avoid arbitrary HTML fragments in the main UI

Do not start with a model where modules provide:

- raw HTML fragments
- "sanitized HTML" blobs injected into the main page
- browser-executed code in the main UI origin

Reason:

- the HTML frontend already exposes sensitive same-origin APIs for:
  - config reads/writes
  - pending approvals
  - approval/cancel actions
  - chat execution
  - shutdown
- fragment injection increases XSS and same-origin abuse risk
- even "sanitized HTML" creates long-term maintenance burden and subtle bugs

#### C. Avoid treating `.env` as the module settings database

Global app config in `.env` is fine.
Module-owned settings are a different class of data and should not automatically
be pushed into `.env`.

Reason:

- module settings can grow in count and complexity
- they may need structured storage
- they should not clutter or destabilize global runtime config

---

## 5. Recommended implementation shape

## Phase 1 — Module settings registry

### Goal

Let a module declare that it has settings and let Core expose those settings in
the HTML UI in a safe, structured, auditable way.

### Recommended shape

Add a Core-owned settings contribution surface, conceptually similar to:

- module declares settings metadata
- Core validates and registers it
- Core stores values in module-scoped config storage
- Core renders a generic settings UI

### Design preference

Use a **declarative settings schema**, not module-owned frontend code.

For example, the module may contribute:

- a settings section id
- display name
- field definitions or a limited JSON-schema-like shape
- defaults
- optional sensitivity flags per field

Then Core:

- validates the schema
- renders the settings form
- validates submitted values
- stores values
- applies TOTP or confirmation rules for sensitive changes if needed

### Why this is the best first step

- immediate value
- low UI risk
- fits existing Core-owned validation philosophy
- does not require executing module UI code
- gives future modules a clean place for API keys, toggles, thresholds, etc.

---

## Phase 2 — Module HTML contribution registry

### Goal

Allow modules to add tabs/pages to the local HTML UI without allowing them to
inject arbitrary code into the main app shell.

### Recommended shape

Prefer a **route/tab registry**, not fragment injection.

Conceptually:

- module contributes metadata:
  - `id`
  - `title`
  - `order`
  - `route`
  - `kind`
- Core adds the tab to the navigation
- Core controls the route shell and rendering model

### Strong preference

Start with one of these, in order of safety:

1. **Core-rendered declarative pages**
2. **Dedicated module routes returning structured JSON rendered by Core**
3. **More isolated rendering model later if clearly necessary**

Avoid, at least initially:

- inline arbitrary HTML
- inline arbitrary JS
- direct same-context frontend scripting by modules

### Why route-based is better

- easier to reason about
- cleaner ownership boundaries
- easier to test
- lower XSS risk
- simpler future evolution than ad hoc fragment composition

---

## Phase 3 — richer UI only if proven necessary

Only revisit richer module-driven UI if Phase 1 and Phase 2 prove insufficient.

Possible future questions:

- do modules need custom visual components?
- do modules need charts, dashboards, or richer workflows?
- does that require stronger isolation like iframes or a stricter component DSL?

Do not solve those early.

---

## 6. Data / storage recommendation

Do **not** default module settings to `.env`.

Recommended direction:

- create a Core-owned module settings store
- keep it separate from global app boot config
- keep it namespaced by `moduleId`
- keep reads/writes auditable where appropriate

This could live alongside other structured app data, not inside the global env
file used for boot-time secrets and top-level runtime settings.

### Suggested principle

- `.env` = app boot/runtime config and secrets
- module settings store = module-owned operational settings

This separation will age better as modules grow.

---

## 7. Security requirements

Any future implementation should preserve these rules:

1. **Core remains the trust boundary**
   - modules declare
   - Core validates
   - Core renders or brokers
   - Core stores and audits

2. **No arbitrary JS injection in the main UI**
   - do not let modules run browser code in the same UI context by default

3. **No arbitrary HTML fragment injection as the initial design**
   - route/page registration is preferred

4. **Same-origin APIs remain protected**
   - approval, config, and chat routes must not become easier to abuse

5. **Module settings are not global config by accident**
   - avoid pushing per-module state into `.env`

6. **Everything stays explicit and allowlisted**
   - no dynamic community UI loading
   - no remote asset/plugin fetches

---

## 8. Suggested future implementation part

If this becomes next-up work after Part G, add a new bounded part such as:

## Part H — Module Settings And HTML Contribution Hooks

### Goal

Add a safe, Core-owned module settings registry and a minimal module HTML
contribution system so first-party modules can expose their own settings/pages
in the loopback UI without arbitrary frontend code injection.

### Scope

- settings contribution model
- module settings storage
- HTML tab/route registry
- route rendering model
- validation and audit decisions

### Explicit non-goals

- arbitrary JS plugin execution
- HTML fragment injection system
- full plugin marketplace
- third-party remote UI packages
- website distribution flow

---

## 9. Questions future planning should answer

When this becomes active work, the planner should answer:

1. Where should module settings metadata live: manifest, runtime registration, or
   a hybrid split?
2. What is the smallest declarative settings schema that gives value without
   inventing a full form engine?
3. Where should module settings values be stored?
4. Which settings changes, if any, should require confirmation or TOTP?
5. How should HTML tabs/routes be registered and ordered?
6. What should a module be allowed to control about its UI surface?
7. Should module HTML pages be Core-rendered from structured data, or should
   there be a more isolated rendering model later?
8. How should verification work for route registration, validation failures,
   settings persistence, and security boundaries?

---

## 10. Recommendation on timing

This feature should be considered **after Part G** unless one of these becomes
true:

- a near-term beta module genuinely depends on its own HTML settings page
- Level 4 closeout reveals that the current HTML/module split is too limiting
  for the intended first-party module roadmap

Otherwise:

- finish Level 4 honestly
- complete Part G
- then start a new bounded implementation part for this work

That keeps the roadmap clean and avoids muddying Level 4 closeout with a
different architectural expansion.

---

## 11. Final summary

Recommended future direction:

- **Yes** to module settings hooks
- **Yes** to module HTML contributions
- **No** to arbitrary JS/plugin execution in the main UI
- **No** to HTML fragment injection as the starting design
- **No** to manifest string handler indirection
- **No** to using `.env` as the long-term module settings store

Best path:

1. module settings registry
2. route/tab registry
3. richer UI only if clearly needed later

This fits the project’s current philosophy:

- lean
- security-first
- Core-owned trust boundaries
- explicit, auditable optional capability
