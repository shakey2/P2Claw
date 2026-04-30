/**
 * P2 Claw — CLI frontend (REPL).
 *
 * Power-user interface that runs the same agent/tool loop as Telegram.
 * Audio features (STT/TTS) are intentionally not included.
 */

import readline from "readline";
import type { Config } from "../config.js";
import type { Frontend } from "./frontend.js";
import { createAgentCore } from "./core.js";
import {
  clearHistory,
  compactHistory,
  getHistoryLength,
  setActiveProfile,
  getActiveProfile,
} from "../agent.js";
import { checkHealth, getJoules, listProfiles } from "../player2.js";
import { getToolCount } from "../tools/registry.js";
import { getMemoryCount, listMemories } from "../memory/index.js";
import {
  tryApprovePendingForChat,
  selectApprovalOption,
  cancelPendingForChat,
  hasPendingApprovalForChat,
} from "../security/approval.js";
import { requestGracefulShutdown } from "../graceful-shutdown.js";
import {
  listCapabilities,
  revokeCapability,
  revokeAll,
} from "../security/capability-store.js";
import {
  handleDebugCommand,
  parseDebugTail,
  type DebugResult,
} from "./debug.js";

/** Conversation history key for CLI (separate from persisted memory scope). */
const CLI_SESSION_ID = 1;

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

/**
 * Pretty-prints a structured DebugResult for the CLI. Plain text only —
 * no Markdown, no colour codes — so output stays predictable when piped
 * through tools like `jq` or `rg`.
 */
function renderDebugForCli(result: DebugResult): string {
  switch (result.kind) {
    case "help":
      return result.lines.join("\n");
    case "list": {
      const lines = result.tools.map((t) => {
        const owner = t.ownerModuleId ?? "core";
        const perms = t.requiredPermissions.length
          ? t.requiredPermissions.join(", ")
          : "(none)";
        return `  ${t.name}  [${t.effectiveRisk}]  owner=${owner}  perms=${perms}`;
      });
      return `Tools (${result.tools.length}):\n${lines.join("\n")}`;
    }
    case "modules": {
      const lines = result.modules.map(
        (m) => `  ${m.id}  v${m.version}  perms=[${m.permissions.join(", ") || "none"}]  tools=${m.tools.length}`
      );
      return `Loaded modules (${result.modules.length}):\n${lines.join("\n")}`;
    }
    case "inspect_module":
      if (!result.module) {
        return `No loaded module with id "${result.moduleId}".`;
      }
      return JSON.stringify(result.module, null, 2);
    case "audit": {
      const header = result.note
        ? `Audit: ${result.path}\n(${result.note})`
        : `Audit: ${result.path}\nLast ${result.entries.length} of ${result.n} requested:`;
      return [header, ...result.entries].join("\n");
    }
    case "call":
      return [
        `call  ${result.meta.target}  risk=${result.meta.effectiveRisk}  owner=${result.meta.targetOwnerModuleId ?? "core"}  outcome=${result.meta.outcome}`,
        "raw:",
        result.meta.raw,
      ].join("\n");
    case "perms": {
      const i = result.info;
      const pending = i.pendingChallenge
        ? `pending: tool=${i.pendingChallenge.toolName} expiresAt=${new Date(i.pendingChallenge.expiresAt).toISOString()}`
        : "pending: (none — approvals are ephemeral one-shot challenges)";
      return [
        `tool: ${i.tool}`,
        `owner: ${i.ownerModuleId ?? "core"}`,
        `required: ${i.requiredPermissions.join(", ") || "(none)"}`,
        `effectiveRisk: ${i.effectiveRisk}`,
        `totpConfigured: ${i.totpConfigured}`,
        pending,
      ].join("\n");
    }
    case "unknown_subcommand":
      return `Unknown /debug subcommand: "${result.subcommand}". Try /debug help.`;
    case "error":
      return `Error: ${result.message}`;
    case "disabled":
      return "";
  }
}

function normalizeCode(text: string): string {
  return text.replace(/\s+/g, "");
}

function getArgMessage(): string {
  // In UI_MODE=cli, allow one-shot usage:
  //   npm run start -- "hello"
  //   scripts/cli.bat "hello"
  const args = process.argv.slice(2);
  return args.join(" ").trim();
}

async function readStdinAll(): Promise<string> {
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").trim()));
    process.stdin.resume();
  });
}

