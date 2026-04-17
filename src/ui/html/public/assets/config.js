const form = document.getElementById("configForm");
const msg = document.getElementById("msg");

const fields = {
  uiMode: document.getElementById("cfgUiMode"),
  botName: document.getElementById("cfgBotName"),
  allowedIds: document.getElementById("cfgAllowedIds"),
  botToken: document.getElementById("cfgBotToken"),
  voiceMode: document.getElementById("cfgVoiceMode"),
  maxIters: document.getElementById("cfgMaxIters"),
  memoryChatId: document.getElementById("cfgMemoryChatId"),
  useProfiles: document.getElementById("cfgUseProfiles"),
  defaultProfile: document.getElementById("cfgDefaultProfile"),
  logRawModel: document.getElementById("cfgLogRawModel"),
  totpSecret: document.getElementById("cfgTotpSecret"),
  htmlHost: document.getElementById("cfgHtmlHost"),
  htmlPort: document.getElementById("cfgHtmlPort"),
};

function setMessage(text, isError = false) {
  if (!msg) return;
  msg.textContent = text;
  msg.style.color = isError ? "#fecaca" : "#a7f3d0";
}

function setBusy(busy) {
  if (!form) return;
  const controls = form.querySelectorAll("input, select, button");
  for (const control of controls) {
    control.disabled = busy;
  }
}

async function loadConfig() {
  setBusy(true);
  try {
    const r = await fetch("/api/config");
    const j = await r.json();
    if (!r.ok) {
      throw new Error(j?.error || j?.message || "Failed to load config.");
    }

    fields.uiMode.value = String(j.uiMode || "html");
    fields.botName.value = String(j.botName || "");
    fields.allowedIds.value = String(j.telegramAllowedUserIds || "");
    fields.voiceMode.value = String(j.defaultVoiceMode || "");
    fields.maxIters.value = String(j.maxAgentIterations || "");
    fields.memoryChatId.value = String(j.memoryChatId || "");
    fields.useProfiles.value = j.useProfiles ? "true" : "false";
    fields.defaultProfile.value = String(j.defaultProfile || "");
    fields.logRawModel.value = j.logRawModel ? "true" : "false";
    fields.htmlHost.value = String(j.htmlUiHost || "127.0.0.1");
    fields.htmlPort.value = String(j.htmlUiPort || "3847");

    fields.botToken.value = "";
    fields.totpSecret.value = "";
    if (j.hasTelegramBotToken) {
      fields.botToken.placeholder = "(already set - hidden)";
    }
    if (j.hasTotpSecretBase32) {
      fields.totpSecret.placeholder = "(already set - hidden)";
    }
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    setMessage(text, true);
  } finally {
    setBusy(false);
  }
}

async function saveConfig(event) {
  event.preventDefault();
  setBusy(true);
  setMessage("");
  try {
    const payload = {
      UI_MODE: fields.uiMode.value.trim(),
      BOT_NAME: fields.botName.value.trim(),
      TELEGRAM_ALLOWED_USER_IDS: fields.allowedIds.value.trim(),
      TELEGRAM_BOT_TOKEN: fields.botToken.value.trim(),
      DEFAULT_VOICE_MODE: fields.voiceMode.value.trim(),
      MAX_AGENT_ITERATIONS: fields.maxIters.value.trim(),
      P2CLAW_MEMORY_CHAT_ID: fields.memoryChatId.value.trim(),
      USE_PROFILES: fields.useProfiles.value.trim(),
      DEFAULT_PROFILE: fields.defaultProfile.value.trim(),
      P2CLAW_LOG_RAW_MODEL: fields.logRawModel.value.trim(),
      TOTP_SECRET_BASE32: fields.totpSecret.value.trim(),
      HTML_UI_HOST: fields.htmlHost.value.trim(),
      HTML_UI_PORT: fields.htmlPort.value.trim(),
    };

    const r = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok) {
      throw new Error(j?.error || j?.message || "Failed to save config.");
    }

    fields.botToken.value = "";
    fields.totpSecret.value = "";
    fields.botToken.placeholder = "(already set - hidden)";
    fields.totpSecret.placeholder = "(already set - hidden)";
    setMessage("Saved. Restart P2 Claw to apply.");
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    setMessage(text, true);
  } finally {
    setBusy(false);
  }
}

if (form) {
  form.addEventListener("submit", (event) => {
    void saveConfig(event);
  });
}

void loadConfig();
