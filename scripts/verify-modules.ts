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
import { join } from "path";
const VERIFY_DIR = join(process.cwd(), "data", "verify-tmp");
const VERIFY_DB_PATH = join(VERIFY_DIR, "verify.db");
const VERIFY_AUDIT_PATH = join(VERIFY_DIR, "verify.audit.log");
process.env.P2CLAW_DB_PATH = VERIFY_DB_PATH;
process.env.P2CLAW_AUDIT_LOG_PATH = VERIFY_AUDIT_PATH;

import {
  validateManifest,
  ManifestValidationError,
  FIRST_PARTY_ALLOWLIST,
} from "../src/modules/manifest.js";
import { createBroker, runWithGrants } from "../src/modules/broker.js";
import { PermissionDeniedError } from "../src/modules/types.js";
import { loadModules } from "../src/modules/loader.js";
import {
  getAllToolSchemas,
  executeTool,
  getRegisteredTool,
  runAsDebugCall,
} from "../src/tools/registry.js";
import {
  listLoadedModules,
  getLoadedModule,
} from "../src/modules/runtime-index.js";
import { resolveAuditLogPath } from "../src/modules/audit.js";
import { initDatabase, closeDatabase } from "../src/memory/db.js";
import {
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "fs";

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
for (const p of [PUBLIC_DEMO_SAFE, PUBLIC_DEMO_HIGH]) {
  try {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
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
const validPath = join(process.cwd(), "src", "extensions", "demo-safe");

console.log("\n[1] Manifest validator");
check("rejects runtime: mcp", () =>
  expectError(
    () => validateManifest({ ...validBase, runtime: "mcp" }, validFolder, validPath),
    "ERR_MCP_NOT_IMPLEMENTED_PHASE1"
  )
);
check("rejects non-allowlisted firstParty folder", () =>
  expectError(
    () =>
      validateManifest(
        validBase,
        "rogue-module",
        join(process.cwd(), "src", "extensions", "rogue-module")
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
check("rejects dev-tools folder with spoofed id", () =>
  expectError(
    () =>
      validateManifest(
        {
          ...validBase,
          id: "com.evil.dev-tools",
        },
        "dev-tools",
        join(process.cwd(), "src", "extensions", "dev-tools")
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
const highManifest = validateManifest(
  {
    ...validBase,
    id: "com.p2claw.demo-high-risk",
    name: "Demo High Risk",
    permissions: ["shell.execute", "log.info"],
  },
  "demo-high-risk",
  join(process.cwd(), "src", "extensions", "demo-high-risk")
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

await check("high-risk call inside matching grant context succeeds (stub)", async () => {
  const result = await runWithGrants(["shell.execute"], "demo_shell", () =>
    highCtx.shell.execute("git", ["status"])
  );
  if (!result.stdout.includes("phase1-stub")) {
    throw new Error("expected stubbed stdout");
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
    if (!parsed.moduleId || !parsed.permission || !parsed.decision) {
      throw new Error("audit line missing fields: " + line);
    }
  }
});
check("audit log never exposes raw secrets", () => {
  const raw = readFileSync(auditPath, "utf-8");
  if (/TELEGRAM_BOT_TOKEN|TOTP_SECRET_BASE32/.test(raw)) {
    throw new Error("audit log contains secret-like keys");
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
  join(process.cwd(), "src", "extensions", "demo-safe")
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
  if (existsSync(VERIFY_DIR)) rmSync(VERIFY_DIR, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\n${failures === 0 ? "✅ All checks passed" : `❌ ${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