/**
 * Shared high-risk approval UX: print Core prompt, then loop on readline until
 * approved, cancelled, TTL expiry, or supersede. Bad TOTP codes are non-terminal
 * (challenge stays pending) — same semantics as Telegram middleware.
 */
function buildCliApprovalHook(
  rl: readline.Interface,
  sessionId: number,
  totpSecretBase32: string | undefined,
  isInteractive: boolean
): (promptText: string) => Promise<void> {
  return async (promptText: string) => {
    console.log(`\n${promptText}\n`);
    const secret = totpSecretBase32?.trim();
    if (!secret) {
      console.log(
        "TOTP is not configured. Set TOTP_SECRET_BASE32 in .env and restart."
      );
      return;
    }
    if (!isInteractive) {
      console.log(
        "Approval required, but CLI is non-interactive. " +
          "The pending action will time out. Re-run in a TTY to approve."
      );
      return;
    }
    while (hasPendingApprovalForChat(sessionId)) {
      const raw = await ask(rl, "Enter APPROVE <id> <option> [code], 6-digit code, or CANCEL: ");
      const trimmed = raw.trim();
      if (/^cancel$/i.test(trimmed)) {
        const r = cancelPendingForChat(sessionId);
        console.log(r.ok ? "Cancelled." : `Could not cancel: ${r.message}`);
        return;
      }
      const full = trimmed.match(/^APPROVE\s+([a-f0-9]{8})\s+(\d{6})\s*$/i);
      const optioned = trimmed.match(/^APPROVE\s+([a-f0-9]{8})\s+(\d+)(?:\s+(\d{6}))?\s*$/i);
      if (full || optioned) {
        const result = full
          ? selectApprovalOption(sessionId, full[1]!.toLowerCase(), 0, secret, full[2])
          : selectApprovalOption(
              sessionId,
              optioned![1]!.toLowerCase(),
              Number(optioned![2]) - 1,
              secret,
              optioned![3]
            );
        if (result.ok) {
          console.log("Approved.");
          return;
        }
        console.log(`Not approved: ${result.message} Try again or type CANCEL.`);
        continue;
      }
      const code = normalizeCode(raw);
      if (!/^\d{6}$/.test(code)) {
        console.log("Expected an APPROVE command, 6-digit code, or CANCEL. Try again.");
        continue;
      }
      const result = tryApprovePendingForChat(sessionId, code, secret);
      if (result.ok) {
        console.log("Approved.");
        return;
      }
      console.log(
        `Not approved: ${result.message} Try again or type CANCEL.`
      );
    }
    console.log("Challenge expired or was superseded.");
  };
}

