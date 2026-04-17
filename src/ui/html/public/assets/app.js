const log = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("input");
const approval = document.getElementById("approval");
const approvalText = document.getElementById("approvalText");
const approvalCode = document.getElementById("approvalCode");
const approvalBtn = document.getElementById("approvalBtn");
const approvalCancelBtn = document.getElementById("approvalCancelBtn");
const botNameEl = document.getElementById("botName");
const shutdownBtn = document.getElementById("shutdownBtn");
const shutdownNote = document.getElementById("shutdownNote");

let isOnline = true;
let botDisplayName = "Ellie";

function setOnlineState(nextOnline) {
  isOnline = !!nextOnline;
  if (input) input.disabled = !isOnline;
  const sendBtn = form ? form.querySelector('button[type="submit"]') : null;
  if (sendBtn) sendBtn.disabled = !isOnline;

  const chatRoot = document.querySelector("main.chat");
  if (chatRoot) chatRoot.classList.toggle("offline", !isOnline);

  if (shutdownNote) {
    if (!isOnline) {
      shutdownNote.textContent = "You may now close this window.";
      shutdownNote.classList.add("visible");
    } else {
      shutdownNote.textContent = "";
      shutdownNote.classList.remove("visible");
    }
  }
}

async function fetchStatusWithTimeout(timeoutMs = 1200) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch("/api/status", { signal: ctrl.signal });
    const j = await r.json();
    if (!r.ok) throw new Error(j && (j.error || j.message) ? (j.error || j.message) : r.statusText);
    return j;
  } finally {
    clearTimeout(t);
  }
}

async function loadStatus() {
  try {
    const j = await fetchStatusWithTimeout();
    setOnlineState(true);
    if (j.botName) {
      botDisplayName = j.botName;
      if (botNameEl) botNameEl.textContent = j.botName;
      document.title = `${j.botName} · P2 Claw`;
    }
  } catch {
    // If the server is down (or restarting), reflect that in the UI.
    setOnlineState(false);
  }
}

void loadStatus();
setInterval(() => {
  void loadStatus();
}, 1500);

/** Enter sends; Shift+Enter inserts a newline (textarea). */
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (input.value.trim()) {
      form.requestSubmit();
    }
  }
});

if (shutdownBtn) {
  shutdownBtn.addEventListener("click", async () => {
    if (
      !confirm(
        "Shut down P2 Claw on this machine? You will need to start it again from the terminal."
      )
    ) {
      return;
    }
    try {
      await fetch("/api/shutdown", { method: "POST" });
      setOnlineState(false);
    } catch {
      /* process may exit before response completes */
      setOnlineState(false);
    }
  });
}

