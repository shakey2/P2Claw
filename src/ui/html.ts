/**
 * P2 Claw — Local HTML frontend (loopback HTTP only).
 *
 * Serves static assets from `html/public/` and JSON APIs for chat, approvals,
 * and config read/write. See DESIGN.md §2.1.2, §4.6.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  cancelPendingForChat,
} from "../security/approval.js";
import { requestGracefulShutdown } from "../graceful-shutdown.js";
import { handleDebugCommand } from "./debug.js";

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

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
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

  const handler = async (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const pathname = url.pathname;

    try {
      if (pathname === "/api/pending" && req.method === "GET") {
        const p = pendingBySession.get(sessionId);
        json(res, 200, { prompt: p?.prompt ?? null });
        return;
      }

      if (pathname === "/api/approve" && req.method === "POST") {
        if (!assertTrustedOrigin(req, res, config)) return;
        const body = await parseJsonBody(req);
        const code = String(body.code ?? "").replace(/\s+/g, "");
        const secret = config.totpSecretBase32?.trim();
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
        json(res, 200, { ok: true });
        requestGracefulShutdown();
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
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
        });
        server = null;
      }
    },
  };
}
