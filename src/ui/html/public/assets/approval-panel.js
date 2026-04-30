/**
 * P2 Claw — Approval Panel (sidebar).
 *
 * Handles real-time polling of:
 *   - /api/pending      → Active Requests (approval options, scope warnings)
 *   - /api/capabilities → Active Capabilities (with revoke)
 *   - /api/approval-history → Audit Feed
 *
 * Part of Phase 4: Frontend Approval UX.
 */

(function () {
  "use strict";

  const approvalPanel = document.getElementById("approvalPanel");
  const capabilitiesList = document.getElementById("capabilitiesList");
  const auditList = document.getElementById("auditList");
  const revokeAllBtn = document.getElementById("revokeAllBtn");
  const toggleAuditBtn = document.getElementById("toggleAuditBtn");

  let lastPendingChallengeId = null;
  let selectedOptionIndex = null;

  // ── Helpers ──────────────────────────────────────────────────

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function riskBadge(level) {
    return '<span class="risk-badge ' + esc(level) + '">' + esc(level) + "</span>";
  }

  function timeAgo(iso) {
    var d = new Date(iso);
    var now = Date.now();
    var diff = now - d.getTime();
    if (diff < 60000) return "just now";
    if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
    if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
    return d.toLocaleDateString();
  }

  function expiryLabel(expiresAt) {
    if (!expiresAt) return "session";
    var d = new Date(expiresAt);
    var remaining = d.getTime() - Date.now();
    if (remaining <= 0) return "expired";
    if (remaining <= 2 * 60 * 60 * 1000) {
      var mins = Math.max(1, Math.ceil(remaining / 60000));
      return mins + "m left";
    }
    if (remaining <= 24 * 60 * 60 * 1000) {
      return Math.ceil(remaining / 3600000) + "h left";
    }
    return d.toLocaleDateString();
  }

  function isExpiringSoon(expiresAt) {
    if (!expiresAt) return false;
    var remaining = new Date(expiresAt).getTime() - Date.now();
    return remaining > 0 && remaining <= 2 * 60 * 60 * 1000;
  }

  // ── Active Requests ──────────────────────────────────────────

  function renderApprovalPanel(data) {
    if (!data.challenge) {
      if (lastPendingChallengeId !== null) {
        lastPendingChallengeId = null;
        selectedOptionIndex = null;
      }
      approvalPanel.innerHTML = '<p class="empty-msg">No pending requests.</p>';
      approvalPanel.classList.add("empty-state");
      return;
    }

    approvalPanel.classList.remove("empty-state");
    var ch = data.challenge;

    // Only re-render when challenge changes
    if (ch.challengeId === lastPendingChallengeId) return;
    lastPendingChallengeId = ch.challengeId;
    selectedOptionIndex = null;

    var html = '<div class="approval-card">';
    html +=
      '<div class="tool-name">' + esc(ch.toolName) + " " + riskBadge(ch.risk) + "</div>";

    if (data.prompt) {
      // Show bound payload from prompt text (first two lines)
      var lines = data.prompt.split("\n");
      var payloadLine = lines.find(function (l) {
        return l.startsWith("Bound payload:");
      });
      if (payloadLine) {
        html += '<div class="scope-preview">' + esc(payloadLine) + "</div>";
      }
    }

    if (ch.scopeWarning) {
      html += '<span class="scope-warning">⚠ ' + esc(ch.scopeWarning) + "</span>";
    }

    // Approval option buttons
    html += '<ul class="approval-option-list">';
    ch.approvalOptions.forEach(function (opt, idx) {
      var totpHint = opt.requiresTotp
        ? '<span class="totp-hint">🔑 TOTP</span>'
        : "";
      html +=
        '<li><button type="button" class="btn-approve-option" data-idx="' +
        idx +
        '" data-challenge="' +
        esc(ch.challengeId) +
        '" data-totp="' +
        (opt.requiresTotp ? "1" : "0") +
        '">' +
        esc("[" + (idx + 1) + "] " + opt.label) +
        " " +
        totpHint +
        "</button></li>";
    });
    // Reject option
    html +=
      '<li><button type="button" class="btn-cancel" id="rejectApproval">Reject</button></li>';
    html += "</ul>";

    // TOTP input (hidden until an option requiring it is selected)
    html += '<div class="totp-inline" id="totpInline" style="display:none">';
    html +=
      '<input type="text" id="totpInput" maxlength="10" autocomplete="one-time-code" placeholder="6-digit code" />';
    html += '<button type="button" id="totpSubmit">Submit</button>';
    html += "</div>";
    html += '<span class="approval-feedback" id="approvalFeedback"></span>';
    html += "</div>";

    approvalPanel.innerHTML = html;

    // Wire up option buttons
    approvalPanel.querySelectorAll(".btn-approve-option").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var idx = parseInt(btn.getAttribute("data-idx"), 10);
        var needsTotp = btn.getAttribute("data-totp") === "1";
        selectedOptionIndex = idx;

        // Highlight selected
        approvalPanel.querySelectorAll(".btn-approve-option").forEach(function (b) {
          b.style.borderColor = "";
          b.style.background = "";
        });
        btn.style.borderColor = "#6ec8ff";
        btn.style.background = "rgba(110, 200, 255, 0.1)";

        if (needsTotp) {
          var totpInline = document.getElementById("totpInline");
          if (totpInline) {
            totpInline.style.display = "flex";
            var totpInput = document.getElementById("totpInput");
            if (totpInput) totpInput.focus();
          }
        } else {
          // No TOTP required — submit immediately
          submitApproval(ch.challengeId, idx, "");
        }
      });
    });

    // Wire TOTP submit
    var totpSubmit = document.getElementById("totpSubmit");
    if (totpSubmit) {
      totpSubmit.addEventListener("click", function () {
        var totpInput = document.getElementById("totpInput");
        var code = totpInput ? totpInput.value.replace(/\s+/g, "") : "";
        if (selectedOptionIndex !== null) {
          submitApproval(ch.challengeId, selectedOptionIndex, code);
        }
      });
    }

    // Enter key in TOTP input
    var totpInput = document.getElementById("totpInput");
    if (totpInput) {
      totpInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          var code = totpInput.value.replace(/\s+/g, "");
          if (selectedOptionIndex !== null) {
            submitApproval(ch.challengeId, selectedOptionIndex, code);
          }
        }
      });
    }

    // Wire reject button
    var rejectBtn = document.getElementById("rejectApproval");
    if (rejectBtn) {
      rejectBtn.addEventListener("click", function () {
        fetch("/api/cancel", { method: "POST" }).catch(function () {});
      });
    }
  }

  function submitApproval(challengeId, optionIndex, code) {
    var feedbackEl = document.getElementById("approvalFeedback");
    fetch("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: challengeId,
        optionIndex: optionIndex,
        code: code || undefined,
      }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (j.ok) {
          lastPendingChallengeId = null;
          selectedOptionIndex = null;
          approvalPanel.innerHTML = '<p class="empty-msg">No pending requests.</p>';
          // Refresh capabilities immediately
          refreshCapabilities();
        } else if (feedbackEl) {
          feedbackEl.textContent = j.message || "Approval failed.";
        }
      })
      .catch(function () {
        if (feedbackEl) feedbackEl.textContent = "Request failed.";
      });
  }

  // ── Active Capabilities ──────────────────────────────────────

  function renderCapabilities(caps) {
    if (!caps || caps.length === 0) {
      capabilitiesList.innerHTML = '<p class="empty-msg">No active capabilities.</p>';
      return;
    }

    // Group by tool category
    var groups = {};
    caps.forEach(function (c) {
      var category = c.permission.split(".")[0] || "other";
      if (!groups[category]) groups[category] = [];
      groups[category].push(c);
    });

    var html = "";
    Object.keys(groups)
      .sort()
      .forEach(function (category) {
        groups[category].forEach(function (c) {
          var expiry = expiryLabel(c.expiresAt);
          var expiringSoon = isExpiringSoon(c.expiresAt);
          var expiryHtml = expiringSoon
            ? '<span class="expiring-soon">⏳ ' + esc(expiry) + "</span>"
            : "<span>" + esc(expiry) + "</span>";
          var scopeText = c.scopePath || c.scopeType;

          html += '<div class="capability-card">';
          html += '<div class="cap-header">';
          html +=
            '<span class="cap-tool">' +
            esc(c.tool) +
            " " +
            riskBadge(c.riskLevel) +
            "</span>";
          html +=
            '<button type="button" class="btn-revoke" data-id="' +
            esc(c.id) +
            '">Revoke</button>';
          html += "</div>";
          html += '<div class="cap-scope">' + esc(c.permission) + " · " + esc(scopeText) + "</div>";
          html += '<div class="cap-expiry">' + expiryHtml + " · " + esc(c.grantedVia) + "</div>";
          html += "</div>";
        });
      });

    capabilitiesList.innerHTML = html;

    // Wire revoke buttons
    capabilitiesList.querySelectorAll(".btn-revoke").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-id");
        fetch("/api/capabilities/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: id }),
        })
          .then(function () {
            refreshCapabilities();
          })
          .catch(function () {});
      });
    });
  }

  function refreshCapabilities() {
    fetch("/api/capabilities")
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        renderCapabilities(data.capabilities || []);
      })
      .catch(function () {});
  }

  // Revoke All button
  if (revokeAllBtn) {
    revokeAllBtn.addEventListener("click", function () {
      if (!confirm("Revoke all capabilities? This cannot be undone.")) return;
      fetch("/api/capabilities/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      })
        .then(function () {
          refreshCapabilities();
        })
        .catch(function () {});
    });
  }

  // ── Audit Feed ───────────────────────────────────────────────

  function renderAuditFeed(entries) {
    if (!entries || entries.length === 0) {
      auditList.innerHTML = '<p class="empty-msg">No recent events.</p>';
      return;
    }

    var html = "";
    // Reverse to show most recent first
    entries
      .slice()
      .reverse()
      .forEach(function (entry) {
        var kind = entry.kind || "unknown";
        var detail = "";
        if (kind === "approval_event") {
          detail = (entry.toolName || "") + " → " + (entry.outcome || "");
        } else if (kind === "capability_event") {
          detail = (entry.tool || "") + " " + (entry.operation || "");
          if (entry.scopePath) detail += " (" + entry.scopePath + ")";
        }
        var ts = entry.ts ? timeAgo(entry.ts) : "";

        html += '<div class="audit-entry">';
        html += '<span class="audit-kind">' + esc(kind.replace("_event", "")) + "</span>";
        html += "<span>" + esc(detail) + "</span>";
        html += '<span class="audit-ts">' + esc(ts) + "</span>";
        html += "</div>";
      });

    auditList.innerHTML = html;
  }

  function refreshAuditFeed() {
    fetch("/api/approval-history")
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        renderAuditFeed(data.entries || []);
      })
      .catch(function () {});
  }

  // Toggle audit feed visibility
  if (toggleAuditBtn) {
    toggleAuditBtn.addEventListener("click", function () {
      var isCollapsed = auditList.classList.contains("collapsed");
      if (isCollapsed) {
        auditList.classList.remove("collapsed");
        auditList.classList.add("expanded");
        toggleAuditBtn.classList.add("rotated");
        refreshAuditFeed();
      } else {
        auditList.classList.add("collapsed");
        auditList.classList.remove("expanded");
        toggleAuditBtn.classList.remove("rotated");
      }
    });
  }

  // ── Polling ──────────────────────────────────────────────────

  function pollAll() {
    // Poll pending approval
    fetch("/api/pending")
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        renderApprovalPanel(data);
      })
      .catch(function () {});

    // Poll capabilities
    refreshCapabilities();

    // Poll audit feed only if expanded
    if (auditList && !auditList.classList.contains("collapsed")) {
      refreshAuditFeed();
    }
  }

  // Initial load
  pollAll();

  // Poll every 1.5 seconds
  setInterval(pollAll, 1500);
})();
