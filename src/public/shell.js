// Golive shell: one page, many rooms. Each room is a native panel built from
// the <template> in index.html and driven by its own createRoom() instance, so
// hosting and watching several rooms at once works without iframes. Panels live
// in a free-form grid of columns; drag the splitters between them to resize.
import { createRoom } from "./room.js";

const $ = (id) => document.getElementById(id);
const t = (key, vars) => window.t(key, vars);

const grid = $("grid");
const panelTpl = $("roomPanelTpl");
const MAX_PER_COL = 2;
const LAYOUT_KEY = "golive.layout";
const THEATER_KEY = "golive.theater";

let seq = 0;
const panels = new Map();   // key -> { key, el, els, room, role, h, unit, col, state }
const columns = [];         // { el, weight, keys: [] }
let activeKey = null;
let audioKey = null;

// ---------- Layout ----------

function newColumn(weight) {
  const el = document.createElement("div");
  el.className = "col";
  el.style.flexGrow = weight;
  const rec = { el, weight, keys: [] };
  columns.push(rec);
  grid.appendChild(el);
  syncSplits();
  return rec;
}

function makeSplitV(a, b) {
  const s = document.createElement("div");
  s.className = "split split-v";
  s.setAttribute("role", "separator");
  s.setAttribute("aria-orientation", "vertical");
  s.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    s.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const total = columns.reduce((sum, c) => sum + c.weight, 0);
    const pxPer = grid.clientWidth / total || 1;
    const wa = a.weight, wb = b.weight;
    const minW = 140 / pxPer;
    const move = (ev) => {
      let na = wa + (ev.clientX - startX) / pxPer;
      let nb = wb - (ev.clientX - startX) / pxPer;
      if (na < minW) { nb -= minW - na; na = minW; }
      if (nb < minW) { na -= minW - nb; nb = minW; }
      a.weight = na; b.weight = nb;
      applyCols();
    };
    const up = () => {
      s.removeEventListener("pointermove", move);
      s.removeEventListener("pointerup", up);
      saveLayout();
    };
    s.addEventListener("pointermove", move);
    s.addEventListener("pointerup", up);
  });
  return s;
}

function makeSplitH(col, keyA, keyB) {
  const s = document.createElement("div");
  s.className = "split split-h";
  s.setAttribute("role", "separator");
  s.setAttribute("aria-orientation", "horizontal");
  s.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    s.setPointerCapture(e.pointerId);
    setActive(keyA);
    const a = panels.get(keyA), b = panels.get(keyB);
    if (!a || !b) return;
    const startY = e.clientY;
    const total = col.keys.reduce((sum, k) => sum + (panels.get(k)?.h || 1), 0);
    const pxPer = col.el.clientHeight / total || 1;
    const ha = a.h, hb = b.h;
    const minH = 96 / pxPer;
    const move = (ev) => {
      let na = ha + (ev.clientY - startY) / pxPer;
      let nb = hb - (ev.clientY - startY) / pxPer;
      if (na < minH) { nb -= minH - na; na = minH; }
      if (nb < minH) { na -= minH - nb; nb = minH; }
      a.h = na; b.h = nb;
      applyRows(col);
    };
    const up = () => {
      s.removeEventListener("pointermove", move);
      s.removeEventListener("pointerup", up);
      saveLayout();
    };
    s.addEventListener("pointermove", move);
    s.addEventListener("pointerup", up);
  });
  return s;
}

function syncSplits() {
  [...grid.querySelectorAll(".split-v")].forEach((s) => s.remove());
  for (let i = 1; i < columns.length; i++) {
    grid.insertBefore(makeSplitV(columns[i - 1], columns[i]), columns[i].el);
  }
}

function syncColSplits(col) {
  [...col.el.querySelectorAll(".split-h")].forEach((s) => s.remove());
  for (let i = 1; i < col.keys.length; i++) {
    col.el.insertBefore(makeSplitH(col, col.keys[i - 1], col.keys[i]), panels.get(col.keys[i]).el);
  }
}

function applyCols() {
  columns.forEach((c) => { c.el.style.flexGrow = c.weight; });
}

function applyRows(col) {
  col.keys.forEach((k) => {
    const r = panels.get(k);
    if (r) r.el.style.flexGrow = r.h;
  });
}

