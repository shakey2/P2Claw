# P2 Claw Module Guide (Complete Authoring + Security Reference)

This guide is the single-file reference for building a module in P2 Claw. It documents:

- `manifest.json` schema and validation rules
- all module hooks and interaction points
- capability scope (what modules can and cannot do)
- runtime + security validation flow
- expected failure modes and debugging surfaces

---

## 1) Architecture and trust boundary

P2 Claw modules are **capability packs**, not trust-boundary owners.

- **Core owns security:** permissions catalog, TOTP approval, audit logging, tool dispatch, file/process policy, MCP supervision.
- **Modules declare and request:** metadata (`manifest.json`), tools, optional settings schema, optional UI tab descriptors.
- **Core enforces everything:** if a module is malformed, undeclared, or exceeds policy, it is rejected or denied.

There are two runtimes:

1. `inprocess`: first-party code loaded and registered at boot.
2. `mcp`: out-of-process stdio server hosted by Core and bridged as tools.

---

## 2) Module folder contract

Each module lives under `src/extensions/<folder>/` and must include a `manifest.json`.

### In-process module minimum

- `manifest.json`
- entry file matching `manifest.entry` (typically `index.ts` / `index.js`)
- default export implementing `Module.register(...)`

### MCP module minimum

- `manifest.json` with `runtime: "mcp"` and `mcp` block
- runnable MCP command declared in manifest
- manifest `tools[]` declaration that matches the server’s exposed tool names

---

## 3) `manifest.json` schema (authoritative)

## 3.1 Top-level fields

Required shape (after validation and normalization):

- `id: string` — reverse-DNS, regex: `^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,4}$`
- `name: string` — non-empty
- `version: string` — semver-like (e.g., `0.1.0`)
- `description: string` — non-empty
- `runtime: "inprocess" | "mcp"`
- `firstParty: true` — required in current phase
- `entry: string`
  - required/validated for `inprocess`
  - optional/ignored for `mcp` (may still be present)
- `permissions: PermissionId[]`
- `tools: ManifestTool[]`
- `settings?: SettingFieldDescriptor[]`
- `tabs?: ManifestTab[]`

## 3.2 First-party identity binding

`firstParty: true` alone is not enough. Core validates folder-to-id binding with
`FIRST_PARTY_ALLOWLIST`.

Meaning:

- folder name must be allowlisted
- `manifest.id` must equal the allowlisted id for that folder
- modules cannot self-promote or impersonate another id

## 3.3 Runtime-specific fields

### `runtime: "inprocess"`

- `mcp` block must **not** be present
- `entry` must be relative and resolve inside module folder
- no absolute paths, no `..` escape

### `runtime: "mcp"`

Requires `mcp` object:

- `command: string` (no shell metacharacters `| & ; $ \``)
- `args: string[]`
- `env?: Record<string,string>`
  - keys/values cannot pass through Core secret names/references (`TELEGRAM_BOT_TOKEN`, `TOTP_SECRET_BASE32`, `PLAYER2_GAME_KEY`)
- `startupTimeoutMs?: number` (positive)
- `restartOnCrash?: boolean`

## 3.4 `permissions`

- must be array of known permission ids
- duplicates rejected
- unknown ids rejected

## 3.5 `tools[]`

Each entry:

- `name: string` (regex: `^[a-zA-Z_][a-zA-Z0-9_]{0,63}$`)
- `description: string`
- `parameters: object` (OpenAI function parameters schema)
- `requires: PermissionId[]`

Rules:

- tool names unique per module
- each `requires` permission must be known
- each `requires` permission must also be in `manifest.permissions`
- duplicate `requires` entries rejected

## 3.6 `settings[]` (optional)

Validated descriptors:

- `key` (`^[a-z][a-z0-9_]{0,63}$`, unique)
- `type`: `string | number | boolean | select`
- `label`: non-empty
- `description`: string
- `required`: boolean
- `sensitive`: boolean
- `default`: type-matched

Type-specific constraints:

- `number`: optional `min`/`max`, finite, `min <= max`
- `string`: optional regex `pattern`, optional `maxLength` (1..4096)
- `select`: non-empty `options` (<= 50), default must be in options

Limits:

- max 30 settings fields per module

## 3.7 `tabs[]` (optional)

Each tab:

- `id`: `^[a-z][a-z0-9_-]{0,31}$`, unique
- `title`: non-empty
- `order`: non-negative number (floored)

Limits:

- max 5 tabs per manifest

---

## 4) Capability catalog and risk

Core-owned fixed permission catalog:

Safe:

