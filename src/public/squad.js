// Golive Squad: watch several rooms side by side, one tile per room. Each tile
// is the normal viewer page in embed mode (?embed=1) inside its own iframe, so
// this file only owns the grid and the audio routing — signaling and media stay
// in app.js, exactly as they are for a single room. Still one direct P2P
// connection per room; no server is involved beyond the usual signaling.
"use strict";

const ROOM_RE = /^[a-z0-9][a-z0-9_-]{2,23}$/;
const STORE_KEY = "golive.squad";
// Decoding several streams is what costs here (CPU + bandwidth), not the
// server, so this is a soft UI cap, not a protocol limit.
const MAX_ROOMS = 9;

const ICON_VOLUME_ON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
const ICON_VOLUME_OFF = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>';
const ICON_FULLSCREEN = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
const ICON_TAB = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

const grid = document.getElementById("squadGrid");
const form = document.getElementById("squadForm");
const input = document.getElementById("squadInput");
const errorEl = document.getElementById("squadError");
const emptyEl = document.getElementById("squadEmpty");
const copyBtn = document.getElementById("squadCopyBtn");

let rooms = [];
let audioRoom = null; // at most one room has sound, like Twitch's squad view
const tiles = new Map(); // room -> { el, frame, stateEl, audioBtn, state }

// ---------- helpers ----------

function iconButton(html, key) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "squad-btn";
  btn.innerHTML = html;
  btn.title = t(key);
  btn.setAttribute("aria-label", t(key));
  btn.dataset.i18nTitle = key;
  btn.dataset.i18nAriaLabel = key;
  return btn;
}

// Accept a bare room code, a /watch/<id> path or a full URL.
function parseRoom(raw) {
  const v = String(raw || "").trim().toLowerCase();
  const m = v.match(/\/watch\/([a-z0-9][a-z0-9_-]{2,23})/) || v.match(/^([a-z0-9][a-z0-9_-]{2,23})$/);
  return m ? m[1] : null;
}

function splitTokens(text) {
  return String(text || "").split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

function loadStored() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY));
    if (Array.isArray(raw)) return raw.filter((r) => typeof r === "string" && ROOM_RE.test(r));
  } catch { /* storage unavailable */ }
  return [];
}

function saveStored() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(rooms)); } catch { /* storage unavailable */ }
}