function saveLayout() {
  const data = {
    columns: columns.map((c) => ({
      weight: c.weight,
      // A streamer panel is not persisted: presenting needs a user gesture, so a
      // reload should not (and cannot) bring it back.
      panels: c.keys
        .map((k) => panels.get(k))
        .filter((r) => r && r.role === "viewer" && r.room)
        .map((r) => ({ room: r.room, h: r.h })),
    })).filter((c) => c.panels.length),
  };
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(data)); } catch { /* storage unavailable */ }
}

function restoreLayout() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null"); } catch { data = null; }
  if (!data || !Array.isArray(data.columns) || !data.columns.length) return false;
  for (const c of data.columns) {
    if (!c.panels) continue;
    const col = newColumn(c.weight || 1);
    for (const p of c.panels) {
      if (!p.room) continue;
      appendToCol(col, { room: p.room, role: "viewer", persist: false }, p.h || 1);
    }
  }
  return columns.length > 0;
}

// ---------- Panels ----------

function collectEls(root) {
  const els = { panel: root };
  root.querySelectorAll("[data-el]").forEach((n) => { els[n.dataset.el] = n; });
  return els;
}

function appendToCol(col, { room, role, pin, persist = true }, h = 1) {
  const key = "p" + (++seq);
  const el = panelTpl.content.firstElementChild.cloneNode(true);
  el.dataset.key = key;
  const els = collectEls(el);

  const rec = { key, el, els, room: room || null, role, h, unit: null, col, state: "" };
  rec.unit = createRoom(els, {
    role,
    room: room || null,
    pin,
    onLog: (msg, level) => appendLog(rec.room, msg, level),
    onDiag: (id, text, cls) => { if (activeKey === key) renderDiagField(id, text, cls); },
    onState: (s) => { rec.state = s; setBadge(rec); },
    onRoom: (r) => { rec.room = r; rec.els.roomName.textContent = "#" + r; },
    getLogText: () => $("log").textContent,
  });

  rec.els.roomName.textContent = room ? "#" + room : t("role.host");
  els.audioBtn.addEventListener("click", (e) => { e.stopPropagation(); focusAudio(key); });
  els.fullBtn.addEventListener("click", (e) => { e.stopPropagation(); setActive(key); rec.unit.toggleFullscreen(); });
  els.openBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const r = rec.room || rec.unit.room();
    if (r) window.open(`/watch/${r}`, "_blank", "noopener");
  });
  els.removeBtn.addEventListener("click", (e) => { e.stopPropagation(); removePanel(key); });
  if (els.qrBtn) els.qrBtn.addEventListener("click", () => openQr(rec.unit.roomUrl()));
  el.addEventListener("pointerdown", () => setActive(key));

  if (window.i18n) window.i18n.apply(el);

  panels.set(key, rec);
  col.keys.push(key);
  col.el.appendChild(el);
  syncColSplits(col);
  applyRows(col);

  if (persist) saveLayout();
  setActive(key);
  updateEmpty();
  return key;
}

function addPanel(opts) {
  let col = columns[columns.length - 1];
  if (!col || col.keys.length >= MAX_PER_COL) col = newColumn(1);
  return appendToCol(col, opts);
}

function removePanel(key) {
  const rec = panels.get(key);
  if (!rec) return;
  rec.unit.destroy();
  const col = rec.col;
  const idx = col.keys.indexOf(key);
  col.keys.splice(idx, 1);
  rec.el.remove();
  panels.delete(key);
  if (col.keys.length === 0) {
    const ci = columns.indexOf(col);
    col.el.remove();
    columns.splice(ci, 1);
    syncSplits();
  } else {
    syncColSplits(col);
    applyRows(col);
  }
  if (activeKey === key) {
    const next = panels.keys().next().value || null;
    setActive(next);
  }
  if (audioKey === key) { audioKey = null; updateAudioButtons(); }
  saveLayout();
  updateEmpty();
}

function updateEmpty() {
  const empty = $("empty");
  if (empty) empty.hidden = panels.size > 0;
}