- `time.now`
- `log.info`
- `memory.read`
- `memory.write`
- `fs.read_public`

High-risk (TOTP-gated):

- `fs.read_private`
- `fs.write_any`
- `shell.execute`
- `process.spawn`
- `net.outbound`
- `credentials.read`

Notes:

- Catalog is fixed in Core (no runtime extension by modules).
- Effective tool risk is elevated to `high` if any required permission is high-risk.

---

## 5) All module hooks / interaction points

## 5.1 `Module.register(...)`

In-process module entry default-exports:

```ts
interface Module {
  register(args: {
    ctx: ModuleContext;
    contributeTool: (tool: ModuleTool) => void;
    contributeSettings: (fields: SettingFieldDescriptor[]) => void;
    contributeTab: (tab: ModuleTab) => void;
  }): void | Promise<void>;
}
```

### Hook: `contributeTool`

Registers LLM-facing tools. Core loader validates:

- contributed tool exists in manifest
- runtime `requires` exactly matches manifest `requires`
- all manifest-declared tools are actually contributed

### Hook: `contributeSettings`

Optional. Declares runtime settings schema.

- Contributed keys must be subset of manifest settings keys
- Core validates and persists values
- Defaults can be seeded at load

### Hook: `contributeTab`

Optional. Declares module HTML tab content provider.

- Contributed tab IDs must exist in manifest tabs
- Module returns **structured content only** (`TabContentDescriptor`), not raw HTML/JS injection

## 5.2 `ModuleContext` (what module code can call)

`ctx.moduleId`

Safe-ish utility surfaces:

- `ctx.log.info(msg)`
- `ctx.time.now()`
- `ctx.memory.read(key)` / `ctx.memory.write(key, value)` (module-scoped)
- `ctx.settings.read(key)` / `ctx.settings.write(key, value)` (module-scoped)
- `ctx.fs.readPublic(rel)` (module public dir sandbox)

High-risk brokered surfaces:

- `ctx.fs.readPrivate(abs)`
- `ctx.fs.writeAny(abs, data)`
- `ctx.shell.execute(cmd, args)`
- `ctx.process.spawn(cmd, args)`
- `ctx.net.fetch(url, init)` (currently phase-1 stub)
- `ctx.credentials.read(kind)` (currently phase-1 stub)

All methods flow through broker gate checks, approvals, and audit writes.

## 5.3 Tool registry integration

- Module tools are registered into the same central registry as built-ins.
- Registry computes effective risk and performs high-risk approval challenge.
- For approved module tools, registry enters broker grant-context (`runWithGrants`) so broker does not re-prompt inside same call.

## 5.4 Loader integration

`loadModules(...)` scans `src/extensions/*`, validates each module independently, and isolates failures.

Special gates:

- `dev-tools` folder loads only with `devMode: true`
- `mcp-echo` fixture loads only with `mcpVerify: true`

## 5.5 Runtime index / introspection

Loaded module summaries are indexed in-memory for debug surfaces:

- id/name/version/description/runtime/permissions/tool summaries
- settings schemas
- manifest tabs + registered tabs

## 5.6 MCP bridge interaction points

For `runtime: "mcp"` modules:

- Core host starts/stops/supervises stdio server
- Core discovers server tools
- Bridge registers only manifest-declared tools
- Undeclared server tools are ignored
- Missing declared tools are reported in bridge result

---

## 6) Security validation pipeline (end-to-end)

1. **Disk scan** of extension folders.
2. **Manifest parse + strict validation** (schema, runtime rules, permissions, tools, settings, tabs).
3. **Identity check** via folder->id allowlist binding.
4. **Load/register**:
   - inprocess: import entry, call `register`
   - mcp: start host, discover and bridge tools
5. **Cross-check** tool requires/runtime vs manifest declaration.
6. **Tool execution time**:
   - registry computes risk
   - high-risk requires TOTP approval (challenge TTL)
   - approved permissions propagated to broker grant-context
7. **Broker gate** for each primitive call:
   - declared?
   - known permission?
   - high-risk preapproved in active grant context?
8. **Policy enforcement** (fs sandbox/hard bans, subprocess limits, stubs).
9. **Audit logging** of permission decisions and operation events.

---

## 7) Hard limits and policy details

## 7.1 File policy

Public reads (`fs.read_public`):

- confined to `data/public/<moduleId>/...`
- requires non-empty relative path
- containment enforced
- file must exist, be regular file, <= 1 MiB

Private read (`fs.read_private`):

- absolute path required
- banned reads include `.env` family
- max read size 4 MiB

Write-any (`fs.write_any`):

