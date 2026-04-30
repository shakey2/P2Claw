/**
 * P2 Claw — Local HTML frontend (loopback HTTP only).
 *
 * Serves static assets from `html/public/` and JSON APIs for chat, approvals,
 * and config read/write. See DESIGN.md §2.1.2, §4.6.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";
import type { Config } from "../config.js";
import type { Frontend } from "./frontend.js";
import { createAgentCore } from "./core.js";
import {
  clearHistory,
  compactHistory,
  getHistoryLength,
  getActiveProfile,
} from "../agent.js";
import { getMemoryCount, listMemories } from "../memory/index.js";
import { checkHealth, getJoules } from "../player2.js";
import { getToolCount } from "../tools/registry.js";
import {
  tryApprovePendingForChat,
  selectApprovalOption,
  cancelPendingForChat,
  getPendingChallengeForChat,
} from "../security/approval.js";
import {
  listCapabilities,
  revokeCapability,
  revokeAll,
} from "../security/capability-store.js";
import { requestGracefulShutdown } from "../graceful-shutdown.js";
import { handleDebugCommand } from "./debug.js";
import {
  getLoadedModule,
  getNavTabs,
  getModulesWithSettings,
  getRegisteredTab,
} from "../core/modules/runtime-index.js";
import {
  readAllModuleSettings,
  writeModuleSetting,
} from "../core/modules/settings-store.js";
import {
  validateSettingValue,
  coerceSettingValue,
} from "../core/modules/settings-schema.js";
import { writeSettingsEvent, resolveAuditLogPath } from "../core/modules/audit.js";
import type { TabContentBlock } from "../core/modules/types.js";
import { readFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "html", "public");
const ENV_PATH = path.join(process.cwd(), ".env");
const EXAMPLE_ENV_PATH = path.join(process.cwd(), ".env.example");

const CONFIG_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USER_IDS",
  "BOT_NAME",
  "UI_MODE",
  "USE_PROFILES",
  "DEFAULT_PROFILE",
  "MAX_AGENT_ITERATIONS",
  "DEFAULT_VOICE_MODE",
  "P2CLAW_MEMORY_CHAT_ID",
  "P2CLAW_LOG_RAW_MODEL",
  "TOTP_SECRET_BASE32",
  "HTML_UI_HOST",
  "HTML_UI_PORT",
] as const;

type ConfigKey = (typeof CONFIG_KEYS)[number];

type PendingApproval = {
  prompt: string;
  resolve: () => void;
};

const pendingBySession = new Map<number, PendingApproval>();

function parseJsonBody(
  req: http.IncomingMessage,
  limitBytes = 512_000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > limitBytes) {
        reject(new Error("Body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({});
          return;
        }
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function parseEnvFile(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (key) map.set(key, value);
  }
  return map;
}

function readEnvSnapshot(): Map<string, string> {
  try {
    return parseEnvFile(fs.readFileSync(ENV_PATH, "utf8"));
  } catch {
    try {
      return parseEnvFile(fs.readFileSync(EXAMPLE_ENV_PATH, "utf8"));
    } catch {
      return new Map<string, string>();
    }
  }
}

function writeFileAtomic(filePath: string, data: string): void {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, data, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function mergeEnvFile(updates: Partial<Record<ConfigKey, string>>): void {
  let existingText = "";
  try {
    existingText = fs.readFileSync(ENV_PATH, "utf8");
  } catch {
    try {
      existingText = fs.readFileSync(EXAMPLE_ENV_PATH, "utf8");
    } catch {
      existingText = "";
    }
  }

  const map = parseEnvFile(existingText);
  for (const key of CONFIG_KEYS) {
    const next = updates[key];
    if (next !== undefined) {
      map.set(key, next);
    }
  }

  if (fs.existsSync(EXAMPLE_ENV_PATH)) {
    const example = fs.readFileSync(EXAMPLE_ENV_PATH, "utf8");
    const outLines: string[] = [];
    const seen = new Set<string>();
    for (const rawLine of example.split(/\r?\n/)) {
      const m = rawLine.match(/^\s*#?\s*([A-Z0-9_]+)\s*=/);
      if (m) {
        const key = m[1]!;
        seen.add(key);
        const val = map.get(key);
        if (val !== undefined) {
          outLines.push(`${key}=${val}`);
          continue;
        }
      }
      outLines.push(rawLine);
    }
    for (const [k, v] of map) {
      if (!seen.has(k)) outLines.push(`${k}=${v}`);
    }
    writeFileAtomic(ENV_PATH, outLines.join("\n").replace(/\n+$/, "") + "\n");
    return;
  }

  const lines = [...map.entries()].map(([k, v]) => `${k}=${v}`);
  writeFileAtomic(ENV_PATH, lines.join("\n").replace(/\n+$/, "") + "\n");
}

function contentType(p: string): string {
  if (p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".css")) return "text/css; charset=utf-8";
  if (p.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (p.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function sendFile(res: http.ServerResponse, rel: string): void {
  const fp = path.join(PUBLIC_DIR, rel);
  if (!fp.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(fp, (err, data) => {
    if (err) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType(rel) });
    res.end(data);
  });
}

function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: http.OutgoingHttpHeaders = {}
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function isTrustedOrigin(req: http.IncomingMessage, config: Config): boolean {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:") return false;
    const host = u.hostname.toLowerCase();
    const loopbackHost = config.htmlBindHost.toLowerCase();
    const isLoopbackAlias =
      (loopbackHost === "127.0.0.1" && (host === "127.0.0.1" || host === "localhost")) ||
      (loopbackHost === "localhost" && (host === "127.0.0.1" || host === "localhost")) ||
      (loopbackHost === "::1" && host === "::1");
    const port = u.port ? parseInt(u.port, 10) : 80;
    return isLoopbackAlias && port === config.htmlBindPort;
  } catch {
    return false;
  }
}

function assertTrustedOrigin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: Config
): boolean {
  if (isTrustedOrigin(req, config)) {
    return true;
  }
  json(res, 403, { error: "forbidden_origin" });
  return false;
}

export function createHtmlFrontend(config: Config): Frontend {
  const core = createAgentCore(config);
  const sessionId = config.memoryScopeId;
  let server: http.Server | null = null;
  const sockets = new Set<Socket>();

  // ── Part H: HTML rendering helpers for module pages ─────────

  /** Escapes a string for safe HTML output (prevents XSS). */
  function htmlEscape(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** Validates a link href — only loopback origins or relative paths allowed. */
  function isSafeHref(href: string): boolean {
    if (href.startsWith("/")) return true;
    try {
      const u = new URL(href);
      const host = u.hostname.toLowerCase();
      return (
        u.protocol === "http:" &&
        (host === "127.0.0.1" || host === "localhost" || host === "::1")
      );
    } catch {
      return false;
    }
  }

  /** Renders a single TabContentBlock to safe HTML. */
  function renderBlock(block: TabContentBlock): string {
    switch (block.kind) {
      case "heading": {
        const tag = `h${Math.min(Math.max(block.level, 1), 3)}`;
        return `<${tag}>${htmlEscape(block.text)}</${tag}>`;
      }
      case "paragraph":
        return `<p>${htmlEscape(block.text)}</p>`;
      case "pre":
        return `<pre><code>${htmlEscape(block.text)}</code></pre>`;
      case "kv-table": {
        const rows = block.rows
          .map(
            (r) =>
              `<tr><td class="kv-key">${htmlEscape(r.key)}</td><td>${htmlEscape(r.value)}</td></tr>`
          )
          .join("");
        return `<table class="kv-table"><tbody>${rows}</tbody></table>`;
      }
      case "status": {
        const colors: Record<string, string> = {
          ok: "#34d399",
          warning: "#fbbf24",
          error: "#f87171",
        };
        const color = colors[block.value] ?? "#8b9aab";
        const detail = block.detail ? ` — ${htmlEscape(block.detail)}` : "";
        return `<p><span style="color:${color};font-weight:600">${htmlEscape(block.label)}: ${htmlEscape(block.value)}</span>${detail}</p>`;
      }
      case "settings-form":
        return `<div class="embedded-settings" data-module-id="${htmlEscape(block.moduleId)}">
          <p><a href="/modules/${encodeURIComponent(block.moduleId)}/settings">Open settings →</a></p>
        </div>`;
      default:
        return "";
    }
  }

  /** Wraps rendered content in the standard page shell. */
  function pageShell(title: string, subtitle: string, bodyHtml: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${htmlEscape(title)} · P2 Claw</title>
  <link rel="stylesheet" href="/assets/styles.css" />
  <style>
    .kv-table { width: 100%; max-width: 40rem; border-collapse: collapse; margin: 0.75rem 0; }
    .kv-table td { padding: 0.35rem 0.65rem; border-bottom: 1px solid #243040; }
    .kv-table .kv-key { color: #8b9aab; font-weight: 600; white-space: nowrap; width: 1%; }
    .mod-nav { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.5rem; }
    .mod-nav a { color: #6ec8ff; }
    pre { background: #151c24; padding: 0.75rem; border-radius: 6px; overflow-x: auto; }
  </style>
</head>
<body>
  <header class="top">
    <h1>${htmlEscape(title)}</h1>
    <p class="sub"><span class="product-name">P2 Claw</span> · ${htmlEscape(subtitle)}</p>
    <nav class="nav-row">
      <a href="/">Chat</a>
      <a href="/config">Config</a>
    </nav>
  </header>
  <main>
    ${bodyHtml}
  </main>
</body>
</html>`;
  }

  /** Renders a module settings page (auto-generated from schema). */
  function renderModuleSettingsPage(moduleId: string, moduleName: string, _config: Config): string {
    const body = `
    <div id="settingsRoot"></div>
    <p id="settingsMsg" class="msg" role="status" aria-live="polite"></p>
    <script>
    (function() {
      var root = document.getElementById("settingsRoot");
      var msgEl = document.getElementById("settingsMsg");
      var moduleId = ${JSON.stringify(moduleId)};

      function esc(s) { var d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

      fetch("/api/module-settings/" + encodeURIComponent(moduleId))
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.error) { root.textContent = data.error; return; }
          var fields = data.fields;
          var html = '<form id="msForm" class="setup">';
          for (var i = 0; i < fields.length; i++) {
            var f = fields[i];
            html += '<label>' + esc(f.label);
            if (f.type === "boolean") {
              html += '<select id="ms_' + esc(f.key) + '" data-key="' + esc(f.key) + '" data-type="boolean">';
              html += '<option value="true"' + (f.value === true ? ' selected' : '') + '>true</option>';
              html += '<option value="false"' + (f.value !== true ? ' selected' : '') + '>false</option>';
              html += '</select>';
            } else if (f.type === "select") {
              html += '<select id="ms_' + esc(f.key) + '" data-key="' + esc(f.key) + '" data-type="select">';
              var opts = f.options || [];
              for (var j = 0; j < opts.length; j++) {
                html += '<option value="' + esc(opts[j]) + '"' + (String(f.value) === opts[j] ? ' selected' : '') + '>' + esc(opts[j]) + '</option>';
              }
              html += '</select>';
            } else if (f.type === "number") {
              html += '<input id="ms_' + esc(f.key) + '" type="number" data-key="' + esc(f.key) + '" data-type="number"';
              if (f.min !== undefined) html += ' min="' + f.min + '"';
              if (f.max !== undefined) html += ' max="' + f.max + '"';
              html += ' value="' + esc(String(f.value)) + '" />';
            } else {
              html += '<input id="ms_' + esc(f.key) + '" type="' + (f.sensitive ? 'password' : 'text') + '" data-key="' + esc(f.key) + '" data-type="string"';
              if (f.maxLength) html += ' maxlength="' + f.maxLength + '"';
              html += ' value="' + esc(String(f.value)) + '"';
              if (f.sensitive && f.hasValue) html += ' placeholder="(set - hidden)"';
              html += ' />';
            }
            html += '</label>';
            if (f.description) html += '<p class="hint">' + esc(f.description) + '</p>';
          }
          html += '<button type="submit">Save</button></form>';
          root.innerHTML = html;
          document.getElementById("msForm").addEventListener("submit", function(e) {
            e.preventDefault();
            var vals = {};
            var inputs = root.querySelectorAll("[data-key]");
            for (var k = 0; k < inputs.length; k++) {
              var el = inputs[k];
              var key = el.getAttribute("data-key");
              var typ = el.getAttribute("data-type");
              var v = el.value;
              if (typ === "number") v = Number(v);
              else if (typ === "boolean") v = v === "true";
              if (el.type === "password" && v === "") continue;
              vals[key] = v;
            }
            fetch("/api/module-settings/" + encodeURIComponent(moduleId), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ values: vals })
            }).then(function(r) { return r.json(); })
              .then(function(j) {
                if (j.ok) { msgEl.textContent = "Saved."; msgEl.style.color = "#a7f3d0"; }
                else { msgEl.textContent = j.error || "Failed."; msgEl.style.color = "#fecaca"; }
              })
              .catch(function() { msgEl.textContent = "Request failed."; msgEl.style.color = "#fecaca"; });
          });
        })
        .catch(function(err) { root.textContent = "Failed to load settings: " + err.message; });
    })();
    </script>`;
    return pageShell(`${moduleName} Settings`, `module settings`, body);
  }

  /** Renders a module tab page from structured content blocks. */
  function renderTabPage(
    title: string,
    moduleName: string,
    blocks: readonly TabContentBlock[],
    _config: Config
  ): string {
    const body = blocks.map((b) => renderBlock(b)).join("\n    ");
    return pageShell(title, `${moduleName}`, body);
  }

  const handler = async (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const pathname = url.pathname;

    try {
      if (pathname === "/api/pending" && req.method === "GET") {
        const p = pendingBySession.get(sessionId);
        const challenge = getPendingChallengeForChat(sessionId);
        json(res, 200, {
          prompt: p?.prompt ?? null,
          challenge: challenge
            ? {
                challengeId: challenge.challengeId,
                toolName: challenge.toolName,
                risk: challenge.risk,
                expiresAt: challenge.expiresAt,
                approvalOptions: challenge.approvalOptions,
                scopeWarning: challenge.scopeWarning,
              }
            : null,
        });
        return;
      }

      if (pathname === "/api/approve" && req.method === "POST") {
        if (!assertTrustedOrigin(req, res, config)) return;
        const body = await parseJsonBody(req);
        const secret = config.totpSecretBase32?.trim();
        // New option-based approval: { challengeId, optionIndex, code? }
        const challengeId = typeof body.challengeId === "string" ? body.challengeId.trim() : "";
        const optionIndex = typeof body.optionIndex === "number" ? body.optionIndex : -1;
        const code = String(body.code ?? "").replace(/\s+/g, "");

        if (challengeId && optionIndex >= 0) {
          // New multi-option approval path
          const result = selectApprovalOption(
            sessionId,
            challengeId,
            optionIndex,
            secret ?? undefined,
            code || undefined
          );
          if (result.ok) {
            const pend = pendingBySession.get(sessionId);
            if (pend) {
              pendingBySession.delete(sessionId);
              pend.resolve();
            }
          }
          json(res, 200, { ok: result.ok, message: result.message });
          return;
        }

        // Legacy 6-digit-code-only path (backward compat)
        if (!secret) {
          json(res, 400, { ok: false, error: "TOTP not configured" });
          return;
        }
        if (!/^\d{6}$/.test(code)) {
          json(res, 400, { ok: false, error: "Expected 6-digit code" });
          return;
        }
        const result = tryApprovePendingForChat(sessionId, code, secret);
        if (result.ok) {
          const pend = pendingBySession.get(sessionId);
          if (pend) {
            pendingBySession.delete(sessionId);
            pend.resolve();
          }
        }
        json(res, 200, { ok: result.ok, message: result.message });
        return;
      }

      if (pathname === "/api/cancel" && req.method === "POST") {
        if (!assertTrustedOrigin(req, res, config)) return;
        const result = cancelPendingForChat(sessionId);
        if (result.ok) {
          const pend = pendingBySession.get(sessionId);
          if (pend) {
            pendingBySession.delete(sessionId);
            pend.resolve();
          }
        }
        json(res, 200, { ok: result.ok, message: result.message });
        return;
      }

      // ── Phase 4: Capability management APIs ─────────────────────

      if (pathname === "/api/capabilities" && req.method === "GET") {
        if (!assertTrustedOrigin(req, res, config)) return;
        const caps = listCapabilities();
        json(res, 200, {
          capabilities: caps.map((c) => ({
            id: c.id,
            tool: c.tool,
            permission: c.permission,
            scopeType: c.scope.type,
            scopePath: c.scope.path ?? c.scope.pattern ?? c.scope.command ?? null,
            riskLevel: c.riskLevel,
            createdAt: c.createdAt,
            expiresAt: c.expiresAt,
            persistent: c.persistent,
            grantedVia: c.grantedVia,
          })),
        });
        return;
      }

      if (pathname === "/api/capabilities/revoke" && req.method === "POST") {
        if (!assertTrustedOrigin(req, res, config)) return;
        const body = await parseJsonBody(req);
        const id = typeof body.id === "string" ? body.id.trim() : "";
        const all = body.all === true;
        if (all) {
          const count = revokeAll();
          json(res, 200, { ok: true, revoked: count });
          return;
        }
        if (!id) {
          json(res, 400, { ok: false, error: "id required" });
          return;
        }
        const revoked = revokeCapability(id);
        json(res, 200, { ok: revoked, message: revoked ? "Revoked." : "Not found." });
        return;
      }

      if (pathname === "/api/approval-history" && req.method === "GET") {
        if (!assertTrustedOrigin(req, res, config)) return;
        const entries: unknown[] = [];
        try {
          const logPath = resolveAuditLogPath();
          const raw = readFileSync(logPath, "utf-8");
          const lines = raw.split("\n").filter((l) => l.trim().length > 0);
          const capAndApprovalLines = lines
            .map((l) => {
              try {
                return JSON.parse(l) as Record<string, unknown>;
              } catch {
                return null;
              }
            })
            .filter(
              (entry): entry is Record<string, unknown> =>
                entry !== null &&
                (entry.kind === "approval_event" || entry.kind === "capability_event")
            );
          // Return last 50
          entries.push(...capAndApprovalLines.slice(-50));
        } catch {
          // File may not exist yet
        }
        json(res, 200, { entries });
        return;
      }

      if (pathname === "/api/chat" && req.method === "POST") {
        if (!assertTrustedOrigin(req, res, config)) return;
        const body = await parseJsonBody(req);
        const message = String(body.message ?? "").trim();
        if (!message) {
          json(res, 400, { error: "message required" });
          return;
        }
        const reply = await core.process(sessionId, message, {
          sendPendingApproval: async (promptText: string) => {
            await new Promise<void>((resolve) => {
              pendingBySession.set(sessionId, { prompt: promptText, resolve });
            });
          },
        });
        json(res, 200, { reply });
        return;
      }

      if (pathname === "/api/memories" && req.method === "GET") {
        if (!assertTrustedOrigin(req, res, config)) return;
        const count = await getMemoryCount(sessionId);
        const memories =
          count > 0
            ? await listMemories(sessionId, undefined, 50)
            : [];
        json(res, 200, {
          count,
          memories: memories.map((m) => ({
            id: m.id,
            category: m.category,
            content: m.content,
          })),
        });
        return;
      }

      if (pathname === "/api/clear" && req.method === "POST") {
        if (!assertTrustedOrigin(req, res, config)) return;
        const cleared = getHistoryLength(sessionId);
        clearHistory(sessionId);
        json(res, 200, { ok: true, cleared });
        return;
      }

      if (pathname === "/api/compact" && req.method === "POST") {
        if (!assertTrustedOrigin(req, res, config)) return;
        const result = await compactHistory(sessionId);
        if (result.error) {
          json(res, 200, { ok: false, error: result.error });
        } else {
          json(res, 200, {
            ok: true,
            before: result.before,
            after: result.after,
          });
        }
        return;
      }

      // Dev-mode-only diagnostic endpoint. When dev mode is off, the route
      // 404s so its existence is not leaked (matches the Telegram/CLI
      // "unknown command" posture from DESIGN.md §4.7).
      if (pathname === "/api/debug" && req.method === "POST") {
        if (!config.devMode) {
          res.writeHead(404).end("Not found");
          return;
        }
        if (!assertTrustedOrigin(req, res, config)) return;
        const body = await parseJsonBody(req);
        const subcommand = String(body.subcommand ?? "").trim();
        const rest = String(body.rest ?? "");
        const result = await handleDebugCommand({
          devMode: true,
          sessionId,
          subcommand,
          rest,
          uiMode: "html",
          totpSecretBase32: config.totpSecretBase32,
          memoryScopeId: config.memoryScopeId,
          // Same pending-approval plumbing /api/chat uses. The HTML client
          // polls /api/pending and POSTs /api/approve, so a high-risk
          // target tool invoked via /debug call surfaces exactly like a
          // normal agent-driven high-risk call.
          sendPendingApproval: async (promptText: string) => {
            await new Promise<void>((resolve) => {
              pendingBySession.set(sessionId, { prompt: promptText, resolve });
            });
          },
        });
        json(res, 200, { result });
        return;
      }

      if (pathname === "/api/config" && req.method === "GET") {
        const env = readEnvSnapshot();
        json(res, 200, {
          botName: env.get("BOT_NAME") ?? config.botName,
          telegramAllowedUserIds: env.get("TELEGRAM_ALLOWED_USER_IDS") ?? "",
          uiMode: env.get("UI_MODE") ?? "html",
          defaultVoiceMode: env.get("DEFAULT_VOICE_MODE") ?? "",
          maxAgentIterations: env.get("MAX_AGENT_ITERATIONS") ?? "",
          memoryChatId: env.get("P2CLAW_MEMORY_CHAT_ID") ?? "",
          useProfiles: (env.get("USE_PROFILES") ?? "").trim().toLowerCase() === "true",
          defaultProfile: env.get("DEFAULT_PROFILE") ?? "",
          logRawModel: (env.get("P2CLAW_LOG_RAW_MODEL") ?? "").trim().toLowerCase() === "true",
          htmlUiHost: env.get("HTML_UI_HOST") ?? config.htmlBindHost,
          htmlUiPort: env.get("HTML_UI_PORT") ?? String(config.htmlBindPort),
          hasTelegramBotToken: !!(env.get("TELEGRAM_BOT_TOKEN") ?? "").trim(),
          hasTotpSecretBase32: !!(env.get("TOTP_SECRET_BASE32") ?? "").trim(),
        });
        return;
      }

      if (pathname === "/api/config" && req.method === "POST") {
        if (!assertTrustedOrigin(req, res, config)) return;
        const body = await parseJsonBody(req);
        const updates: Partial<Record<ConfigKey, string>> = {};
        for (const key of CONFIG_KEYS) {
          const raw = body[key];
          if (raw === undefined || raw === null) {
            continue;
          }
          const val = String(raw).trim();
          if ((key === "TELEGRAM_BOT_TOKEN" || key === "TOTP_SECRET_BASE32") && val.length === 0) {
            continue;
          }
          updates[key] = val;
        }
        mergeEnvFile(updates);
        json(res, 200, { ok: true, message: "Saved .env. Restart P2 Claw to apply changes." });
        return;
      }

      if (pathname === "/api/status" && req.method === "GET") {
        let player2: { online: boolean; clientVersion?: string } = {
          online: false,
        };
        try {
          const health = await checkHealth();
          player2 = { online: true, clientVersion: health.client_version };
        } catch {
          player2 = { online: false };
        }
        let joules: { joules: number; patronTier: string | null } | null = null;
        try {
          const j = await getJoules();
          joules = {
            joules: j.joules,
            patronTier: j.patron_tier ?? null,
          };
        } catch {
          joules = null;
        }
        json(res, 200, {
          botName: config.botName,
          memoryScopeId: config.memoryScopeId,
          player2,
          joules,
          activeProfile: getActiveProfile(),
          toolCount: getToolCount(),
          conversationHistoryMessages: getHistoryLength(sessionId),
        });
        return;
      }

      // Loopback-only: same trust as local Telegram / CLI shutdown — not exposed remotely.
      if (pathname === "/api/shutdown" && req.method === "POST") {
        if (!assertTrustedOrigin(req, res, config)) return;
        res.once("finish", () => {
          setImmediate(requestGracefulShutdown);
        });
        json(res, 200, { ok: true }, { Connection: "close" });
        return;
      }

      // ── Part H: Module settings API ─────────────────────────────

      // GET /api/module-settings/:moduleId — returns schema + current values
      const settingsGetMatch = pathname.match(/^\/api\/module-settings\/([^/]+)$/);
      if (settingsGetMatch && req.method === "GET") {
        if (!assertTrustedOrigin(req, res, config)) return;
        const moduleId = decodeURIComponent(settingsGetMatch[1]!);
        const mod = getLoadedModule(moduleId);
        if (!mod || mod.settings.length === 0) {
          json(res, 404, { error: `module "${moduleId}" not found or has no settings` });
          return;
        }
        const stored = readAllModuleSettings(moduleId);
        const fields = mod.settings.map((f) => {
          const raw = stored.get(f.key);
          let value: string | number | boolean = f.default;
          if (raw !== undefined) {
            try { value = JSON.parse(raw); } catch { value = raw; }
            value = coerceSettingValue(f, String(value));
          }
          return {
            ...f,
            value: f.sensitive ? "" : value,
            hasValue: raw !== undefined,
          };
        });
        json(res, 200, { moduleId, moduleName: mod.name, fields });
        return;
      }

      // POST /api/module-settings/:moduleId — write values
      const settingsPostMatch = pathname.match(/^\/api\/module-settings\/([^/]+)$/);
      if (settingsPostMatch && req.method === "POST") {
        if (!assertTrustedOrigin(req, res, config)) return;
        const moduleId = decodeURIComponent(settingsPostMatch[1]!);
        const mod = getLoadedModule(moduleId);
        if (!mod || mod.settings.length === 0) {
          json(res, 404, { error: `module "${moduleId}" not found or has no settings` });
          return;
        }
        const body = await parseJsonBody(req);
        const values = body.values as Record<string, unknown> | undefined;
        if (!values || typeof values !== "object") {
          json(res, 400, { error: "body.values must be an object" });
          return;
        }
        const errors: Record<string, string> = {};
        const writes: Array<{ key: string; value: string | number | boolean; sensitive: boolean }> = [];
        for (const field of mod.settings) {
          if (!(field.key in values)) continue;
          const val = values[field.key];
          const result = validateSettingValue(field, val);
          if (!result.ok) {
            errors[field.key] = result.error;
            writeSettingsEvent({
              kind: "settings_event",
              moduleId,
              operation: "write",
              settingKey: field.key,
              outcome: "validation_error",
              sensitive: field.sensitive,
              error: result.error,
            });
            continue;
          }
          writes.push({ key: field.key, value: val as string | number | boolean, sensitive: field.sensitive });
        }
        if (Object.keys(errors).length > 0) {
          json(res, 400, { error: "validation_error", fields: errors });
          return;
        }
        // TODO: TOTP gate for sensitive fields (reuse existing challenge flow)
        // For now, write all values directly.
        for (const w of writes) {
          writeModuleSetting(moduleId, w.key, JSON.stringify(w.value));
          writeSettingsEvent({
            kind: "settings_event",
            moduleId,
            operation: "write",
            settingKey: w.key,
            valueHash: createHash("sha256").update(JSON.stringify(w.value)).digest("hex"),
            outcome: "success",
            sensitive: w.sensitive,
          });
        }
        json(res, 200, { ok: true, written: writes.length });
        return;
      }

      // GET /api/nav — returns navigation data including module tabs
      if (pathname === "/api/nav" && req.method === "GET") {
        json(res, 200, {
          tabs: getNavTabs(),
          modulesWithSettings: getModulesWithSettings(),
        });
        return;
      }

      // ── Part H: Module tab page routes ──────────────────────────

      const tabMatch = pathname.match(/^\/modules\/([^/]+)\/([^/]+)$/);
      if (tabMatch && req.method === "GET") {
        const moduleId = decodeURIComponent(tabMatch[1]!);
        const tabId = decodeURIComponent(tabMatch[2]!);

        // Auto-settings tab
        if (tabId === "settings") {
          const mod = getLoadedModule(moduleId);
          if (!mod || mod.settings.length === 0) {
            res.writeHead(404).end("Not found");
            return;
          }
          const html = renderModuleSettingsPage(moduleId, mod.name, config);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
          return;
        }

        // Contributed tab
        const tab = getRegisteredTab(moduleId, tabId);
        if (!tab) {
          res.writeHead(404).end("Not found");
          return;
        }
        try {
          const descriptor = await Promise.race([
            tab.renderContent(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Tab render timeout")), 5000)
            ),
          ]);
          const html = renderTabPage(tab.title, tab.moduleName, descriptor.blocks, config);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const html = renderTabPage(tab.title, tab.moduleName, [
            { kind: "status", label: "Error", value: "error", detail: msg },
          ], config);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        }
        return;
      }

      if (req.method === "GET") {
        if (pathname === "/" || pathname === "/index.html") {
          sendFile(res, "index.html");
          return;
        }
        if (pathname === "/config") {
          sendFile(res, "config.html");
          return;
        }
        if (pathname.startsWith("/assets/")) {
          sendFile(res, pathname.slice(1));
          return;
        }
        const clean = pathname.replace(/^\/+/, "");
        if (clean && !clean.includes("..")) {
          const fp = path.join(PUBLIC_DIR, clean);
          if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
            sendFile(res, clean);
            return;
          }
        }
      }

      res.writeHead(404).end("Not found");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      json(res, 500, { error: msg });
    }
  };

  return {
    start: async () => {
      server = http.createServer((req, res) => {
        void handler(req, res);
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => {
          sockets.delete(socket);
        });
      });
      await new Promise<void>((resolve, reject) => {
        server!.listen(config.htmlBindPort, config.htmlBindHost, () => resolve());
        server!.on("error", reject);
      });
      const base = `http://${config.htmlBindHost}:${config.htmlBindPort}`;
      console.log("");
      console.log("═══════════════════════════════════════════════════════════════");
      console.log(`  Local HTML GUI: ${base}`);
      console.log("  Open / for chat.");
      console.log("  Loopback only — not reachable from other machines.");
      console.log("  Press Ctrl+C to stop.");
      console.log("═══════════════════════════════════════════════════════════════");
      console.log("");
    },
    stop: async () => {
      if (server) {
        const closingServer = server;
        server = null;
        await new Promise<void>((resolve) => {
          const forceClose = setTimeout(() => {
            for (const socket of sockets) {
              socket.destroy();
            }
          }, 500);
          closingServer.close(() => {
            clearTimeout(forceClose);
            sockets.clear();
            resolve();
          });
          closingServer.closeIdleConnections?.();
        });
      }
    },
  };
}