function setBadge(rec) {
  const badge = rec.els.badge;
  if (!badge) return;
  const labels = { live: "shell.live", waiting: "shell.waiting", idle: "shell.idle" };
  const key = labels[rec.state];
  badge.textContent = key ? t(key) : "";
  badge.hidden = !key;
  badge.className = "room-badge " + (rec.state || "");
  rec.el.classList.toggle("is-live", rec.state === "live");
}

function setActive(key) {
  activeKey = key;
  for (const [k, rec] of panels) rec.el.classList.toggle("active", k === key);
  const rec = panels.get(key);
  const target = $("diagTarget");
  if (target) target.textContent = rec ? (rec.room ? "#" + rec.room : t("role.host")) : "";
  const isStreamer = !!rec && rec.role === "streamer";
  document.querySelectorAll("#diagList [data-streamer-only]").forEach((n) => { n.hidden = !isStreamer; });
  renderDiag();
}

// ---------- Audio focus ----------

function focusAudio(key) {
  audioKey = key;
  for (const [, rec] of panels) {
    const v = rec.els.video;
    if (!v) continue;
    if (rec.key === key) {
      v.muted = false;
      if (v.volume === 0) v.volume = 1;
      const p = v.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } else {
      v.muted = true;
    }
    if (rec.els.audioHint) rec.els.audioHint.hidden = true;
  }
  updateAudioButtons();
}

function updateAudioButtons() {
  for (const [k, rec] of panels) {
    if (rec.els.audioBtn) rec.els.audioBtn.classList.toggle("on", k === audioKey);
  }
}

// ---------- Diagnostics & log ----------

function activeUnit() {
  const rec = panels.get(activeKey);
  return rec ? rec.unit : null;
}

function renderDiag() {
  const rec = panels.get(activeKey);
  const diag = rec ? rec.unit.diag() : {};
  document.querySelectorAll("#diagList [data-diag]").forEach((dd) => {
    const v = diag[dd.dataset.diag];
    dd.textContent = v ? v.text : "\u2013";
    dd.className = v ? (v.cls || "") : "";
  });
}

function renderDiagField(id, text, cls) {
  const dd = document.querySelector(`#diagList [data-diag="${id}"]`);
  if (!dd) return;
  dd.textContent = text;
  dd.className = cls || "";
}