// The room list lives in the hash so a whole squad is one shareable link.
function readHash() {
  const h = location.hash.replace(/^#/, "");
  if (!h) return null;
  const list = [];
  for (const tok of splitTokens(h)) {
    const room = parseRoom(tok);
    if (room && !list.includes(room)) list.push(room);
  }
  return list.length ? list : null;
}

function writeHash() {
  const base = location.pathname + location.search;
  history.replaceState(null, "", rooms.length ? `${base}#${rooms.join(",")}` : base);
}

function squadUrl() {
  return location.origin + location.pathname + (rooms.length ? `#${rooms.join(",")}` : "");
}

// ---------- rendering ----------

function makeTile(room) {
  const el = document.createElement("div");
  el.className = "squad-tile";
  el.dataset.room = room;

  const bar = document.createElement("div");
  bar.className = "squad-tile-bar";

  const name = document.createElement("span");
  name.className = "squad-tile-name";
  name.textContent = room;

  const stateEl = document.createElement("span");
  stateEl.className = "squad-tile-state";
  stateEl.dataset.i18n = "squad.state.waiting";
  stateEl.textContent = t("squad.state.waiting");

  const actions = document.createElement("div");
  actions.className = "squad-tile-actions";

  const audioBtn = iconButton(ICON_VOLUME_OFF, "squad.audio");
  audioBtn.setAttribute("aria-pressed", "false");
  audioBtn.addEventListener("click", () => toggleAudio(room));

  const fsBtn = iconButton(ICON_FULLSCREEN, "squad.fullscreen");
  fsBtn.addEventListener("click", () => toggleFullscreen(el));

  const tabLink = document.createElement("a");
  tabLink.className = "squad-btn";
  tabLink.href = `/watch/${room}`;
  tabLink.target = "_blank";
  tabLink.rel = "noopener";
  tabLink.innerHTML = ICON_TAB;
  tabLink.title = t("squad.openTab");
  tabLink.setAttribute("aria-label", t("squad.openTab"));
  tabLink.dataset.i18nTitle = "squad.openTab";
  tabLink.dataset.i18nAriaLabel = "squad.openTab";

  const removeBtn = iconButton(ICON_CLOSE, "squad.remove");
  removeBtn.classList.add("squad-remove");
  removeBtn.addEventListener("click", () => removeRoom(room));

  actions.append(audioBtn, fsBtn, tabLink, removeBtn);
  bar.append(name, stateEl, actions);

  const frame = document.createElement("iframe");
  frame.className = "squad-frame";
  frame.loading = "lazy";
  // autoplay lets the muted stream start without a gesture; fullscreen lets the
  // tile's own controls be used from inside the frame too.
  frame.setAttribute("allow", "autoplay; fullscreen");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.title = room;
  frame.src = `/watch/${room}?embed=1`;

  el.append(frame, bar);
  return { el, frame, stateEl, audioBtn, state: "waiting" };
}

function render() {
  for (const [room, tile] of [...tiles]) {
    if (!rooms.includes(room)) {
      tile.el.remove();
      tiles.delete(room);
    }
  }
  for (const room of rooms) {
    if (tiles.has(room)) continue;
    const tile = makeTile(room);
    tiles.set(room, tile);
    grid.appendChild(tile.el);
  }
  if (audioRoom && !rooms.includes(audioRoom)) audioRoom = null;
  emptyEl.hidden = rooms.length > 0;
  applyAudio();
}

function setTileState(tile, state) {
  tile.state = state;
  const key = state === "live" ? "squad.state.live"
    : state === "gone" ? "squad.state.gone"
      : "squad.state.waiting";
  tile.stateEl.dataset.i18n = key;
  tile.stateEl.textContent = t(key);
  tile.stateEl.classList.toggle("live", state === "live");
  tile.el.classList.toggle("is-live", state === "live");
}

// ---------- audio ----------

function sendAudio(tile, on) {
  const win = tile.frame.contentWindow;
  if (!win) return;
  try {
    win.postMessage({ channel: "golive", type: "audio", muted: !on, volume: 1 }, location.origin);
  } catch { /* frame not ready */ }
}

function applyAudio() {
  for (const [room, tile] of tiles) {
    const on = room === audioRoom;
    sendAudio(tile, on);
    tile.el.classList.toggle("is-audio", on);
    tile.audioBtn.innerHTML = on ? ICON_VOLUME_ON : ICON_VOLUME_OFF;
    tile.audioBtn.setAttribute("aria-pressed", String(on));
  }
}

function toggleAudio(room) {
  audioRoom = audioRoom === room ? null : room;
  applyAudio();
}

function toggleFullscreen(el) {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => { });
    return;
  }
  el.requestFullscreen().catch(() => { });
}

// ---------- add / remove ----------

function showError(kind) {
  if (!kind) { errorEl.hidden = true; return; }
  errorEl.textContent = kind === "full"
    ? t("squad.full", { max: MAX_ROOMS })
    : t("squad.invalidCode");
  errorEl.hidden = false;
}

// Returns null on success, or "invalid"/"full" when something was rejected.
function addRooms(text) {
  const tokens = splitTokens(text);
  if (!tokens.length) return null;
  let invalid = false;
  let full = false;
  for (const tok of tokens) {
    const room = parseRoom(tok);
    if (!room) { invalid = true; continue; }
    if (rooms.includes(room)) continue;
    if (rooms.length >= MAX_ROOMS) { full = true; continue; }
    rooms.push(room);
  }
  saveStored();
  writeHash();
  render();
  return invalid ? "invalid" : (full ? "full" : null);
}

function removeRoom(room) {
  rooms = rooms.filter((r) => r !== room);
  const tile = tiles.get(room);
  if (tile) { tile.el.remove(); tiles.delete(room); }
  if (audioRoom === room) audioRoom = null;
  emptyEl.hidden = rooms.length > 0;
  applyAudio();
  saveStored();
  writeHash();
}

// ---------- wiring ----------

form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!input.value.trim()) return;
  const err = addRooms(input.value);
  showError(err);
  if (!err) input.value = "";
  input.focus();
});

input.addEventListener("input", () => { errorEl.hidden = true; });

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(squadUrl());
  } catch {
    return;
  }
  const old = copyBtn.textContent;
  copyBtn.textContent = t("app.copied");
  setTimeout(() => { copyBtn.textContent = old; }, 2000);
});

// The embedded viewer reports whether its tile carries a live stream.
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin) return;
  const d = e.data;
  if (!d || d.channel !== "golive" || d.type !== "state") return;
  const tile = tiles.get(d.room);
  if (!tile) return;
  setTileState(tile, d.state);
  // A frame only announces itself once it has loaded and knows it is embedded,
  // so this is also the moment it can accept its audio assignment.
  applyAudio();
});

(function boot() {
  const shared = readHash();
  rooms = (shared || loadStored()).slice(0, MAX_ROOMS);
  writeHash();
  render();
})();
