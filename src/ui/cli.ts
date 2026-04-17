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
import { clearHistory, compactHistory } from "../agent.js";
import { getMemoryCount, listMemories } from "../memory/index.js";
import {
  tryApprovePendingForChat,
  cancelPendingForChat,
} from "../security/approval.js";
import { requestGracefulShutdown } from "../graceful-shutdown.js";
import { handleDebugCommand, type DebugResult } from "./debug.js";

/** Conversation history key for CLI (separate from persisted memory scope). */
const CLI_SESSION_ID = 1;

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

/**
 * Splits a `/debug ...` line into subcommand + verbatim rest without
 * tokenising the tail. This matters because `/debug call <tool> <json>`
 * embeds JSON that may contain whitespace / quotes / braces.
 */
function parseDebugLine(
  line: string
): { subcommand: string; rest: string } {
  const trimmed = line.trim();
  const afterCmd = trimmed.replace(/^\/debug\b/, "").trimStart();
  if (!afterCmd) return { subcommand: "", rest: "" };
  const m = afterCmd.match(/^(\S+)(\s+([\s\S]*))?$/);
  if (!m) return { subcommand: afterCmd, rest: "" };
  return {
    subcommand: m[1] ?? "",
    rest: (m[3] ?? "").trim(),
  };
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
      const { subcommand, rest: debugRest } = parseDebugLine(line);
      const result = await handleDebugCommand({
        devMode: true,
        sessionId: CLI_SESSION_ID,
        subcommand,
        rest: debugRest,
        uiMode: "cli",
        totpSecretBase32: config.totpSecretBase32,
        memoryScopeId: config.memoryScopeId,
        sendPendingApproval: async (promptText: string) => {
          console.log(`\n${promptText}\n`);
          const secret = config.totpSecretBase32?.trim();
          if (!secret) {
            console.log(
              "TOTP is not configured. Set TOTP_SECRET_BASE32 in .env and restart."
            );
            return;
          }
          if (!isInteractive) {
            console.log(
              "Approval required, but CLI is non-interactive. Re-run in an interactive terminal."
            );
            return;
          }
          const raw = await ask(rl, "Enter 6-digit code or type CANCEL to abort: ");
          if (/^cancel$/i.test(raw.trim())) {
            const r = cancelPendingForChat(CLI_SESSION_ID);
            console.log(r.ok ? "Cancelled." : `Could not cancel: ${r.message}`);
            return;
          }
          const code = normalizeCode(raw);
          if (!/^\d{6}$/.test(code)) {
            console.log("Not a 6-digit code.");
            return;
          }
          const approvalResult = tryApprovePendingForChat(CLI_SESSION_ID, code, secret);
          console.log(
            approvalResult.ok ? "Approved." : `Not approved: ${approvalResult.message}`
          );
        },
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
      case "/help": {
        const lines = [
          "Commands:",
          "  /help         Show this help",
          "  /memories     List recent memories",
          "  /compact      Summarize older conversation history",
          "  /clear        Clear conversation history (memories unaffected)",
          "  /cancel       Abort a pending TOTP approval request",
          "  /totp_status  Whether TOTP is configured",
          "  /shutdown     Graceful shutdown",
          "  /exit         Quit CLI",
        ];
        if (config.devMode) {
          lines.push(
            "  /debug help   Developer diagnostics (P2CLAW_DEV_MODE=true)"
          );
        }
        console.log(lines.join("\n"));
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
          sendPendingApproval: async (promptText: string) => {
            console.log(`\n${promptText}\n`);
            const secret = config.totpSecretBase32?.trim();
            if (!secret) {
              console.log("TOTP is not configured. Set TOTP_SECRET_BASE32 in .env and restart.");
              return;
            }
            if (!isInteractive) {
              console.log("Approval required, but CLI is non-interactive. Re-run in an interactive terminal.");
              return;
            }
            const raw = await ask(rl, "Enter 6-digit code or type CANCEL to abort: ");
            if (/^cancel$/i.test(raw.trim())) {
              const r = cancelPendingForChat(CLI_SESSION_ID);
              console.log(r.ok ? "Cancelled." : `Could not cancel: ${r.message}`);
              return;
            }
            const code = normalizeCode(raw);
            if (!/^\d{6}$/.test(code)) {
              console.log("Not a 6-digit code.");
              return;
            }
            const result = tryApprovePendingForChat(CLI_SESSION_ID, code, secret);
            console.log(result.ok ? "Approved." : `Not approved: ${result.message}`);
          },
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
          sendPendingApproval: async (promptText: string) => {
            // Non-interactive cannot safely prompt for TOTP.
            console.log(promptText);
            console.log("Approval required, but CLI is non-interactive. Re-run in an interactive terminal.");
          },
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
            sendPendingApproval: async (promptText: string) => {
              console.log(`\n${promptText}\n`);
              const secret = config.totpSecretBase32?.trim();
              if (!secret) {
                console.log("TOTP is not configured. Set TOTP_SECRET_BASE32 in .env and restart.");
                return;
              }
              const raw = await ask(rl, "Enter 6-digit code or type CANCEL to abort: ");
              if (/^cancel$/i.test(raw.trim())) {
                const r = cancelPendingForChat(CLI_SESSION_ID);
                console.log(r.ok ? "Cancelled." : `Could not cancel: ${r.message}`);
                return;
              }
              const code = normalizeCode(raw);
              if (!/^\d{6}$/.test(code)) {
                console.log("Not a 6-digit code.");
                return;
              }
              const result = tryApprovePendingForChat(CLI_SESSION_ID, code, secret);
              console.log(result.ok ? "Approved." : `Not approved: ${result.message}`);
            },
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