export function createCliFrontend(config: Config): Frontend {
  const core = createAgentCore(config);
  const isInteractive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  // PowerShell/Windows terminals can behave oddly with readline's "terminal" mode
  // (cursor control / screen redraw). Disable it on win32 for stability.
  const enableTerminalMode = isInteractive && process.platform !== "win32";
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: enableTerminalMode,
  });

  let running = false;
  let chain: Promise<void> = Promise.resolve();
  const sendPendingApproval = buildCliApprovalHook(
    rl,
    CLI_SESSION_ID,
    config.totpSecretBase32,
    isInteractive
  );

  async function handleSlashCommand(line: string): Promise<boolean> {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const args = rest.join(" ").trim();

    // /debug is parsed specially: the tail may contain JSON with whitespace,
    // quotes, and braces that a generic tokeniser would mangle. We also
    // short-circuit to "unknown command" when devMode is off, matching the
    // Telegram + HTML frontends' behaviour (no information leak).
    if (cmd === "/debug") {
      if (!config.devMode) {
        console.log(`Unknown command: ${cmd}`);
        return true;
      }
      const { subcommand, rest: debugRest } = parseDebugTail(
        line.trim().replace(/^\/debug\b/, "").trimStart()
      );
      const result = await handleDebugCommand({
        devMode: true,
        sessionId: CLI_SESSION_ID,
        subcommand,
        rest: debugRest,
        uiMode: "cli",
        totpSecretBase32: config.totpSecretBase32,
        memoryScopeId: config.memoryScopeId,
        sendPendingApproval,
      });
      const text = renderDebugForCli(result);
      if (text) console.log(text);
      return true;
    }

    switch (cmd) {
      case "/exit":
      case "/quit": {
        running = false;
        rl.close();
        return true;
      }
      case "/shutdown": {
        requestGracefulShutdown();
        return true;
      }
      case "/clear": {
        clearHistory(CLI_SESSION_ID);
        console.log("Conversation cleared.");
        return true;
      }
      case "/compact": {
        console.log("Compacting conversation history...");
        const result = await compactHistory(CLI_SESSION_ID);
        if (result.error) {
          console.log(`Compaction failed: ${result.error}`);
        } else {
          console.log(`Compacted: ${result.before} → ${result.after} messages`);
        }
        return true;
      }
      case "/memories": {
        const count = await getMemoryCount(config.memoryScopeId);
        console.log(`Memories: ${count}`);
        if (count > 0) {
          const mems = await listMemories(config.memoryScopeId, undefined, 20);
          for (const m of mems) {
            console.log(`#${m.id} (${m.category}) ${m.content}`);
          }
        }
        return true;
      }
      case "/cancel": {
        const r = cancelPendingForChat(CLI_SESSION_ID);
        console.log(r.ok ? "Cancelled. The pending action has been aborted." : r.message);
        return true;
      }
      case "/totp_status": {
        console.log(config.totpSecretBase32?.trim() ? "TOTP: configured." : "TOTP: not configured.");
        return true;
      }
      case "/totp_enroll_help": {
        console.log(
          [
            "TOTP (RFC 6238) for high-risk tools (Google Authenticator, Aegis, etc.):",
            "",
            "1. Generate a random Base32 secret (20+ bytes of entropy).",
            "2. In your authenticator app, add a manual key with that secret.",
            "3. Put the same value in .env as TOTP_SECRET_BASE32= (no quotes).",
            "4. Restart the bot. Check with /totp_status.",
            "",
            "When a high-risk tool runs, reply with only the 6-digit code, or:",
            "APPROVE <challengeId> <6-digit-code>",
            "",
            "To abort without approving, reply:",
            "CANCEL",
          ].join("\n")
        );
        return true;
      }
      case "/status": {
        const lines: string[] = ["P2 Claw status:\n"];
        try {
          const health = await checkHealth();
          lines.push(`Player2 App: Online (v${health.client_version})`);
        } catch {
          lines.push("Player2 App: Offline or unreachable");
        }
        try {
          const joules = await getJoules();
          lines.push(`Joules: ${joules.joules.toLocaleString()}`);
          lines.push(`Patron: ${joules.patron_tier || "None"}`);
        } catch {
          lines.push("Joules: Unable to fetch");
        }
        const activeProfile = getActiveProfile();
        lines.push("");
        lines.push(`Active profile: ${activeProfile || "Default"}`);
        lines.push(`Tools loaded: ${getToolCount()}`);
        lines.push(
          `Conversation history: ${getHistoryLength(CLI_SESSION_ID)} messages`
        );
        console.log(lines.join("\n"));
        return true;
      }
      case "/profile": {
        if (!config.useProfiles) {
          console.log(
            "Profile switching is disabled.\n\n" +
              "To enable it, set USE_PROFILES=true in your .env file.\n" +
              "This is a Player2 Patron feature."
          );
          return true;
        }
        if (args) {
          try {
            const profiles = await listProfiles();
            const found = profiles.find(
              (p) => p.name.toLowerCase() === args.toLowerCase()
            );
            if (found) {
              setActiveProfile(found.name);
              console.log(
                `Switched to profile: ${found.name}\nBase URL: ${found.base_url}`
              );
            } else {
              const available = profiles.map((p) => `  - ${p.name}`).join("\n");
              console.log(
                `Profile "${args}" not found.\n\nAvailable profiles:\n${available}`
              );
            }
          } catch {
            console.log("Failed to fetch profiles from Player2.");
          }
          return true;
        }
        try {
          const profiles = await listProfiles();
          if (profiles.length === 0) {
            console.log(
              "No profiles configured.\n" +
                "Create profiles in the Player2 App settings."
            );
            return true;
          }
          const active = getActiveProfile();
          const profileList = profiles
            .map((p) => `  - ${p.name}${p.name === active ? "  (active)" : ""}`)
            .join("\n");
          console.log(
            `AI Profiles:\n\n${profileList}\n\nTo switch: /profile <name>\nCurrent: ${active || "Default"}`
          );
        } catch {
          console.log("Failed to fetch profiles from Player2.");
        }
        return true;
      }
      case "/help": {
        const lines = [
          "Commands:",
          "  /help              Show this help",
          "  /status            Check Player2 health, joules, profile, tools",
          "  /profile [name]    List or switch AI profiles (USE_PROFILES=true)",
          "  /memories          List recent memories",
          "  /compact           Summarize older conversation history",
          "  /clear             Clear conversation history (memories unaffected)",
          "  /cancel            Abort a pending TOTP approval request",
          "  /caps [list|revoke|revoke-all]  Manage capabilities",
          "  /totp_status       Whether TOTP is configured",
          "  /totp_enroll_help  Set up Google Authenticator for high-risk tools",
          "  /shutdown          Graceful shutdown",
          "  /exit              Quit CLI",
        ];
        if (config.devMode) {
          lines.push(
            "  /debug help   Developer diagnostics (P2CLAW_DEV_MODE=true)"
          );
        }
        console.log(lines.join("\n"));
        return true;
      }
      case "/caps": {
        const sub = rest[0]?.toLowerCase();
        if (sub === "revoke-all") {
          const count = revokeAll();
          console.log(`Revoked ${count} capability(ies).`);
          return true;
        }
        if (sub === "revoke" && rest.length > 1) {
          const id = rest.slice(1).join(" ").trim();
          const revoked = revokeCapability(id);
          console.log(revoked ? `Revoked capability ${id}.` : `Capability ${id} not found.`);
          return true;
        }
        // Default: list
        const caps = listCapabilities();
        if (caps.length === 0) {
          console.log("No active capabilities.");
          return true;
        }
        console.log(`Active capabilities (${caps.length}):\n`);
        for (const cap of caps) {
          const scope = cap.scope.path ?? cap.scope.pattern ?? cap.scope.command ?? cap.scope.type;
          const expiry = cap.expiresAt
            ? `expires ${new Date(cap.expiresAt).toISOString()}`
            : cap.persistent ? "permanent" : "session";
          console.log(
            `  ${cap.id.slice(0, 8)}  ${cap.tool}  [${cap.riskLevel}]  ${cap.permission}  scope=${scope}  ${expiry}  via=${cap.grantedVia}`
          );
        }
        console.log(`\nUse /caps revoke <id> or /caps revoke-all.`);
        return true;
      }
      default: {

        if (cmd.startsWith("/")) {
          console.log(`Unknown command: ${cmd}`);
          if (args) void args;
          return true;
        }
        return false;
      }
    }
  }

  return {
    start: async () => {
      running = true;
      const argMsg = getArgMessage();
      if (argMsg) {
        const response = await core.process(CLI_SESSION_ID, argMsg, {
          sendPendingApproval,
        });
        process.stdout.write(`${response}\n`);
        requestGracefulShutdown();
        return;
      }

      if (!isInteractive) {
        // Non-interactive mode: try args first, then stdin.
        const stdinMsg = await readStdinAll();
        const msg = (argMsg || stdinMsg).trim();
        if (!msg) {
          console.log(
            "CLI (non-interactive) usage:\n" +
              "  scripts/cli.bat \"your message here\"\n" +
              "  npm run start -- \"your message here\"   (with UI_MODE=cli)\n" +
              "  echo \"your message\" | npm run start\n"
          );
          requestGracefulShutdown();
          return;
        }

        const response = await core.process(CLI_SESSION_ID, msg, {
          sendPendingApproval,
        });
        process.stdout.write(`${response}\n`);
        requestGracefulShutdown();
        return;
      }

      process.stdout.write("P2 Claw CLI mode. Type /help for commands.\n\n");
      rl.setPrompt("> ");
      rl.prompt();

      rl.on("line", (line) => {
        chain = chain.then(async () => {
          if (!running) return;
          const text = line.trim();
          if (!text) {
            rl.prompt();
            return;
          }

          if (await handleSlashCommand(text)) {
            if (running) rl.prompt();
            return;
          }

          const response = await core.process(CLI_SESSION_ID, text, {
            sendPendingApproval,
          });

          console.log(`\n${response}\n`);
          rl.prompt();
        }).catch((err: unknown) => {
          console.error("CLI error:", err);
          try {
            rl.prompt();
          } catch {
            /* ignore */
          }
        });
      });

      // Wait until stop() closes the interface.
      await new Promise<void>((resolve) => rl.once("close", () => resolve()));
    },
    stop: async () => {
      running = false;
      try {
        rl.close();
      } catch {
        /* ignore */
      }
    },
  };
}

