/**
 * P2 Claw — Phase 1 module framework verification harness.
 *
 * Exercises the manifest validator, the broker gate, the audit log, and the
 * loader. Does not spawn the full boot sequence. Run with:
 *
 *   npx tsx scripts/verify-modules.ts
 */

// Route persistence to verify-local paths BEFORE importing any module that
// might read these env vars. db.ts / audit.ts read them lazily, so setting
// them at top-level is sufficient even though ES imports are hoisted.
import { join, resolve } from "path";
const VERIFY_DIR = join(process.cwd(), "data", "verify-tmp");
const VERIFY_DB_PATH = join(VERIFY_DIR, "verify.db");
const VERIFY_AUDIT_PATH = join(VERIFY_DIR, "verify.audit.log");
process.env.P2CLAW_DB_PATH = VERIFY_DB_PATH;
process.env.P2CLAW_AUDIT_LOG_PATH = VERIFY_AUDIT_PATH;

import {
  validateManifest,
  ManifestValidationError,
  FIRST_PARTY_ALLOWLIST,
} from "../src/core/modules/manifest.js";
import { PERMISSION_CATALOG } from "../src/core/modules/permissions.js";
import { createBroker, runWithGrants } from "../src/core/modules/broker.js";
import { PermissionDeniedError } from "../src/core/modules/types.js";
import { loadModules, stopAllMcpHosts } from "../src/core/modules/loader.js";
import {
  getAllToolSchemas,
  executeTool,
  getRegisteredTool,
  runAsDebugCall,
} from "../src/tools/registry.js";
import {
  listLoadedModules,
  getLoadedModule,
} from "../src/core/modules/runtime-index.js";
import { resolveAuditLogPath } from "../src/core/modules/audit.js";
import { McpServerHost } from "../src/mcp/host.js";
import { initDatabase, closeDatabase } from "../src/memory/db.js";
import {
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "fs";
import { createHmac } from "crypto";
import { decodeBase32 } from "../src/security/totp.js";
import {
  tryApproveWithTotp,
  createChallenge,
  waitForApproval,
  getPendingChallengeForChat,
  cancelPendingForChat,
} from "../src/security/approval.js";
import {
  parseDebugTail,
  handleDebugCommand,
} from "../src/ui/debug.js";

// Fresh verify sandbox every run.
try {
  if (existsSync(VERIFY_DIR)) rmSync(VERIFY_DIR, { recursive: true, force: true });
} catch {
  /* ignore */
}
mkdirSync(VERIFY_DIR, { recursive: true });

// Also clean any stale data/public fixtures from a previous run so the
// cross-module-boundary check planted below is authoritative.
const PUBLIC_DEMO_SAFE = join(process.cwd(), "data", "public", "com.p2claw.demo-safe");
const PUBLIC_DEMO_HIGH = join(
  process.cwd(),
  "data",
  "public",
  "com.p2claw.demo-high-risk"
);
const WORKSPACE_ROOT = join(process.cwd(), "data", "workspace");
for (const p of [PUBLIC_DEMO_SAFE, PUBLIC_DEMO_HIGH]) {
  try {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
try {
  if (existsSync(WORKSPACE_ROOT)) rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
} catch {
  /* ignore */
}

const auditPath = VERIFY_AUDIT_PATH;

let failures = 0;

function check(name: string, fn: () => void | Promise<void>): void | Promise<void> {
  try {
    const out = fn();
    if (out instanceof Promise) {
      return out
        .then(() => console.log(`  ✓ ${name}`))
        .catch((err: unknown) => {
          failures++;
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`  ✗ ${name}: ${msg}`);
        });
    }
    console.log(`  ✓ ${name}`);
    return undefined;
  } catch (err) {
    failures++;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ✗ ${name}: ${msg}`);
    return undefined;
  }
}

function expectError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof ManifestValidationError && err.code === code) return;
    const ec = err instanceof ManifestValidationError ? err.code : "(not-manifest-err)";
    throw new Error(`expected code ${code}, got ${ec}: ${(err as Error).message}`);
  }
  throw new Error(`expected code ${code}, but no error was thrown`);
}

function currentTotpCode(secretBase32: string): string {
  const secret = decodeBase32(secretBase32.trim());
  const step = 30;
  const counter = BigInt(Math.floor(Date.now() / 1000 / step));
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const hmac = createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    (((hmac[offset]! & 0x7f) << 24) |
      ((hmac[offset + 1]! & 0xff) << 16) |
      ((hmac[offset + 2]! & 0xff) << 8) |
      (hmac[offset + 3]! & 0xff)) %
    1_000_000;
  return code.toString().padStart(6, "0");
}

const validBase = {
  id: "com.p2claw.demo-safe",
  name: "Demo Safe",
  version: "0.1.0",
  description: "valid demo",
  runtime: "inprocess",
  firstParty: true,
  entry: "index.js",
  permissions: ["log.info", "time.now"] as const,
  tools: [] as unknown[],
};
const validFolder = "demo-safe";
const validPath = join(process.cwd(), "src", "modules", "demo-safe");
const mcpFolder = "mcp-echo";
const mcpPath = join(process.cwd(), "src", "modules", "mcp-echo");

console.log("\n[1] Manifest validator");
check("permission catalog count stays at 11 broad categories", () => {
  if (PERMISSION_CATALOG.length !== 11) {
    throw new Error(
      `expected 11 permissions, got ${PERMISSION_CATALOG.length}; update the decision log before changing the catalog`
    );
  }
});
check("rejects runtime:mcp when mcp block is missing", () =>
  expectError(
    () =>
      validateManifest(
        { ...validBase, id: "com.p2claw.mcp-echo", runtime: "mcp" },
        mcpFolder,
        mcpPath
      ),
    "ERR_MCP_CONFIG_MISSING"
  )
);
check("rejects non-allowlisted firstParty folder", () =>
  expectError(
    () =>
      validateManifest(
        validBase,
        "rogue-module",
        join(process.cwd(), "src", "modules", "rogue-module")
      ),
    "ERR_FIRST_PARTY_NOT_ALLOWLISTED"
  )
);
check("rejects allowlisted folder with wrong id", () =>
  expectError(
    () =>
      validateManifest(
        { ...validBase, id: "com.evil.impostor" },
        validFolder,
        validPath
      ),
    "ERR_FIRST_PARTY_ID_MISMATCH"
  )
);
check("rejects unknown permission", () =>
  expectError(
    () =>
      validateManifest(
        { ...validBase, permissions: ["log.info", "made.up"] },
        validFolder,
        validPath
      ),
    "ERR_UNKNOWN_PERMISSION"
  )
);
check("rejects tool.requires not in module.permissions", () =>
  expectError(
    () =>
      validateManifest(
        {
          ...validBase,
          permissions: ["log.info"],
          tools: [
            {
              name: "x",
              description: "d",
              parameters: { type: "object", properties: {} },
              requires: ["shell.execute"],
            },
          ],
        },
        validFolder,
        validPath
      ),
    "ERR_TOOL_REQUIRES_UNDECLARED"
  )
);
check("rejects entry path escape", () =>
  expectError(
    () => validateManifest({ ...validBase, entry: "../evil.js" }, validFolder, validPath),
    "ERR_MANIFEST_ENTRY"
  )
);
check("accepts a valid manifest", () => {
  const m = validateManifest(validBase, validFolder, validPath);
  if (m.id !== validBase.id) throw new Error("id mismatch");
});
check("FIRST_PARTY_ALLOWLIST has dev-tools binding", () => {
  if (FIRST_PARTY_ALLOWLIST["dev-tools"] !== "com.p2claw.dev-tools") {
    throw new Error(
      "dev-tools not bound in FIRST_PARTY_ALLOWLIST; loader gate would rescue nothing"
    );
  }
});
check("FIRST_PARTY_ALLOWLIST has mcp-echo binding", () => {
  if (FIRST_PARTY_ALLOWLIST["mcp-echo"] !== "com.p2claw.mcp-echo") {
    throw new Error("mcp-echo not bound in FIRST_PARTY_ALLOWLIST");
  }
});
check("rejects dev-tools folder with spoofed id", () =>
  expectError(
    () =>
      validateManifest(
        {
          ...validBase,
          id: "com.evil.dev-tools",
        },
        "dev-tools",
        join(process.cwd(), "src", "modules", "dev-tools")
      ),
    "ERR_FIRST_PARTY_ID_MISMATCH"
  )
);

// ── [2] Broker gate ────────────────────────────────────────────
console.log("\n[2] Broker gate");
const manifest = validateManifest(validBase, validFolder, validPath);
const ctx = createBroker(manifest);

await check("undeclared broker call throws NOT_DECLARED", async () => {
  try {
    await ctx.shell.execute("echo", ["hi"]);
  } catch (err) {
    if (err instanceof PermissionDeniedError && err.code === "NOT_DECLARED") return;
    throw err;
  }
  throw new Error("expected throw");
});

await check("safe permission resolves", async () => {
  const now = await ctx.time.now();
  if (!(now instanceof Date)) throw new Error("time.now did not return Date");
});

// ── [3] Broker gate — high-risk without pre-approval ──────────
console.log("\n[3] Broker gate — high-risk");
const nodeCmd = process.execPath;
const quickScript = "process.stdout.write('verify-ok')";
const timeoutScript = "setInterval(() => {}, 1000)";
const hugeOutputScript =
  "process.stdout.write('A'.repeat(70000)); process.stderr.write('B'.repeat(70000));";

const highManifest = validateManifest(
  {
    ...validBase,
    id: "com.p2claw.demo-high-risk",
    name: "Demo High Risk",
    permissions: ["shell.execute", "process.spawn", "log.info"],
  },
  "demo-high-risk",
  join(process.cwd(), "src", "modules", "demo-high-risk")
);
const highCtx = createBroker(highManifest);

await check("high-risk call outside grant context throws NO_CHANNEL", async () => {
  try {
    await highCtx.shell.execute("git", ["status"]);
  } catch (err) {
    if (err instanceof PermissionDeniedError && err.code === "NO_CHANNEL") return;
    throw err;
  }
  throw new Error("expected throw");
});

await check("shell.execute runs a real command inside matching grant context", async () => {
  const result = await runWithGrants(["shell.execute"], "demo_shell", () =>
    highCtx.shell.execute(nodeCmd, ["-e", quickScript])
  );
  if (result.code !== 0 || !result.stdout.includes("verify-ok")) {
    throw new Error(`unexpected shell result: ${JSON.stringify(result)}`);
  }
  if (result.timedOut) {
    throw new Error("expected non-timeout shell execution");
  }
});

await check("high-risk call with mismatched grant throws DENIED", async () => {
  try {
    await runWithGrants(["log.info"], "wrong", () =>
      highCtx.shell.execute("git", [])
    );
  } catch (err) {
    if (err instanceof PermissionDeniedError && err.code === "DENIED") return;
    throw err;
  }
  throw new Error("expected throw");
});

await check("process.spawn runs a real command inside matching grant context", async () => {
  const result = await runWithGrants(["process.spawn"], "demo_spawn", () =>
    highCtx.process.spawn(nodeCmd, ["-e", quickScript])
  );
  if (result.code !== 0 || !result.stdout.includes("verify-ok")) {
    throw new Error(`unexpected spawn result: ${JSON.stringify(result)}`);
  }
  if (result.timedOut) {
    throw new Error("expected non-timeout spawn execution");
  }
});

await check("process.spawn enforces timeout for long-running command", async () => {
  const result = await runWithGrants(["process.spawn"], "demo_spawn_timeout", () =>
    highCtx.process.spawn(nodeCmd, ["-e", timeoutScript])
  );
  if (!result.timedOut) {
    throw new Error(`expected timeout=true, got: ${JSON.stringify(result)}`);
  }
});

await check("process.spawn marks stdout/stderr truncation when caps are exceeded", async () => {
  const result = await runWithGrants(["process.spawn"], "demo_spawn_truncate", () =>
    highCtx.process.spawn(nodeCmd, ["-e", hugeOutputScript])
  );
  if (!result.stdoutTruncated || !result.stderrTruncated) {
    throw new Error(`expected truncation flags, got: ${JSON.stringify(result)}`);
  }
});

// ── [4] Loader ────────────────────────────────────────────────
console.log("\n[4] Loader");
const result = await loadModules();
check("loader picked up demo-safe", () => {
  if (!result.loaded.find((m) => m.id === "com.p2claw.demo-safe")) {
    throw new Error("demo-safe not loaded: " + JSON.stringify(result));
  }
});
check("loader picked up demo-high-risk", () => {
  if (!result.loaded.find((m) => m.id === "com.p2claw.demo-high-risk")) {
    throw new Error("demo-high-risk not loaded: " + JSON.stringify(result));
  }
});
check("loader reported no rejections", () => {
  if (result.rejected.length !== 0) {
    throw new Error("rejections: " + JSON.stringify(result.rejected));
  }
});
check("demo_ping tool registered", () => {
  const schemas = getAllToolSchemas();
  if (!schemas.find((s) => s.function.name === "demo_ping")) {
    throw new Error("demo_ping not in registry");
  }
});
check("demo_shell tool registered", () => {
  const schemas = getAllToolSchemas();
  if (!schemas.find((s) => s.function.name === "demo_shell")) {
    throw new Error("demo_shell not in registry");
  }
});

// ── [5] Audit log ─────────────────────────────────────────────
console.log("\n[5] Audit log");
check("audit log exists and has JSONL lines", () => {
  if (!existsSync(auditPath)) throw new Error("audit log not written");
  const lines = readFileSync(auditPath, "utf-8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  if (lines.length === 0) throw new Error("audit log empty");
  for (const line of lines) {
    const parsed = JSON.parse(line);
    if (parsed.kind === "approval_event") {
      if (!parsed.toolName || !parsed.challengeId || !parsed.outcome) {
        throw new Error("approval_event missing fields: " + line);
      }
      continue;
    }
    if (parsed.kind === "subprocess_event") {
      if (!parsed.moduleId || !parsed.permission || !parsed.outcome) {
        throw new Error("subprocess_event missing fields: " + line);
      }
      continue;
    }
    if (!parsed.moduleId || !parsed.permission || !parsed.decision) {
      throw new Error("permission decision missing fields: " + line);
    }
  }
});
check("audit log never exposes raw secrets", () => {
  const raw = readFileSync(auditPath, "utf-8");
  if (/TELEGRAM_BOT_TOKEN|TOTP_SECRET_BASE32/.test(raw)) {
    throw new Error("audit log contains secret-like keys");
  }
});
check("audit log contains subprocess execution events", () => {
  const raw = readFileSync(auditPath, "utf-8");
  const needles = [
    '"kind":"subprocess_event"',
    '"permission":"shell.execute"',
    '"permission":"process.spawn"',
    '"outcome":"success"',
    '"outcome":"timeout"',
  ];
  for (const n of needles) {
    if (!raw.includes(n)) throw new Error(`audit missing pattern: ${n}`);
  }
});

// ── [6] executeTool + module tool integration ────────────────
console.log("\n[6] Tool registry integration");
await check("module tool with high perm returns TOTP-required error when secret missing", async () => {
  const out = await executeTool("demo_shell", { cmd: "echo", args: [] }, {});
  const parsed = JSON.parse(out);
  if (
    typeof parsed.error !== "string" ||
    !parsed.error.includes("TOTP_SECRET_BASE32")
  ) {
    throw new Error("expected TOTP-missing error, got: " + out);
  }
});

await check("module tool with safe perms runs without approval", async () => {
  const out = await executeTool("demo_ping", { note: "hello" }, {});
  const parsed = JSON.parse(out);
  if (!parsed.ok || parsed.module !== "com.p2claw.demo-safe") {
    throw new Error("unexpected output: " + out);
  }
});

// ── [7] Safe primitive integration — module memory + fs.readPublic ──
console.log("\n[7] Safe primitive integration");

// Initialise the verify-local SQLite DB so module_memory schema exists.
await initDatabase();

// Wire a live memory service into a fresh broker so we exercise the same
// code path that src/index.ts uses at boot.
const { readModuleMemory, writeModuleMemory } = await import(
  "../src/memory/module-store.js"
);
const demoSafeManifest = validateManifest(
  {
    id: "com.p2claw.demo-safe",
    name: "Demo Safe",
    version: "0.2.0",
    description: "verify ctx",
    runtime: "inprocess",
    firstParty: true,
    entry: "index.js",
    permissions: ["memory.read", "memory.write", "fs.read_public", "log.info"],
    tools: [],
  },
  "demo-safe",
  join(process.cwd(), "src", "modules", "demo-safe")
);
const safeCtx = createBroker(demoSafeManifest, {
  memory: {
    read: async (id, k) => readModuleMemory(id, k),
    write: async (id, k, v) => {
      writeModuleMemory(id, k, v);
    },
  },
});

await check("memory.write then memory.read round-trips a module-scoped value", async () => {
  await safeCtx.memory.write("greeting", "hello, phase 1.5");
  const got = await safeCtx.memory.read("greeting");
  if (got !== "hello, phase 1.5") {
    throw new Error(`expected roundtrip, got: ${String(got)}`);
  }
});

await check("memory.read returns null for an unknown key", async () => {
  const got = await safeCtx.memory.read("never-set");
  if (got !== null) throw new Error(`expected null, got: ${String(got)}`);
});

// Seed the public fixture for the demo-safe module.
mkdirSync(PUBLIC_DEMO_SAFE, { recursive: true });
writeFileSync(
  join(PUBLIC_DEMO_SAFE, "hello.txt"),
  "hello from public fixture",
  "utf-8"
);

await check("fs.readPublic returns contents for an allowed file", async () => {
  const body = await safeCtx.fs.readPublic("hello.txt");
  if (body !== "hello from public fixture") {
    throw new Error(`unexpected body: ${body}`);
  }
});

await check("fs.readPublic rejects parent-dir escape with DENIED", async () => {
  try {
    await safeCtx.fs.readPublic("../../../secret.txt");
  } catch (err) {
    if (err instanceof PermissionDeniedError && err.code === "DENIED") return;
    throw err;
  }
  throw new Error("expected PermissionDeniedError(DENIED)");
});

await check("fs.readPublic rejects absolute paths with DENIED", async () => {
  try {
    // Absolute paths resolve outside the module's base on every platform.
    const absoluteEscape =
      process.platform === "win32" ? "C:\\Windows\\system.ini" : "/etc/hosts";
    await safeCtx.fs.readPublic(absoluteEscape);
  } catch (err) {
    if (err instanceof PermissionDeniedError && err.code === "DENIED") return;
    throw err;
  }
  throw new Error("expected PermissionDeniedError(DENIED)");
});

// Cross-module boundary: plant a file under another module's public dir
// and make sure the demo-safe broker cannot reach it.
mkdirSync(PUBLIC_DEMO_HIGH, { recursive: true });
writeFileSync(
  join(PUBLIC_DEMO_HIGH, "other-module-secret.txt"),
  "must not be readable from demo-safe",
  "utf-8"
);

await check(
  "fs.readPublic cannot reach another module's public dir",
  async () => {
    try {
      await safeCtx.fs.readPublic(
        "../com.p2claw.demo-high-risk/other-module-secret.txt"
      );
    } catch (err) {
      if (err instanceof PermissionDeniedError && err.code === "DENIED") return;
      throw err;
    }
    throw new Error("expected PermissionDeniedError(DENIED)");
  }
);

await check("fs.readPublic rejects missing files with DENIED", async () => {
  try {
    await safeCtx.fs.readPublic("does-not-exist.txt");
  } catch (err) {
    if (err instanceof PermissionDeniedError && err.code === "DENIED") return;
    throw err;
  }
  throw new Error("expected PermissionDeniedError(DENIED)");
});

await check("audit log records granted memory + fs.read_public decisions", () => {
  const raw = readFileSync(auditPath, "utf-8");
  const needles = [
    '"permission":"memory.write"',
    '"permission":"memory.read"',
    '"permission":"fs.read_public"',
    '"decision":"granted"',
    '"decision":"denied"',
  ];
  for (const n of needles) {
    if (!raw.includes(n)) throw new Error(`audit missing pattern: ${n}`);
  }
});

// ── [8] Dev-tools module ──────────────────────────────────────
// [4] already ran `loadModules()` with default options (devMode off), so
// dev-tools must be absent. Then we re-run the loader with devMode=true.
// That re-scan will duplicate-reject the already-registered demo tools —
// those rejections are expected and are ignored below; we only care that
// dev-tools itself lands in the registry + runtime index.
console.log("\n[8] Dev-tools module");

check("off-by-default: dev-tools not loaded from [4]", () => {
  if (getRegisteredTool("debug_call_tool")) {
    throw new Error("debug_call_tool registered but devMode was off");
  }
  if (getLoadedModule("com.p2claw.dev-tools")) {
    throw new Error("dev-tools appears in runtime index with devMode off");
  }
});

const devLoadResult = await loadModules(
  {
    memory: {
      read: async (id, k) => readModuleMemory(id, k),
      write: async (id, k, v) => {
        writeModuleMemory(id, k, v);
      },
    },
  },
  { devMode: true }
);

check("on-behavior: loadModules picks up dev-tools", () => {
  if (!devLoadResult.loaded.find((m) => m.id === "com.p2claw.dev-tools")) {
    throw new Error(
      "dev-tools missing after devMode load: " +
        JSON.stringify(devLoadResult)
    );
  }
});

check("dev-tools contributes four debug tools, all risk=safe", () => {
  const expectedNames = [
    "debug_list_tools",
    "debug_inspect_module",
    "debug_tail_audit",
    "debug_call_tool",
  ];
  for (const name of expectedNames) {
    const meta = getRegisteredTool(name);
    if (!meta) throw new Error(`missing tool ${name}`);
    if (meta.effectiveRisk !== "safe") {
      throw new Error(
        `${name} effectiveRisk expected safe, got ${meta.effectiveRisk}`
      );
    }
    if (meta.ownerModuleId !== "com.p2claw.dev-tools") {
      throw new Error(`${name} ownerModuleId wrong: ${meta.ownerModuleId}`);
    }
  }
});

check("runtime index exposes dev-tools summary", () => {
  const summary = getLoadedModule("com.p2claw.dev-tools");
  if (!summary) throw new Error("dev-tools not in runtime index");
  if (summary.tools.length !== 4) {
    throw new Error(`unexpected tool count: ${summary.tools.length}`);
  }
  const all = listLoadedModules().map((m) => m.id);
  for (const want of [
    "com.p2claw.demo-safe",
    "com.p2claw.demo-high-risk",
    "com.p2claw.dev-tools",
  ]) {
    if (!all.includes(want)) throw new Error(`runtime index missing ${want}`);
  }
});

await check("debug_list_tools returns the full registry", async () => {
  const out = await executeTool("debug_list_tools", {}, {});
  const parsed = JSON.parse(out);
  if (!parsed.ok || !Array.isArray(parsed.tools)) {
    throw new Error("unexpected output: " + out);
  }
  const names: string[] = parsed.tools.map((t: { name: string }) => t.name);
  for (const want of ["demo_ping", "demo_shell", "debug_call_tool"]) {
    if (!names.includes(want)) throw new Error(`missing ${want}`);
  }
});

await check("debug_inspect_module returns demo-safe summary", async () => {
  const out = await executeTool(
    "debug_inspect_module",
    { moduleId: "com.p2claw.demo-safe" },
    {}
  );
  const parsed = JSON.parse(out);
  if (!parsed.module) throw new Error("module null: " + out);
  if (parsed.module.id !== "com.p2claw.demo-safe") {
    throw new Error("wrong id: " + out);
  }
  if (!parsed.module.permissions.includes("memory.read")) {
    throw new Error("permissions missing: " + out);
  }
  if (!parsed.module.tools.find((t: { name: string }) => t.name === "demo_ping")) {
    throw new Error("demo_ping missing: " + out);
  }
});

await check(
  "debug_tail_audit resolves the active audit log path (not hardcoded)",
  async () => {
    const out = await executeTool("debug_tail_audit", { n: 5 }, {});
    const parsed = JSON.parse(out);
    if (parsed.path !== resolveAuditLogPath()) {
      throw new Error(
        `debug_tail_audit.path=${parsed.path} but resolveAuditLogPath()=${resolveAuditLogPath()}`
      );
    }
    if (parsed.path !== VERIFY_AUDIT_PATH) {
      throw new Error(
        `debug_tail_audit used ${parsed.path}, not the verify override ${VERIFY_AUDIT_PATH}`
      );
    }
  }
);

await check("debug_call_tool rejects self-recursion", async () => {
  const out = await executeTool(
    "debug_call_tool",
    { target: "debug_call_tool", args: {} },
    {}
  );
  const parsed = JSON.parse(out);
  if (parsed.ok || !String(parsed.error).includes("itself")) {
    throw new Error("expected self-recursion rejection, got: " + out);
  }
});

await check("debug_call_tool rejects nested calls", async () => {
  // Simulate: a target somehow calls debug_call_tool again. We set the
  // in-flight marker manually and ensure the inner call rejects.
  await runAsDebugCall(async () => {
    const out = await executeTool(
      "debug_call_tool",
      { target: "demo_ping", args: { note: "x" } },
      {}
    );
    const parsed = JSON.parse(out);
    if (parsed.ok || !String(parsed.error).includes("nested")) {
      throw new Error("expected nested rejection, got: " + out);
    }
  });
});

await check(
  "debug_call_tool rejects unknown target with unknown_tool audit",
  async () => {
    const out = await executeTool(
      "debug_call_tool",
      { target: "no_such_tool_exists", args: {} },
      {}
    );
    const parsed = JSON.parse(out);
    if (parsed.ok || !String(parsed.error).includes("unknown tool")) {
      throw new Error("expected unknown tool error, got: " + out);
    }
  }
);

await check(
  "debug_call_tool: safe target runs end-to-end via registry re-entry",
  async () => {
    const out = await executeTool(
      "debug_call_tool",
      { target: "demo_ping", args: { note: "from-verify" } },
      { memoryScopeId: 1 }
    );
    const parsed = JSON.parse(out);
    if (!parsed.ok) throw new Error("expected ok: " + out);
    if (parsed.target !== "demo_ping") throw new Error("wrong target: " + out);
    if (parsed.effectiveRisk !== "safe") {
      throw new Error("wrong risk: " + out);
    }
    // raw is the target tool's stringified return. demo_ping returns
    // JSON with `ok: true` and `module: "com.p2claw.demo-safe"`.
    const rawParsed = JSON.parse(parsed.raw);
    if (!rawParsed.ok || rawParsed.module !== "com.p2claw.demo-safe") {
      throw new Error("unexpected raw: " + parsed.raw);
    }
  }
);

await check(
  "debug_call_tool: high-risk target still requires TOTP (not relaxed)",
  async () => {
    const out = await executeTool(
      "debug_call_tool",
      { target: "demo_shell", args: { cmd: "echo", args: [] } },
      {} // no totpSecretBase32
    );
    const parsed = JSON.parse(out);
    // debug_call_tool itself succeeds in running; it's the inner target
    // that surfaces the TOTP-missing error. The raw string should embed
    // that error verbatim so the developer sees the actual failure mode.
    if (!String(parsed.raw).includes("TOTP_SECRET_BASE32")) {
      throw new Error("expected TOTP-required error in raw, got: " + out);
    }
  }
);

check("audit log gained debug_invocation entries", () => {
  const raw = readFileSync(auditPath, "utf-8");
  const needles = [
    '"kind":"debug_invocation"',
    '"callerId":"com.p2claw.dev-tools"',
    '"result":"success"',
    '"result":"recursion_rejected"',
    '"result":"unknown_tool"',
  ];
  for (const n of needles) {
    if (!raw.includes(n)) throw new Error(`audit missing pattern: ${n}`);
  }
});

// -- [9] File-system surface -------------------------------------
console.log("\n[9] File-system surface");

const verifyTotpSecret = "JBSWY3DPEHPK3PXP";

async function executeHighRiskWithAutoApproval(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const chatId = 4242;
  return executeTool(name, args, {
    chatId,
    totpSecretBase32: verifyTotpSecret,
    sendPendingApproval: async (prompt) => {
      const m = /APPROVE\s+([a-f0-9]+)\s+<code>/i.exec(prompt);
      if (!m?.[1]) throw new Error("could not parse challenge id from approval prompt");
      const res = tryApproveWithTotp(
        chatId,
        m[1],
        currentTotpCode(verifyTotpSecret),
        verifyTotpSecret
      );
      if (!res.ok) throw new Error("auto-approval failed: " + res.message);
    },
  });
}

await check("file_read returns content for a seeded workspace file", async () => {
  mkdirSync(WORKSPACE_ROOT, { recursive: true });
  writeFileSync(join(WORKSPACE_ROOT, "seed.txt"), "seed-content", "utf-8");
  const out = await executeTool("file_read", { rel_path: "seed.txt" }, {});
  const parsed = JSON.parse(out);
  if (!parsed.ok || parsed.content !== "seed-content") {
    throw new Error("unexpected output: " + out);
  }
});

await check("file_read returns not found for missing file", async () => {
  const out = await executeTool("file_read", { rel_path: "missing.txt" }, {});
  const parsed = JSON.parse(out);
  if (!String(parsed.error).toLowerCase().includes("not found")) {
    throw new Error("expected not found error: " + out);
  }
});

await check("file_read rejects parent-dir escape", async () => {
  const out = await executeTool("file_read", { rel_path: "../../../.env" }, {});
  const parsed = JSON.parse(out);
  if (!String(parsed.error).toLowerCase().includes("sandbox denied")) {
    throw new Error("expected sandbox denial: " + out);
  }
});

await check("file_read rejects absolute path on this platform", async () => {
  const abs = process.platform === "win32" ? "C:\\Windows\\system.ini" : "/etc/hosts";
  const out = await executeTool("file_read", { rel_path: abs }, {});
  const parsed = JSON.parse(out);
  if (!String(parsed.error).toLowerCase().includes("sandbox denied")) {
    throw new Error("expected sandbox denial: " + out);
  }
});

await check("file_list returns entries for workspace root", async () => {
  mkdirSync(join(WORKSPACE_ROOT, "docs"), { recursive: true });
  writeFileSync(join(WORKSPACE_ROOT, "docs", "one.txt"), "1", "utf-8");
  const out = await executeTool("file_list", { rel_path: "docs" }, {});
  const parsed = JSON.parse(out);
  if (!parsed.ok || !Array.isArray(parsed.entries) || parsed.entries.length < 1) {
    throw new Error("expected directory entries: " + out);
  }
});

await check("file_list rejects parent-dir escape", async () => {
  const out = await executeTool("file_list", { rel_path: "..\\..\\.." }, {});
  const parsed = JSON.parse(out);
  if (!String(parsed.error).toLowerCase().includes("sandbox denied")) {
    throw new Error("expected sandbox denial: " + out);
  }
});

await check("file_write creates and overwrites files with approval", async () => {
  const first = await executeHighRiskWithAutoApproval("file_write", {
    rel_path: "notes/test.txt",
    content: "v1",
  });
  const firstParsed = JSON.parse(first);
  if (!firstParsed.ok) throw new Error("first write failed: " + first);
  const second = await executeHighRiskWithAutoApproval("file_write", {
    rel_path: "notes/test.txt",
    content: "v2-overwrite",
  });
  const secondParsed = JSON.parse(second);
  if (!secondParsed.ok) throw new Error("overwrite failed: " + second);
  const body = readFileSync(join(WORKSPACE_ROOT, "notes", "test.txt"), "utf-8");
  if (body !== "v2-overwrite") throw new Error(`overwrite mismatch: ${body}`);
});

await check("file_write rejects dot-env filenames with hard ban", async () => {
  const out = await executeHighRiskWithAutoApproval("file_write", {
    rel_path: ".env.local",
    content: "secret=1",
  });
  const parsed = JSON.parse(out);
  if (!String(parsed.error).includes("hard ban")) {
    throw new Error("expected hard-ban error: " + out);
  }
});

await check("file_write rejects sandbox escape to data/p2claw.db", async () => {
  const out = await executeHighRiskWithAutoApproval("file_write", {
    rel_path: "..\\p2claw.db",
    content: "x",
  });
  const parsed = JSON.parse(out);
  if (!String(parsed.error).toLowerCase().includes("sandbox denied")) {
    throw new Error("expected sandbox denied: " + out);
  }
});

const fsManifest = validateManifest(
  {
    id: "com.p2claw.demo-high-risk",
    name: "Demo High Risk",
    version: "0.2.0",
    description: "verify fs perms",
    runtime: "inprocess",
    firstParty: true,
    entry: "index.js",
    permissions: ["fs.read_private", "fs.write_any"],
    tools: [],
  },
  "demo-high-risk",
  join(process.cwd(), "src", "modules", "demo-high-risk")
);
const fsCtx = createBroker(fsManifest);

await check("broker fs.readPrivate denies .env even with grant context", async () => {
  try {
    await runWithGrants(["fs.read_private"], "verify_fs_read", () =>
      fsCtx.fs.readPrivate(resolve(process.cwd(), ".env"))
    );
  } catch (err) {
    if (err instanceof PermissionDeniedError && err.code === "DENIED") return;
    throw err;
  }
  throw new Error("expected PermissionDeniedError(DENIED)");
});

await check("broker fs.writeAny denies source-tree writes", async () => {
  try {
    await runWithGrants(["fs.write_any"], "verify_fs_write", () =>
      fsCtx.fs.writeAny(resolve(process.cwd(), "src", "blocked.txt"), "nope")
    );
  } catch (err) {
    if (err instanceof PermissionDeniedError && err.code === "DENIED") return;
    throw err;
  }
  throw new Error("expected PermissionDeniedError(DENIED)");
});

await check("audit log contains fs_event entries with banned outcomes", () => {
  const raw = readFileSync(auditPath, "utf-8");
  const needles = [
    '"kind":"fs_event"',
    '"operation":"read"',
    '"operation":"write"',
    '"outcome":"denied_ban"',
    '"banned":true',
  ];
  for (const n of needles) {
    if (!raw.includes(n)) throw new Error(`audit missing pattern: ${n}`);
  }
});

await check("audit fs_event pathSummary values avoid absolute paths", () => {
  const lines = readFileSync(auditPath, "utf-8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const fsEvents = lines
    .map((line) => JSON.parse(line))
    .filter((row) => row.kind === "fs_event");
  if (fsEvents.length === 0) {
    throw new Error("no fs_event records found");
  }
  for (const ev of fsEvents) {
    const summary = String(ev.pathSummary ?? "");
    if (summary.includes(":\\") || summary.startsWith("/") || summary.startsWith("\\")) {
      throw new Error("pathSummary appears absolute: " + summary);
    }
  }
});

await check("Windows-style separator paths remain sandboxed", async () => {
  const out = await executeTool("file_read", { rel_path: "docs\\one.txt" }, {});
  const parsed = JSON.parse(out);
  if (!parsed.ok) throw new Error("expected windows-separator success: " + out);
});

await check("UNC-like path is rejected by sandbox", async () => {
  const out = await executeTool("file_read", { rel_path: "\\\\server\\share\\x.txt" }, {});
  const parsed = JSON.parse(out);
  if (!String(parsed.error).toLowerCase().includes("sandbox denied")) {
    throw new Error("expected sandbox denial: " + out);
  }
});

await check("secret boundary: file_read cannot access .env", async () => {
  const out = await executeTool("file_read", { rel_path: "..\\.env" }, {});
  const parsed = JSON.parse(out);
  if (!String(parsed.error).toLowerCase().includes("sandbox denied")) {
    throw new Error("expected sandbox denial: " + out);
  }
});

// -- [10] MCP manifest validation ---------------------------------
console.log("\n[10] MCP manifest validation");

const mcpManifestBase = {
  id: "com.p2claw.mcp-echo",
  name: "MCP Echo Fixture",
  version: "0.1.0",
  description: "verify mcp",
  runtime: "mcp" as const,
  firstParty: true,
  permissions: ["log.info", "shell.execute"],
  mcp: {
    command: "node",
    args: ["echo-server.js"],
    startupTimeoutMs: 8000,
    restartOnCrash: true,
  },
  tools: [
    {
      name: "mcp_echo",
      description: "echo",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      requires: ["log.info"],
    },
    {
      name: "mcp_echo_high_risk",
      description: "echo high",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      requires: ["shell.execute"],
    },
  ],
};

check("rejects mcp command with shell metacharacters", () =>
  expectError(
    () =>
      validateManifest(
        {
          ...mcpManifestBase,
          mcp: { ...mcpManifestBase.mcp, command: "node && whoami" },
        },
        mcpFolder,
        mcpPath
      ),
    "ERR_MCP_COMMAND_UNSAFE"
  )
);

check("rejects mcp env secret passthrough", () =>
  expectError(
    () =>
      validateManifest(
        {
          ...mcpManifestBase,
          mcp: {
            ...mcpManifestBase.mcp,
            env: { TELEGRAM_BOT_TOKEN: "x" },
          },
        },
        mcpFolder,
        mcpPath
      ),
    "ERR_MCP_ENV_INVALID"
  )
);

check("accepts valid mcp manifest", () => {
  const m = validateManifest(mcpManifestBase, mcpFolder, mcpPath);
  if (m.runtime !== "mcp" || !m.mcp) {
    throw new Error("expected runtime mcp with mcp config");
  }
});

// -- [11] MCP echo server startup ---------------------------------
console.log("\n[11] MCP echo startup");

const mcpLoadResult = await loadModules(
  {
    memory: {
      read: async (id, k) => readModuleMemory(id, k),
      write: async (id, k, v) => {
        writeModuleMemory(id, k, v);
      },
    },
  },
  { mcpVerify: true, mcpCallTimeoutMs: 2_000 }
);

check("loader picks up mcp-echo fixture when mcpVerify=true", () => {
  if (!mcpLoadResult.loaded.find((m) => m.id === "com.p2claw.mcp-echo")) {
    throw new Error("mcp-echo not loaded: " + JSON.stringify(mcpLoadResult));
  }
});

check("mcp_echo tool registered with owner module id", () => {
  const meta = getRegisteredTool("mcp_echo");
  if (!meta) throw new Error("mcp_echo missing");
  if (meta.ownerModuleId !== "com.p2claw.mcp-echo") {
    throw new Error("owner mismatch: " + JSON.stringify(meta));
  }
});

check("runtime index shows mcp runtime for fixture", () => {
  const summary = getLoadedModule("com.p2claw.mcp-echo");
  if (!summary) throw new Error("mcp-echo missing from runtime index");
  if (summary.runtime !== "mcp") {
    throw new Error(`expected runtime=mcp, got ${summary.runtime}`);
  }
});

// -- [12] MCP tool invocation -------------------------------------
console.log("\n[12] MCP tool invocation");

await check("mcp_echo returns structured json text", async () => {
  const out = await executeTool(
    "mcp_echo",
    { message: "hello", payload: { source: "verify" } },
    {}
  );
  const parsed = JSON.parse(out);
  if (!parsed.ok || parsed.message !== "hello") {
    throw new Error("unexpected mcp_echo payload: " + out);
  }
});

await check("audit log contains successful mcp_event", async () => {
  const raw = readFileSync(auditPath, "utf-8");
  const needles = [
    '"kind":"mcp_event"',
    '"serverId":"com.p2claw.mcp-echo"',
    '"toolName":"mcp_echo"',
    '"outcome":"success"',
  ];
  for (const n of needles) {
    if (!raw.includes(n)) throw new Error(`audit missing pattern: ${n}`);
  }
});

// -- [13] MCP approval flow ---------------------------------------
console.log("\n[13] MCP approval flow");

await check("high-risk mcp tool requires TOTP without secret", async () => {
  const out = await executeTool("mcp_echo_high_risk", { message: "no-secret" }, {});
  const parsed = JSON.parse(out);
  if (!String(parsed.error).includes("TOTP_SECRET_BASE32")) {
    throw new Error("expected TOTP-required error: " + out);
  }
});

await check("high-risk mcp tool succeeds with approval", async () => {
  const out = await executeHighRiskWithAutoApproval("mcp_echo_high_risk", {
    message: "approved",
  });
  const parsed = JSON.parse(out);
  if (!parsed.ok || parsed.message !== "approved") {
    throw new Error("unexpected high-risk mcp output: " + out);
  }
});

await check("audit log contains approval + mcp event for high-risk call", async () => {
  const raw = readFileSync(auditPath, "utf-8");
  const needles = [
    '"kind":"approval_event"',
    '"toolName":"mcp_echo_high_risk"',
    '"outcome":"approved"',
    '"kind":"mcp_event"',
  ];
  for (const n of needles) {
    if (!raw.includes(n)) throw new Error(`audit missing pattern: ${n}`);
  }
});

// -- [14] MCP failure handling ------------------------------------
console.log("\n[14] MCP failure handling");

await check("startup timeout is surfaced for non-speaking process", async () => {
  const timeoutManifest = validateManifest(
    {
      ...mcpManifestBase,
      mcp: {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        startupTimeoutMs: 300,
        restartOnCrash: false,
      },
      tools: [mcpManifestBase.tools[0]],
      permissions: ["log.info"],
    },
    mcpFolder,
    mcpPath
  );
  const host = new McpServerHost(timeoutManifest, {
    defaultCallTimeoutMs: 300,
    cwd: mcpPath,
  });
  try {
    await host.start();
    throw new Error("expected startup timeout");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.toLowerCase().includes("timed out")) {
      throw new Error("expected startup timeout message, got: " + msg);
    }
  } finally {
    await host.stop();
  }
});

await check("invalid protocol handshake is surfaced during initialize", async () => {
  const mismatchScript = join(VERIFY_DIR, "mcp-protocol-mismatch.mjs");
  writeFileSync(
    mismatchScript,
    `
process.stdin.setEncoding("utf8");
let sent = false;
function send(msg) {
  const body = JSON.stringify(msg);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body, "utf8") + "\\r\\n\\r\\n" + body);
}
process.stdin.on("data", (chunk) => {
  if (sent) return;
  const text = String(chunk);
  const m = /"id"\\s*:\\s*(\\d+)/.exec(text);
  if (!m) return;
  sent = true;
  send({
    jsonrpc: "2.0",
    id: Number(m[1]),
    result: {
      protocolVersion: "1900-01-01",
      capabilities: { tools: {} },
      serverInfo: { name: "bad-protocol", version: "0.0.1" }
    }
  });
});
setInterval(() => {}, 1000);
`,
    "utf-8"
  );

  const mismatchManifest = validateManifest(
    {
      ...mcpManifestBase,
      mcp: {
        command: process.execPath,
        args: [mismatchScript],
        startupTimeoutMs: 1000,
        restartOnCrash: false,
      },
      tools: [mcpManifestBase.tools[0]],
      permissions: ["log.info"],
    },
    mcpFolder,
    mcpPath
  );
  const host = new McpServerHost(mismatchManifest, {
    defaultCallTimeoutMs: 300,
    cwd: mcpPath,
  });
  try {
    await host.start();
    throw new Error("expected protocol mismatch");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    if (!lower.includes("protocol") && !lower.includes("timed out")) {
      throw new Error("expected protocol or handshake failure, got: " + msg);
    }
  } finally {
    await host.stop();
  }
});

await check("call timeout is surfaced when mcp tool blocks", async () => {
  const timeoutCallManifest = validateManifest(mcpManifestBase, mcpFolder, mcpPath);
  const host = new McpServerHost(timeoutCallManifest, {
    defaultCallTimeoutMs: 100,
    cwd: mcpPath,
  });
  try {
    await host.start();
    await host.callTool("mcp_echo", { message: "slow", delayMs: 500 }, 100);
    throw new Error("expected call timeout");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.toLowerCase().includes("timed out")) {
      throw new Error("expected timeout message, got: " + msg);
    }
  } finally {
    await host.stop();
  }
});

await check("disconnect/crash during call is surfaced", async () => {
  const crashManifest = validateManifest(mcpManifestBase, mcpFolder, mcpPath);
  const host = new McpServerHost(crashManifest, {
    defaultCallTimeoutMs: 1000,
    cwd: mcpPath,
  });
  try {
    await host.start();
    await host.callTool("mcp_echo", { crash: true }, 500);
    throw new Error("expected disconnect error");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    if (
      !lower.includes("failed") &&
      !lower.includes("not connected") &&
      !lower.includes("disconnected")
    ) {
      throw new Error("expected disconnect-style error, got: " + msg);
    }
  } finally {
    await host.stop();
  }
});

// -- [15] MCP audit coverage --------------------------------------
console.log("\n[15] MCP audit coverage");

await check("audit log contains mcp lifecycle + failure outcomes", async () => {
  const raw = readFileSync(auditPath, "utf-8");
  const needles = [
    '"kind":"mcp_lifecycle"',
    '"kind":"mcp_event"',
    '"outcome":"success"',
    '"outcome":"timeout"',
    '"outcome":"disconnected"',
    '"event":"crashed"',
  ];
  for (const n of needles) {
    if (!raw.includes(n)) throw new Error(`audit missing pattern: ${n}`);
  }
});

// -- [16] Stubbed high-risk gate coverage --------------------------
console.log("\n[16] Stubbed high-risk gate coverage");

const stubManifest = validateManifest(
  {
    id: "com.p2claw.demo-high-risk",
    name: "Demo High Risk",
    version: "0.3.0",
    description: "verify stubbed high-risk gates",
    runtime: "inprocess",
    firstParty: true,
    entry: "index.js",
    permissions: ["net.outbound", "credentials.read"],
    tools: [],
  },
  "demo-high-risk",
  join(process.cwd(), "src", "modules", "demo-high-risk")
);
const stubCtx = createBroker(stubManifest);

await check("net.fetch outside grant context throws NO_CHANNEL", async () => {
  try {
    await stubCtx.net.fetch("https://example.test");
  } catch (err) {
    if (err instanceof PermissionDeniedError && err.code === "NO_CHANNEL") return;
    throw err;
  }
  throw new Error("expected PermissionDeniedError(NO_CHANNEL)");
});

await check("net.fetch inside matching grant returns the controlled stub", async () => {
  const result = await runWithGrants(["net.outbound"], "verify_net_stub", () =>
    stubCtx.net.fetch("https://example.test", { method: "POST" })
  );
  if (result.status !== 0 || !result.body.startsWith("[phase1-stub] net.fetch(")) {
    throw new Error(`unexpected net.fetch stub result: ${JSON.stringify(result)}`);
  }
});

await check("credentials.read outside grant context throws NO_CHANNEL", async () => {
  try {
    await stubCtx.credentials.read("totp");
  } catch (err) {
    if (err instanceof PermissionDeniedError && err.code === "NO_CHANNEL") return;
    throw err;
  }
  throw new Error("expected PermissionDeniedError(NO_CHANNEL)");
});

await check("credentials.read inside matching grant returns the controlled stub", async () => {
  const result = await runWithGrants(["credentials.read"], "verify_credentials_stub", () =>
    stubCtx.credentials.read("totp")
  );
  if (!result.startsWith("[phase1-stub] credentials.read(")) {
    throw new Error(`unexpected credentials.read stub result: ${result}`);
  }
});

await check("audit log contains granted and denied net/credentials decisions", async () => {
  const raw = readFileSync(auditPath, "utf-8");
  const needles = [
    '"permission":"net.outbound"',
    '"permission":"credentials.read"',
    '"decision":"granted"',
    '"decision":"denied"',
  ];
  for (const n of needles) {
    if (!raw.includes(n)) throw new Error(`audit missing pattern: ${n}`);
  }
});

// -- [17] CLI/HTML approval UX — Core layer -----------------------
console.log("\n[17] CLI/HTML approval UX — Core layer");

await check("bad_code is non-terminal: challenge stays pending", async () => {
  const chatId = 9001;
  const { challengeId } = createChallenge(chatId, "high_risk_demo", { x: 1 });
  const badResult = tryApproveWithTotp(chatId, challengeId, "000000", verifyTotpSecret);
  if (badResult.ok) throw new Error("bad code should not be ok");
  const snap = getPendingChallengeForChat(chatId);
  if (!snap || snap.challengeId !== challengeId) {
    throw new Error("challenge should still be pending after bad code");
  }
  cancelPendingForChat(chatId);
});

await check("retry succeeds: bad code then correct code on same challenge", async () => {
  const chatId = 9002;
  const { challengeId } = createChallenge(chatId, "high_risk_demo", { x: 1 });
  const approvalPromise = waitForApproval(challengeId);
  tryApproveWithTotp(chatId, challengeId, "000000", verifyTotpSecret);
  const good = tryApproveWithTotp(
    chatId,
    challengeId,
    currentTotpCode(verifyTotpSecret),
    verifyTotpSecret
  );
  if (!good.ok) throw new Error("retry with correct code should succeed");
  const outcome = await approvalPromise;
  if (outcome !== "approved") throw new Error(`expected approved, got ${outcome}`);
});

await check("cancel after bad code resolves with cancelled", async () => {
  const chatId = 9003;
  const { challengeId } = createChallenge(chatId, "high_risk_demo", { x: 1 });
  const approvalPromise = waitForApproval(challengeId);
  tryApproveWithTotp(chatId, challengeId, "000000", verifyTotpSecret);
  const r = cancelPendingForChat(chatId);
  if (!r.ok) throw new Error("cancel should succeed");
  const outcome = await approvalPromise;
  if (outcome !== "cancelled") throw new Error(`expected cancelled, got ${outcome}`);
});

check("audit log records bad_code events from retry cases", () => {
  const raw = readFileSync(auditPath, "utf-8");
  if (!raw.includes('"outcome":"bad_code"')) {
    throw new Error("expected bad_code audit record");
  }
});

// -- [18] Frontend parity — shared abstractions -------------------
console.log("\n[18] Frontend parity — shared abstractions");

check("parseDebugTail: empty tail", () => {
  const r = parseDebugTail("");
  if (r.subcommand !== "" || r.rest !== "") {
    throw new Error(`expected empty, got ${JSON.stringify(r)}`);
  }
});

check("parseDebugTail: subcommand only", () => {
  const r = parseDebugTail("list");
  if (r.subcommand !== "list" || r.rest !== "") {
    throw new Error(`unexpected: ${JSON.stringify(r)}`);
  }
});

check("parseDebugTail: preserves JSON after first token (verbatim tail)", () => {
  const r = parseDebugTail('call demo_ping {"note":"x"}');
  if (r.subcommand !== "call" || r.rest !== 'demo_ping {"note":"x"}') {
    throw new Error(`unexpected: ${JSON.stringify(r)}`);
  }
});

await check("handleDebugCommand: devMode off returns disabled", async () => {
  const r = await handleDebugCommand({
    devMode: false,
    sessionId: 1,
    subcommand: "list",
    rest: "",
    uiMode: "cli",
  });
  if (r.kind !== "disabled") {
    throw new Error(`expected disabled, got ${r.kind}`);
  }
});

await check("handleDebugCommand: devMode on list returns tools", async () => {
  const r = await handleDebugCommand({
    devMode: true,
    sessionId: 1,
    subcommand: "list",
    rest: "",
    uiMode: "cli",
  });
  if (r.kind !== "list" || !Array.isArray(r.tools) || r.tools.length < 1) {
    throw new Error(`expected list with tools, got ${JSON.stringify(r)}`);
  }
});

await check("handleDebugCommand: unknown subcommand", async () => {
  const r = await handleDebugCommand({
    devMode: true,
    sessionId: 1,
    subcommand: "unknown_xyz",
    rest: "",
    uiMode: "cli",
  });
  if (r.kind !== "unknown_subcommand" || r.subcommand !== "unknown_xyz") {
    throw new Error(`expected unknown_subcommand, got ${JSON.stringify(r)}`);
  }
});

await stopAllMcpHosts();

// Close the DB so the debounced save doesn't fire after process exit.
closeDatabase();

// Clean up verify-only fixtures under data/public/ so the repo stays tidy.
for (const p of [PUBLIC_DEMO_SAFE, PUBLIC_DEMO_HIGH]) {
  try {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
try {
  if (existsSync(WORKSPACE_ROOT)) rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
} catch {
  /* ignore */
}
try {
  if (existsSync(VERIFY_DIR)) rmSync(VERIFY_DIR, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\n${failures === 0 ? "✅ All checks passed" : `❌ ${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