- absolute path + string payload required
- max write payload 10 MiB
- hard write bans include:
  - `.env` family
  - audit log files
  - protected paths (`data/p2claw.db`, `package.json`, `tsconfig.json`, etc.)
  - source tree prefixes (`src`, `dist`, `scripts`)

## 7.2 Subprocess policy

For shell/process primitives:

- default timeout: 10s (clamped max 60s)
- stdout/stderr caps: 64 KiB each (clamped 1 KiB..1 MiB)
- cwd: repo root (`process.cwd()`)
- environment is allowlisted (no blanket env passthrough)
- timeout triggers SIGTERM then SIGKILL fallback

## 7.3 Approval behavior

- high-risk tools require TOTP secret configured
- challenge prompt includes bounded non-sensitive summary
- outcomes: approved / timeout / denied / cancelled / superseded
- failure returns structured error string to tool caller

---

## 8) Error and rejection semantics

## 8.1 Loader-level rejection

A bad module is rejected with `{ folder, code, reason }`; loading continues for others.

Common examples:

- invalid JSON / invalid schema fields
- first-party allowlist mismatch
- missing entry file
- register() missing or throws
- manifest tool declared but not contributed
- contributed tool/tab/settings not declared in manifest

## 8.2 Broker-level permission errors

`PermissionDeniedError` codes:

- `NOT_DECLARED`
- `DENIED`
- `TIMEOUT`
- `NO_TOTP`
- `NO_CHANNEL`

High-risk broker calls outside approved tool-call context are denied.

---

## 9) Minimal authoring templates

## 9.1 In-process `manifest.json` template

```json
{
  "id": "com.p2claw.your-module",
  "name": "Your Module",
  "version": "0.1.0",
  "description": "What this module does.",
  "runtime": "inprocess",
  "firstParty": true,
  "entry": "index.js",
  "permissions": ["log.info", "time.now"],
  "tools": [
    {
      "name": "your_tool",
      "description": "Example tool.",
      "parameters": {
        "type": "object",
        "properties": {
          "input": { "type": "string" }
        },
        "required": ["input"],
        "additionalProperties": false
      },
      "requires": ["log.info"]
    }
  ],
  "settings": [],
  "tabs": []
}
```

## 9.2 In-process `index.ts` template

```ts
import type { Module } from "../../modules/types.js";

const mod: Module = {
  register({ ctx, contributeTool, contributeSettings, contributeTab }) {
    contributeTool({
      schema: {
        type: "function",
        function: {
          name: "your_tool",
          description: "Example tool.",
          parameters: {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
            additionalProperties: false,
          },
        },
      },
      requires: ["log.info"],
      handler: async (args) => {
        await ctx.log.info(`your_tool called`);
        return JSON.stringify({ ok: true, input: args.input ?? null });
      },
    });

    // Optional: only if declared in manifest.settings
    contributeSettings([]);

    // Optional: only if declared in manifest.tabs
    // contributeTab({ id, title, order, renderContent: async () => ({ title, blocks: [...] }) });
  },
};

export default mod;
```

## 9.3 MCP `manifest.json` template

```json
{
  "id": "com.p2claw.your-mcp",
  "name": "Your MCP Module",
  "version": "0.1.0",
  "description": "MCP-backed tools.",
  "runtime": "mcp",
  "firstParty": true,
  "entry": "",
  "mcp": {
    "command": "node",
    "args": ["server.js"],
    "startupTimeoutMs": 15000,
    "restartOnCrash": true
  },
  "permissions": ["time.now"],
  "tools": [
    {
      "name": "echo",
      "description": "Echo tool from MCP server.",
      "parameters": { "type": "object", "properties": {}, "additionalProperties": false },
      "requires": ["time.now"]
    }
  ]
}
```

---

## 10) Practical checklist before shipping a module

- Manifest validates with strict schema + runtime rules.
- Folder name and `manifest.id` match allowlist binding.
- Every manifest tool is contributed exactly once.
- Every contributed tool’s `requires` exactly matches manifest declaration.
- No undeclared settings/tab contributions.
- High-risk permissions intentionally justified (minimal set).
- File/process operations assume Core caps and hard bans.
- Verify via `npm run verify` and boot logs (loaded vs rejected modules).

---

## 11) Important current-phase constraints

- Third-party in-process modules are not accepted in this phase.
- `net.outbound` and `credentials.read` are gate-checked but currently stubbed in broker.
- Modules cannot define new permissions.
- UI tabs are structured-data render only; no module-owned HTML/JS execution in Core UI context.

---

If you follow this file, you can author a module end-to-end without reading the rest of the codebase; consult implementation files only when you need deeper examples.
