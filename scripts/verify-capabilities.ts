import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import type { Capability } from "../src/security/capability-types.js";

const dbPath = join(process.cwd(), "data", "verify-core-security.db");
process.env.P2CLAW_SECURITY_DB_PATH = dbPath;

if (existsSync(dbPath)) {
  unlinkSync(dbPath);
}

const {
  initCoreSecurityDatabase,
  closeCoreSecurityDatabase,
} = await import("../src/security/core-security-db.js");
const {
  clearSessionCapabilities,
  createCapability,
  findMatchingCapability,
  listCapabilities,
  loadPersistentCapabilities,
  revokeAll,
  revokeCapability,
} = await import("../src/security/capability-store.js");

let failures = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${name}: ${message}`);
  }
}

function cap(overrides: Partial<Capability>): Capability {
  return {
    id: "",
    tool: "demo_tool",
    permission: "fs.read_private",
    scope: { type: "file", path: join(process.cwd(), "README.md") },
    riskLevel: "medium",
    createdAt: "",
    expiresAt: null,
    persistent: false,
    grantedVia: "approve_scoped",
    ...overrides,
  };
}

console.log("\n[capabilities] data model and store");
await initCoreSecurityDatabase();
loadPersistentCapabilities();

check("create + list stores a session capability", () => {
  const created = createCapability(cap({}));
  const listed = listCapabilities();
  if (!created.id) throw new Error("id was not assigned");
  if (!listed.find((entry) => entry.id === created.id)) {
    throw new Error("created capability was not listed");
  }
});

check("file scope matches only the same path", () => {
  revokeAll();
  const path = join(process.cwd(), "README.md");
  const created = createCapability(cap({ scope: { type: "file", path } }));
  const match = findMatchingCapability("demo_tool", "fs.read_private", { path });
  const miss = findMatchingCapability("demo_tool", "fs.read_private", {
    path: join(process.cwd(), "DESIGN.md"),
  });
  if (match?.id !== created.id) throw new Error("expected file capability match");
  if (miss) throw new Error("unexpected match for different file");
});

check("folder glob scope matches descendants", () => {
  revokeAll();
  const created = createCapability(
    cap({
      permission: "fs.write_any",
      riskLevel: "dangerous",
      scope: { type: "folder", pattern: "data/workspace/**" },
    })
  );
  const match = findMatchingCapability("demo_tool", "fs.write_any", {
    path: "data/workspace/notes/today.md",
  });
  const absoluteMatch = findMatchingCapability("demo_tool", "fs.write_any", {
    path: join(process.cwd(), "data", "workspace", "notes", "today.md"),
  });
  if (match?.id !== created.id) throw new Error("expected folder glob match");
  if (absoluteMatch?.id !== created.id) {
    throw new Error("expected folder glob match for absolute path");
  }
});

check("constraints reject oversized writes", () => {
  revokeAll();
  createCapability(
    cap({
      permission: "fs.write_any",
      riskLevel: "dangerous",
      scope: { type: "project" },
      constraints: { maxFileSize: 3 },
    })
  );
  const match = findMatchingCapability("demo_tool", "fs.write_any", {
    args: { content: "four" },
  });
  if (match) throw new Error("oversized payload matched constrained capability");
});

check("expired capabilities are pruned", () => {
  revokeAll();
  createCapability(
    cap({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    })
  );
  if (listCapabilities().length !== 0) {
    throw new Error("expired capability remained active");
  }
});

check("critical permissions cannot be saved", () => {
  revokeAll();
  let threw = false;
  try {
    createCapability(
      cap({
        permission: "credentials.read",
        riskLevel: "critical",
        scope: { type: "session" },
      })
    );
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("critical capability creation was allowed");
});

check("dangerous wildcard tool grants are rejected", () => {
  let threw = false;
  try {
    createCapability(
      cap({
        tool: "*",
        permission: "shell.execute",
        riskLevel: "dangerous",
        scope: { type: "session" },
      })
    );
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("dangerous wildcard capability was allowed");
});

check("revoke removes an active capability", () => {
  revokeAll();
  const created = createCapability(cap({}));
  if (!revokeCapability(created.id)) throw new Error("revoke returned false");
  if (findMatchingCapability("demo_tool", "fs.read_private", { path: created.scope.path })) {
    throw new Error("revoked capability still matched");
  }
});

check("clearSessionCapabilities preserves persistent grants only", () => {
  revokeAll();
  createCapability(cap({ persistent: false }));
  const persistent = createCapability(
    cap({
      id: "",
      tool: "read_tool",
      persistent: true,
      scope: { type: "session" },
    })
  );
  const removed = clearSessionCapabilities();
  if (removed !== 1) throw new Error(`expected 1 session grant removed, got ${removed}`);
  if (!listCapabilities().find((entry) => entry.id === persistent.id)) {
    throw new Error("persistent capability was removed");
  }
});

closeCoreSecurityDatabase();

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log("\n✅ Capability checks passed");
}
