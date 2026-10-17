// "Report a bug" flow, shared by the app (/host, /watch/<id>) and the landing
// page (/). It gathers a little context plus the diagnostics when app.js is
// present, puts everything on the clipboard and explains how to reach the
// maintainer. Discord cannot be linked by username, so the report is copied and
// the handle is offered for a DM instead. Any element with data-report-bug
// opens the flow.
(function () {
  "use strict";

  const GITHUB_REPO = "https://github.com/dener-p/golive";
  const GITHUB_ISSUES = `${GITHUB_REPO}/issues/new`;
  const DISCORD_HANDLE = "zen.kye";

  const t = (key, vars) => (typeof window.t === "function" ? window.t(key, vars) : key);

  // The deployed version is injected into <meta name="golive-version"> by the
  // Worker from the APP_VERSION var in wrangler.jsonc.
  function appVersion() {
    const meta = document.querySelector('meta[name="golive-version"]');
    const v = meta && meta.getAttribute("content");
    return v && v !== "__APP_VERSION__" ? v.trim() : "";
  }

  function buildReport() {
    const lines = ["Golive bug report"];
    const version = appVersion();
    if (version) lines.push(`version: ${version}`);
    lines.push(`page: ${location.href}`);
    lines.push(`lang: ${document.documentElement.lang || "-"}`);
    let diag = "";
    if (typeof window.goliveDiagnostics === "function") {
      try { diag = window.goliveDiagnostics() || ""; } catch { diag = ""; }
    }
    // diagnosticsText already carries time/role/room/ua and the log.
    if (diag) {
      lines.push("", diag);
    } else {
      lines.push(`time: ${new Date().toISOString()}`);
      lines.push(`ua: ${navigator.userAgent}`);
    }
    return lines.join("\n");
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  let backdrop = null;
  let reportEl = null;
  let lastFocus = null;

  function ghostButton(label, act) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-ghost";
    b.textContent = label;
    b.dataset.act = act;
    return b;
  }

  function buildModal() {
    if (backdrop) return backdrop;

    backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.hidden = true;

    const box = document.createElement("div");
    box.className = "modal report-modal";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "reportTitle");

    const title = document.createElement("h2");
    title.id = "reportTitle";
    title.textContent = t("report.title");

    const hint = document.createElement("p");
    hint.className = "qr-hint";
    hint.textContent = t("report.hint", { handle: `@${DISCORD_HANDLE}` });

    reportEl = document.createElement("textarea");
    reportEl.className = "report-text";
    reportEl.readOnly = true;
    reportEl.spellcheck = false;
    reportEl.setAttribute("aria-label", t("report.title"));

    const row1 = document.createElement("div");
    row1.className = "qr-actions report-row";
    row1.append(
      ghostButton(t("report.copyReport"), "copy-report"),
      ghostButton(t("report.copyHandle", { handle: `@${DISCORD_HANDLE}` }), "copy-handle"),
    );

    const issues = document.createElement("a");
    issues.className = "btn-ghost report-link";
    issues.href = GITHUB_ISSUES;
    issues.target = "_blank";
    issues.rel = "noopener noreferrer";
    issues.textContent = t("report.openIssues");

    const row2 = document.createElement("div");
    row2.className = "qr-actions report-row";
    row2.append(issues, ghostButton(t("report.close"), "close"));

    box.append(title, hint, reportEl, row1, row2);
    backdrop.append(box);

    box.addEventListener("click", async (e) => {
      const el = e.target.closest("[data-act]");
      if (!el) return;
      const act = el.dataset.act;
      if (act === "close") {
        close();
        return;
      }
      const text = act === "copy-report" ? reportEl.value : `@${DISCORD_HANDLE}`;
      const ok = await copyText(text);
      if (!ok) {
        reportEl.focus();
        reportEl.select();
        return;
      }
      const previous = el.textContent;
      el.textContent = t("app.copied");
      el.classList.add("copied");
      setTimeout(() => {
        el.textContent = previous;
        el.classList.remove("copied");
      }, 1600);
    });

    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !backdrop.hidden) close(); });
    return backdrop;
  }

  function open(text) {
    const el = buildModal();
    reportEl.value = text;
    reportEl.scrollTop = 0;
    lastFocus = document.activeElement;
    el.hidden = false;
    reportEl.focus();
  }

  function close() {
    if (!backdrop) return;
    backdrop.hidden = true;
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  function wire() {
    document.querySelectorAll("[data-report-bug]").forEach((el) => {
      el.addEventListener("click", async (e) => {
        e.preventDefault();
        const text = buildReport();
        const ok = await copyText(text);
        open(text);
        if (!ok) {
          reportEl.select();
        }
      });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