function appendLog(room, msg, level) {
  const el = $("log");
  if (!el) return;
  const line = document.createElement("div");
  if (level) line.className = level;
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${room ? "[" + room + "] " : ""}${msg}`;
  el.appendChild(line);
  while (el.childElementCount > 600) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

function diagnosticsText() {
  const unit = activeUnit();
  return unit ? unit.diagnosticsText() : "";
}
window.goliveDiagnostics = diagnosticsText;

// ---------- Theater & shortcuts ----------

function theaterOn() {
  return document.body.classList.contains("theater");
}

function setTheater(on) {
  document.body.classList.toggle("theater", on);
  const btn = $("theaterBtn");
  if (btn) {
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    const label = t(on ? "app.exitTheater" : "app.theater");
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }
  try { localStorage.setItem(THEATER_KEY, on ? "1" : "0"); } catch { /* storage unavailable */ }
}

function wireShortcuts() {
  $("theaterBtn").addEventListener("click", () => setTheater(!theaterOn()));
  let remembered = false;
  try { remembered = localStorage.getItem(THEATER_KEY) === "1"; } catch { /* storage unavailable */ }
  setTheater(remembered);

  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const el = document.activeElement;
    const tag = el && el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el && el.isContentEditable)) return;
    if (document.querySelector(".modal-backdrop:not([hidden])")) return;
    const rec = panels.get(activeKey);
    switch (e.key.toLowerCase()) {
      case "t": e.preventDefault(); setTheater(!theaterOn()); break;
      case "f": if (rec) { e.preventDefault(); rec.unit.toggleFullscreen(); } break;
      case "p": if (rec && rec.role === "viewer") { e.preventDefault(); rec.unit.togglePip(); } break;
      case "m": if (rec) { e.preventDefault(); rec.unit.toggleVideoMute(); } break;
      case "escape": if (theaterOn() && !document.fullscreenElement) setTheater(false); break;
    }
  });
}

// ---------- QR ----------

function openQr(url) {
  const modal = $("qrModal");
  const box = $("qrBox");
  try {
    box.innerHTML = (typeof QR !== "undefined") ? QR.svg(url, { ecc: "M", margin: 2, label: t("qr.title") }) : "";
    if (!box.innerHTML) throw new Error("no QR");
  } catch {
    appendLog(null, t("log.qrFailed"), "warn");
    return;
  }
  modal.hidden = false;
  $("qrCloseBtn").focus();
}

function closeQr() {
  $("qrModal").hidden = true;
  $("qrBox").innerHTML = "";
}

function wireQr() {
  const modal = $("qrModal");
  if (!modal) return;
  $("qrCloseBtn").addEventListener("click", closeQr);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeQr(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) closeQr(); });
  $("qrCopyBtn").addEventListener("click", async () => {
    const rec = panels.get(activeKey);
    const url = rec ? rec.unit.roomUrl() : location.origin;
    try { await navigator.clipboard.writeText(url); appendLog(null, t("log.linkCopied")); } catch { /* clipboard unavailable */ }
  });
}

// ---------- Toolbar ----------

function parseRoom(value) {
  const v = (value || "").trim();
  if (!v) return null;
  const link = v.match(/\/watch\/([a-zA-Z0-9][a-zA-Z0-9_-]{2,23})/);
  const id = link ? link[1] : v;
  const clean = id.toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{2,23}$/.test(clean) ? clean : null;
}

function wireToolbar() {
  const bar = $("addBar");
  const input = $("addRoomInput");

  $("addRoomBtn").addEventListener("click", () => {
    bar.hidden = !bar.hidden;
    if (!bar.hidden) input.focus();
  });
  $("addRoomCancel").addEventListener("click", () => { bar.hidden = true; });

  const submit = () => {
    const room = parseRoom(input.value);
    if (!room) { input.focus(); return; }
    input.value = "";
    bar.hidden = true;
    addPanel({ room, role: "viewer" });
  };
  $("addRoomConfirm").addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });

  $("hostBtn").addEventListener("click", () => {
    for (const [k, rec] of panels) {
      if (rec.role === "streamer") { setActive(k); rec.el.scrollIntoView({ block: "nearest" }); return; }
    }
    const key = addPanel({ room: null, role: "streamer" });
    panels.get(key)?.el.scrollIntoView({ block: "nearest" });
  });

  $("copyDiagBtn").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(diagnosticsText()); appendLog(null, t("log.diagCopied")); }
    catch { appendLog(null, t("log.clipboardUnavailable"), "warn"); }
  });
  const clearBtn = $("clearLogBtn");
  if (clearBtn) clearBtn.addEventListener("click", () => { $("log").innerHTML = ""; });
  const logToggle = $("logToggle");
  if (logToggle) {
    logToggle.hidden = false;
    logToggle.addEventListener("click", () => {
      const logEl = $("log");
      logEl.hidden = !logEl.hidden;
      logToggle.setAttribute("aria-expanded", String(!logEl.hidden));
      const label = logToggle.querySelector("span");
      if (label) label.textContent = t(logEl.hidden ? "log.show" : "log.hide");
    });
  }
}

// ---------- Boot ----------

function boot() {
  wireToolbar();
  wireQr();
  wireShortcuts();
  updateEmpty();

  const path = location.pathname.toLowerCase();
  const watch = path.match(/^\/watch\/([a-z0-9][a-z0-9_-]{2,23})$/);
  if (watch) {
    addPanel({ room: watch[1], role: "viewer", persist: false });
  } else if (path === "/host") {
    addPanel({ room: null, role: "streamer", persist: false });
  } else if (!restoreLayout()) {
    updateEmpty();
  }

  document.addEventListener("visibilitychange", () => {
    for (const [, rec] of panels) rec.unit.onVisible();
  });
  window.addEventListener("beforeunload", () => {
    for (const [, rec] of panels) rec.unit.destroy();
  });

  // Keep the audio-button state in sync when the browser autoplays a panel.
  document.addEventListener("play", (e) => {
    for (const [k, rec] of panels) {
      if (rec.els.video === e.target && !e.target.muted) {
        audioKey = k;
        updateAudioButtons();
      }
    }
  }, true);
}

boot();
