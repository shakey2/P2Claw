/**
 * P2 Claw — Shared navigation loader (Part H).
 *
 * Fetches /api/nav and populates the #moduleNav span with module tab links
 * and the #moduleSettingsLinks div (on the config page) with links to
 * module settings pages.
 *
 * Core-owned: no module-supplied JS ever runs in this context.
 */
(function () {
  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  fetch("/api/nav")
    .then(function (r) {
      return r.json();
    })
    .then(function (data) {
      var navEl = document.getElementById("moduleNav");
      var settingsEl = document.getElementById("moduleSettingsLinks");

      // Populate nav-row with module tab links
      if (navEl && data.tabs && data.tabs.length > 0) {
        var html = "";
        for (var i = 0; i < data.tabs.length; i++) {
          var t = data.tabs[i];
          html +=
            '<a href="' +
            esc(t.href) +
            '" class="btn-quiet" role="button">' +
            esc(t.title) +
            "</a> ";
        }
        navEl.innerHTML = html;
      }

      // On config page: show links to module settings
      if (settingsEl && data.modulesWithSettings && data.modulesWithSettings.length > 0) {
        var mods = data.modulesWithSettings;
        var shtml = "<h2>Module Settings</h2><ul>";
        for (var j = 0; j < mods.length; j++) {
          shtml +=
            '<li><a href="/modules/' +
            encodeURIComponent(mods[j].id) +
            '/settings">' +
            esc(mods[j].name) +
            "</a></li>";
        }
        shtml += "</ul>";
        settingsEl.innerHTML = shtml;
      }
    })
    .catch(function () {
      /* nav enhancement is non-fatal */
    });
})();