function append(role, text) {
  const line = document.createElement("div");
  line.className = "line " + role;
  line.textContent = (role === "user" ? "You: " : botDisplayName + ": ") + text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

/**
 * Renders a structured DebugResult from /api/debug into a plain-text block.
 * The server returns a typed union; we switch on `kind` and format each
 * shape for display. Minimal by design — the HTML GUI is not a full IDE.
 */
function renderDebug(result) {
  if (!result || typeof result !== "object") return String(result);
  switch (result.kind) {
    case "disabled":
      return "Unknown command: /debug";
    case "help":
      return (result.lines || []).join("\n");
    case "list": {
      const lines = (result.tools || []).map(
        (t) =>
          `  ${t.name}  [${t.effectiveRisk}]  owner=${t.ownerModuleId || "core"}  perms=${(t.requiredPermissions || []).join(", ") || "(none)"}`
      );
      return `Tools (${result.tools.length}):\n` + lines.join("\n");
    }
    case "modules": {
      const lines = (result.modules || []).map(
        (m) =>
          `  ${m.id}  v${m.version}  perms=[${(m.permissions || []).join(", ") || "none"}]  tools=${m.tools.length}`
      );
      return `Modules (${result.modules.length}):\n` + lines.join("\n");
    }
    case "inspect_module":
      return result.module
        ? JSON.stringify(result.module, null, 2)
        : `No loaded module with id "${result.moduleId}".`;
    case "audit": {
      const header = result.note
        ? `Audit: ${result.path}\n(${result.note})`
        : `Audit: ${result.path}\nLast ${result.entries.length} of ${result.n} requested:`;
      return [header, ...(result.entries || [])].join("\n");
    }
    case "call": {
      const m = result.meta || {};
      return (
        `call  ${m.target}  risk=${m.effectiveRisk}  owner=${m.targetOwnerModuleId || "core"}  outcome=${m.outcome}\n` +
        `raw:\n${m.raw}`
      );
    }
    case "perms": {
      const i = result.info || {};
      const pending = i.pendingChallenge
        ? `pending: tool=${i.pendingChallenge.toolName} expires=${new Date(i.pendingChallenge.expiresAt).toISOString()}`
        : "pending: (none — approvals are ephemeral one-shot challenges)";
      return [
        `tool: ${i.tool}`,
        `owner: ${i.ownerModuleId || "core"}`,
        `required: ${(i.requiredPermissions || []).join(", ") || "(none)"}`,
        `effectiveRisk: ${i.effectiveRisk}`,
        `totpConfigured: ${i.totpConfigured}`,
        pending,
      ].join("\n");
    }
    case "unknown_subcommand":
      return `Unknown /debug subcommand: "${result.subcommand}". Try /debug help.`;
    case "error":
      return `Error: ${result.message}`;
    default:
      return JSON.stringify(result, null, 2);
  }
}

/** Splits a /debug message into subcommand + verbatim rest. */
function parseDebugInput(message) {
  const body = message.replace(/^\/debug\b/, "").trimStart();
  if (!body) return { subcommand: "", rest: "" };
  const m = body.match(/^(\S+)(\s+([\s\S]*))?$/);
  if (!m) return { subcommand: body, rest: "" };
  return { subcommand: m[1] || "", rest: (m[3] || "").trim() };
}

approvalBtn.addEventListener("click", async () => {
  const code = approvalCode.value.replace(/\s+/g, "");
  approvalCode.value = "";
  try {
    await fetch("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
  } catch {
    /* ignore */
  }
});

approvalCancelBtn.addEventListener("click", async () => {
  approvalCode.value = "";
  try {
    await fetch("/api/cancel", { method: "POST" });
  } catch {
    /* ignore */
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!isOnline) return;
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  append("user", message);

  if (/^\/cancel\s*$/i.test(message)) {
    try {
      const r = await fetch("/api/cancel", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      append("assistant", j.message || "Cancelled.");
    } catch {
      append("assistant", "Cancel request failed.");
    }
    return;
  }

  const isDebug = /^\/debug(\s|$)/.test(message);

  let poll = null;
  try {
    poll = setInterval(async () => {
      try {
        const r = await fetch("/api/pending");
        const j = await r.json();
        if (j.prompt) {
          approvalText.textContent = j.prompt;
          approval.classList.remove("hidden");
        }
      } catch {
        /* ignore */
      }
    }, 400);

    if (isDebug) {
      const { subcommand, rest } = parseDebugInput(message);
      const res = await fetch("/api/debug", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subcommand, rest }),
      });
      if (res.status === 404) {
        append("assistant", "Unknown command: /debug");
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        append("assistant", data.error || data.message || "Request failed");
        return;
      }
      append("assistant", renderDebug(data.result));
      return;
    }

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      append("assistant", data.message || data.error || "Request failed");
      if (res.status === 0 || res.status === 502 || res.status === 503) {
        setOnlineState(false);
      }
      return;
    }
    append("assistant", data.reply || "");
  } finally {
    if (poll) clearInterval(poll);
    approval.classList.add("hidden");
    approvalText.textContent = "";
  }
});
