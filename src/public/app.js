// Golive: browser screen sharing over WebRTC, signaled by Cloudflare Workers.
// Host: /host   Viewer: /watch/<roomId>   Landing: /
// The streamer keeps one RTCPeerConnection per viewer (a mesh); the
// diagnostics panel describes whichever viewer is selected.
"use strict";

const $ = (id) => document.getElementById(id);

// STUN only. No TURN on purpose: if no direct path exists, ICE fails visibly.
const RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

// Opus tuning for shared tab/system audio. Opus is negotiated through SDP, not
// setParameters, so `preferOpus()` edits the offer's fmtp line. The default cap
// is only ~32 kbps; this raises it and keeps music from collapsing to mono.
const OPUS_MAX_BITRATE = 128_000;
const OPUS_STEREO = true;

// The viewer only ever talks to one streamer, so it uses a single fixed key.
const VIEWER_KEY = "streamer";

// Room IDs are shared in the URL, so keep them lowercase and URL-safe.
const ROOM_ID_RE = /^[a-z0-9][a-z0-9_-]{2,23}$/;
const ROOM_STORAGE_KEY = "golive.roomId";
const AUDIO_PREFS_KEY = "golive.audio";
const PREFS_KEY = "golive.prefs";

// A /watch/<id> path means viewer; /host (and anything else) means host.
const match = location.pathname.match(/^\/watch\/([a-z0-9][a-z0-9_-]{2,23})$/);
const roomFromUrl = match ? match[1] : null;
const ROLE = roomFromUrl ? "viewer" : "streamer";

let ws = null;
let localStream = null;
let roomId = roomFromUrl;
let statsTimer = null;
let focusedId = null; // peer whose details the diagnostics panel shows
const conns = new Map(); // peerId -> connection state

// Reconnect state for the signaling socket (viewers wait, streamers resume).
let reconnectTimer = null;
let reconnectDelay = 1000;
let signalingRoom = null;
let signalingRole = null;

const STAT_FIELDS = [
  "dPair", "dPath", "dRtt", "dCodec", "dRes",
  "dFps", "dBitrate", "dAudioCodec", "dAudioBitrate", "dImpl", "dCands",
];

// ---------- UI helpers ----------

function log(msg, level = "") {
  const line = document.createElement("div");
  if (level) line.className = level;
  const t = new Date().toLocaleTimeString();
  line.textContent = `[${t}] ${msg}`;
  const el = $("log");
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function setField(id, text, cls = "") {
  const el = $(id);
  el.textContent = text;
  el.className = cls;
}

function showAlert(msg, level = "warn") {
  const el = $("alert");
  el.textContent = msg;
  el.className = `alert ${level}`;
  el.hidden = false;
}

function clearAlert() {
  $("alert").hidden = true;
}

// Viewer volume/mute is remembered across reloads. Audio still starts muted so
// autoplay is permitted; a saved "unmuted" choice is restored once playback has
// started (see pc.ontrack). `audioState` tracks the last applied/known state so
// programmatic changes aren't mistaken for user ones and persisted.
let audioState = { volume: 1, muted: true };

function loadAudioPrefs() {
  try {
    const raw = localStorage.getItem(AUDIO_PREFS_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      const volume = typeof o.volume === "number" && o.volume >= 0 && o.volume <= 1 ? o.volume : 1;
      return { volume, muted: o.muted !== false };
    }
  } catch { /* storage unavailable */ }
  return { volume: 1, muted: true };
}

function saveAudioPrefs() {
  try { localStorage.setItem(AUDIO_PREFS_KEY, JSON.stringify(audioState)); } catch { /* storage unavailable */ }
}

// Streamer preferences (quality preset, Prefer AV1, Share audio) are remembered
// so a returning host does not have to re-pick them on every visit.
function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return JSON.parse(raw) || {};
  } catch { /* storage unavailable */ }
  return {};
}

function savePrefs(patch) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch })); } catch { /* storage unavailable */ }
}

// Apply volume/mute without treating it as a new user preference.
function applyAudioState(video, prefs) {
  audioState = { volume: prefs.volume, muted: prefs.muted };
  video.volume = prefs.volume;
  video.muted = prefs.muted;
}

function resetStatValues() {
  STAT_FIELDS.forEach((id) => setField(id, "\u2013"));
}

function setVideoActive(active, isWaiting = false) {
  const vid = $("video");
  const ph = $("videoPlaceholder");
  const pht = $("placeholderText");
  if (!ph || !vid) return;
  if (active) {
    ph.hidden = true;
    vid.hidden = false;
  } else {
    ph.hidden = false;
    vid.hidden = true;
    if (pht) {
      if (ROLE === "viewer") {
        pht.textContent = isWaiting ? t("placeholder.waiting") : t("placeholder.disconnected");
      } else {
        pht.textContent = t("placeholder.start");
      }
    }
  }
}

function checkAudioHint() {
  const hint = $("audioHint");
  const vid = $("video");
  if (!hint || !vid) return;
  if (ROLE === "viewer" && vid.srcObject && vid.srcObject.getAudioTracks().length > 0 && vid.muted) {
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }
}

function resetStatsFields() {
  resetStatValues();
  setField("dIce", "new");
  setField("dPc", "\u2013");
  if (ROLE === "streamer") {
    setField("dViewers", String(conns.size));
    setField("dQuality", presetLabel());
  }
}

function peerLabel(peerId) {
  return ROLE === "viewer" ? t("peer.streamer") : t("peer.viewer", { id: peerId });
}

function iceClass(s) {
  return s === "connected" || s === "completed" ? "ok" : s === "failed" ? "bad" : s === "disconnected" ? "warn" : "";
}

// ---------- Codec support ----------

function hasAv1(caps) {
  return !!caps && caps.codecs.some((c) => c.mimeType.toLowerCase() === "video/av1");
}

function reportSupport() {
  try {
    const send = hasAv1(RTCRtpSender.getCapabilities("video"));
    const recv = hasAv1(RTCRtpReceiver.getCapabilities("video"));
    const text = `${t("support.send")}: ${t(send ? "support.yes" : "support.no")}, ${t("support.receive")}: ${t(recv ? "support.yes" : "support.no")}`;
    const relevant = ROLE === "streamer" ? send : recv;
    setField("dSupport", text, relevant ? "ok" : "warn");
    if (!relevant) {
      log(t(ROLE === "streamer" ? "log.av1UnavailableSend" : "log.av1UnavailableRecv"), "warn");
    }
  } catch (e) {
    setField("dSupport", t("support.unknown"), "warn");
  }
}

// Put AV1 first, keep every other codec (including RTX/RED/FEC) as fallbacks.
function applyCodecPreferences(transceiver, kind) {
  if (!$("preferAv1").checked) {
    log(t("log.av1Disabled"));
    return;
  }
  if (!transceiver || typeof transceiver.setCodecPreferences !== "function") {
    log(t("log.codecPrefsUnsupported"), "warn");
    return;
  }
  const caps = (kind === "sender" ? RTCRtpSender : RTCRtpReceiver).getCapabilities("video");
  if (!hasAv1(caps)) {
    log(t("log.av1NotSupported"), "warn");
    return;
  }
  const isAv1 = (c) => c.mimeType.toLowerCase() === "video/av1";
  const prefs = [...caps.codecs.filter(isAv1), ...caps.codecs.filter((c) => !isAv1(c))];
  try {
    transceiver.setCodecPreferences(prefs);
    log(t("log.codecPrefsSet", { count: prefs.length - caps.codecs.filter(isAv1).length }));
  } catch (e) {
    log(t("log.codecPrefsFailed", { message: e.message }), "warn");
  }
}

// ---------- Quality presets ----------

// Sender-side quality presets. maxBitrate is a ceiling applied with
// RTCRtpSender.setParameters(); the browser still adapts to the network, so
// the achieved bitrate can be lower (never higher) than maxBitrate.
// targetHeight is the encoded resolution we aim for; the scale factor is
// derived from the captured track so an oversized capture (a 1440p/4K screen)
// is not crammed into a 1080p bitrate budget. scaleResolutionDownBy is the
// fallback when the captured size is unknown. Screen content is mostly static,
// so the presets prefer keeping resolution sharp over keeping every frame.
const QUALITY_PRESETS = {
  "4k60": {
    labelKey: "preset.4k60",
    shortKey: "preset.4k60.short",
    maxBitrate: 40_000_000,
    maxFramerate: 60,
    captureFps: 60,
    targetHeight: 2160,
    scaleResolutionDownBy: 1,
    degradationPreference: "maintain-resolution",
  },
  "4k30": {
    labelKey: "preset.4k30",
    shortKey: "preset.4k30.short",
    maxBitrate: 25_000_000,
    maxFramerate: 30,
    captureFps: 30,
    targetHeight: 2160,
    scaleResolutionDownBy: 1,
    degradationPreference: "maintain-resolution",
  },
  "1440p60": {
    labelKey: "preset.1440p60",
    shortKey: "preset.1440p60.short",
    maxBitrate: 20_000_000,
    maxFramerate: 60,
    captureFps: 60,
    targetHeight: 1440,
    scaleResolutionDownBy: 1,
    degradationPreference: "maintain-resolution",
  },
  "1080p60": {
    labelKey: "preset.1080p60",
    shortKey: "preset.1080p60.short",
    maxBitrate: 12_000_000,
    maxFramerate: 60,
    captureFps: 60,
    targetHeight: 1080,
    scaleResolutionDownBy: 1,
    degradationPreference: "maintain-resolution",
  },
  "1080p30": {
    labelKey: "preset.1080p30",
    shortKey: "preset.1080p30.short",
    maxBitrate: 8_000_000,
    maxFramerate: 30,
    captureFps: 30,
    targetHeight: 1080,
    scaleResolutionDownBy: 1,
    degradationPreference: "maintain-resolution",
  },
  // Screen content is often static text. A low frame rate with a high bitrate
  // ceiling keeps far more detail per frame, so text stays sharp instead of
  // being blurred away when the encoder adapts.
  text: {
    labelKey: "preset.text",
    shortKey: "preset.text.short",
    maxBitrate: 8_000_000,
    maxFramerate: 15,
    captureFps: 15,
    targetHeight: 1440,
    scaleResolutionDownBy: 1,
    degradationPreference: "maintain-resolution",
  },
  "720p30": {
    labelKey: "preset.720p30",
    shortKey: "preset.720p30.short",
    maxBitrate: 4_000_000,
    maxFramerate: 30,
    captureFps: 30,
    targetHeight: 720,
    scaleResolutionDownBy: 1.5,
    degradationPreference: "balanced",
  },
  low: {
    labelKey: "preset.low",
    shortKey: "preset.low.short",
    maxBitrate: 1_000_000,
    maxFramerate: 24,
    captureFps: 24,
    targetHeight: 540,
    scaleResolutionDownBy: 2,
    degradationPreference: "maintain-framerate",
  },
  auto: {
    labelKey: "preset.auto",
    shortKey: "preset.auto.short",
    maxBitrate: null,
    maxFramerate: null,
    captureFps: 60,
    targetHeight: null,
    scaleResolutionDownBy: 1,
    degradationPreference: "balanced",
  },
};

function currentPresetKey() {
  const el = $("quality");
  return el && QUALITY_PRESETS[el.value] ? el.value : "1080p60";
}

function presetLabel(key = currentPresetKey()) {
  const p = QUALITY_PRESETS[key] || QUALITY_PRESETS["1080p60"];
  return t(p.labelKey);
}

// Encoded resolution follows the preset's target height instead of a fixed
// factor, so a large capture is scaled to the resolution its bitrate budget
// was chosen for (and never upscaled).
function scaleForPreset(preset, sender) {
  const track = sender.track;
  const height = track && typeof track.getSettings === "function" ? track.getSettings().height : 0;
  if (preset.targetHeight && height) {
    // Never upscale: scaleResolutionDownBy must be >= 1, so a capture smaller
    // than the preset's target is left at its native size.
    const scale = Math.max(1, height / preset.targetHeight);
    return Math.round(scale * 100) / 100;
  }
  return preset.scaleResolutionDownBy || 1;
}

// Apply a preset to one video sender. maxBitrate is a ceiling, not a floor:
// the encoder may send less when the network or CPU is constrained.
async function applyQualityToSender(sender, key) {
  if (!sender || typeof sender.getParameters !== "function" || typeof sender.setParameters !== "function") return;
  const preset = QUALITY_PRESETS[key] || QUALITY_PRESETS.auto;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    const enc = params.encodings[0];
    if (preset.maxBitrate == null) {
      // "Auto": drop the limits and let the browser decide.
      delete enc.maxBitrate;
      delete enc.maxFramerate;
      delete enc.scaleResolutionDownBy;
      params.degradationPreference = "balanced";
    } else {
      enc.maxBitrate = preset.maxBitrate;
      if (preset.maxFramerate != null) {
        enc.maxFramerate = preset.maxFramerate;
      } else {
        delete enc.maxFramerate;
      }
      enc.scaleResolutionDownBy = scaleForPreset(preset, sender);
      enc.priority = "high";
      enc.networkPriority = "high";
      params.degradationPreference = preset.degradationPreference;
    }
    await sender.setParameters(params);
  } catch (e) {
    log(t("log.qualityApplyFailed", { label: t(preset.labelKey), message: e.message }), "warn");
  }
}

// Streamer: apply to every viewer's video sender (on change, and for new joins).
async function applyQualityToAllSenders(key = currentPresetKey()) {
  for (const conn of conns.values()) {
    for (const sender of conn.pc.getSenders()) {
      if (sender.track && sender.track.kind === "video") await applyQualityToSender(sender, key);
    }
  }
}

// ---------- Signaling ----------

function wsUrl(room, role) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({ room, role });
  return `${proto}://${location.host}/ws?${q.toString()}`;
}

// Open the signaling socket for a room. Registration happens on connect (the
// room and role ride in the query string), so there is no create/join
// handshake. The socket auto-reconnects with backoff while the page is live.
function connectSignaling(room, role) {
  signalingRoom = room;
  signalingRole = role;
  return new Promise((resolve, reject) => {
    setField("dSignaling", t("signal.connecting"));
    const sock = new WebSocket(wsUrl(room, role));
    ws = sock;
    let settled = false;
    sock.onopen = () => {
      reconnectDelay = 1000;
      setField("dSignaling", t("signal.connected"), "ok");
      if (!settled) { settled = true; resolve(); }
    };
    sock.onerror = () => {
      if (ws !== sock) return;
      setField("dSignaling", t("signal.error"), "bad");
      if (!settled) { settled = true; reject(new Error(t("log.signalUnreachable"))); }
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      setField("dSignaling", t("signal.closed"), "warn");
      if (isLive()) scheduleReconnect();
    };
    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleSignal(msg).catch((e) => log(t("log.signalHandleError", { message: e.message }), "bad"));
    };
  });
}

// A streamer stays live while it is sharing; a viewer stays live until it
// leaves the page.
function isLive() {
  return ROLE === "streamer" ? !!localStream : true;
}

function scheduleReconnect() {
  if (reconnectTimer || !signalingRoom) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!signalingRoom || !isLive()) return;
    log(t("log.reconnecting", { room: signalingRoom }), "warn");
    try {
      await connectSignaling(signalingRoom, signalingRole);
      log(t("log.reconnected"));
    } catch {
      scheduleReconnect();
    }
  }, delay);
}

function stopReconnecting() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectDelay = 1000;
  signalingRoom = null;
  signalingRole = null;
}

function signal(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// Streamer -> viewer messages carry a "to"; viewer -> streamer messages are
// tagged with the sender's peer id by the server.
function makeSignal(type, peerId, payload) {
  return ROLE === "streamer" ? { type, to: peerId, payload } : { type, payload };
}

async function handleSignal(msg) {
  switch (msg.type) {
    case "created":
      closeAllConns(); // drop any stale peers from a previous connection
      showRoomLink();
      log(t("log.roomLive", { room: roomId }));
      break;
    case "joined":
      closeAllConns(); // fresh peer id after a reconnect
      log(t("log.joined", { room: msg.room }));
      showWaiting();
      break;
    case "streamer-waiting":
      showWaiting();
      break;
    case "peer-joined":
      log(t("log.viewerJoined", { id: msg.peerId }));
      clearAlert();
      await startOffer(msg.peerId);
      break;
    case "peer-left":
      log(t("log.viewerLeft", { id: msg.peerId }), "warn");
      closeConn(msg.peerId);
      break;
    case "streamer-left":
      log(t("log.streamerLeft"), "warn");
      closeAllConns();
      showWaiting();
      break;
    case "offer":
      await handleOffer(msg.payload);
      break;
    case "answer":
      await handleAnswer(msg.from, msg.payload);
      break;
    case "candidate":
      await handleRemoteCandidate(ROLE === "viewer" ? VIEWER_KEY : msg.from, msg.payload);
      break;
    case "error": {
      const message = msg.code === "room-in-use" ? t("alert.roomInUse")
        : msg.code === "room-full" ? t("alert.roomFull")
        : msg.message;
      log(t("log.serverError", { message }), "bad");
      showAlert(message, "bad");
      if (msg.code === "room-in-use" || msg.code === "room-full") {
        if (ROLE === "streamer" && localStream) stopSharing();
        else { stopReconnecting(); if (ws) ws.close(); }
      }
      break;
    }
  }
}

// ---------- Peer connections (one per viewer on the streamer side) ----------

function createPc(peerId) {
  closeConn(peerId); // replace any previous connection for this peer

  const conn = {
    pc: new RTCPeerConnection(RTC_CONFIG),
    pending: [],
    prevBytes: null,
    prevAudioBytes: null,
    warnedCodec: false,
    candCounts: { local: {}, total: 0 },
    display: null,
    iceRestartTimer: null,
    iceRestarts: 0,
  };
  conns.set(peerId, conn);
  if (!focusedId) setFocused(peerId);
  updatePeerSelect();
  updateViewerCount();
  clearAlert();

  const pc = conn.pc;
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      noteLocalCandidate(peerId, conn, e.candidate);
      signal(makeSignal("candidate", peerId, e.candidate.toJSON()));
    } else {
      log(t("log.iceGatheringComplete", { peer: peerLabel(peerId) }));
      signal(makeSignal("candidate", peerId, null));
    }
  };
  pc.onicecandidateerror = (e) => {
    // Common for unreachable STUN over one address family; informational.
    log(t("log.iceCandidateError", { peer: peerLabel(peerId), code: e.errorCode || "", text: e.errorText || "" }).trim(), "warn");
  };
  pc.onicegatheringstatechange = () => log(t("log.iceGathering", { peer: peerLabel(peerId), state: pc.iceGatheringState }));
  pc.oniceconnectionstatechange = () => onIceState(peerId);
  pc.onconnectionstatechange = () => {
    log(t("log.pcState", { peer: peerLabel(peerId), state: pc.connectionState }));
    if (peerId === focusedId) setField("dPc", pc.connectionState);
  };
  pc.ontrack = (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    const video = $("video");
    video.srcObject = stream;
    // Start muted so autoplay is allowed; the viewer unmutes with the
    // video controls' speaker icon or the unmute banner. Once playback has
    // actually started, restore the saved volume/mute.
    const prefs = loadAudioPrefs();
    applyAudioState(video, { volume: prefs.volume, muted: true });
    const playing = video.play();
    if (playing && typeof playing.then === "function") {
      playing
        .then(() => { if (!prefs.muted) video.muted = false; checkAudioHint(); })
        .catch(() => { });
    }
    setVideoActive(true);
    checkAudioHint();
    log(t(e.track.kind === "audio" ? "log.remoteAudio" : "log.remoteVideo"));
  };

  startStats();
  return conn;
}

function closeConn(peerId) {
  const conn = conns.get(peerId);
  if (!conn) return;
  if (conn.iceRestartTimer) {
    clearTimeout(conn.iceRestartTimer);
    conn.iceRestartTimer = null;
  }
  const pc = conn.pc;
  if (pc) {
    pc.onicecandidate = pc.onicecandidateerror = pc.onicegatheringstatechange =
      pc.oniceconnectionstatechange = pc.onconnectionstatechange = pc.ontrack = null;
    try { pc.close(); } catch { /* already closed */ }
  }
  conns.delete(peerId);
  if (conns.size === 0) stopStats();
  if (focusedId === peerId) focusedId = conns.size ? conns.keys().next().value : null;
  updatePeerSelect();
  updateViewerCount();

  const next = focusedId ? conns.get(focusedId) : null;
  if (next && next.pc) {
    setField("dIce", next.pc.iceConnectionState, iceClass(next.pc.iceConnectionState));
    setField("dPc", next.pc.connectionState || "\u2013");
    renderFocused();
  } else {
    setField("dIce", "new");
    setField("dPc", "\u2013");
    resetStatValues();
  }
}

function closeAllConns() {
  for (const peerId of [...conns.keys()]) closeConn(peerId);
}

function updateViewerCount() {
  if (ROLE === "streamer") setField("dViewers", String(conns.size));
}

function updatePeerSelect() {
  if (ROLE !== "streamer") return;
  const sel = $("peerSelect");
  sel.innerHTML = "";
  if (conns.size === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = t("peer.none");
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const peerId of conns.keys()) {
    const opt = document.createElement("option");
    opt.value = peerId;
    opt.textContent = t("peer.viewer", { id: peerId });
    if (peerId === focusedId) opt.selected = true;
    sel.appendChild(opt);
  }
}

function setFocused(peerId) {
  focusedId = peerId;
  const conn = peerId ? conns.get(peerId) : null;
  if (conn && conn.pc) {
    setField("dIce", conn.pc.iceConnectionState, iceClass(conn.pc.iceConnectionState));
    setField("dPc", conn.pc.connectionState || "\u2013");
  }
  updatePeerSelect();
  renderFocused();
}

function onIceState(peerId) {
  const conn = conns.get(peerId);
  if (!conn) return;
  const s = conn.pc.iceConnectionState;
  log(t("log.iceState", { peer: peerLabel(peerId), state: s }), iceClass(s));

  // The streamer is the offerer, so it can retry the path with an ICE restart
  // when the connection drops. "disconnected" is often transient, so give it a
  // moment; "failed" is terminal, so act sooner. A recovery cancels any retry.
  if (ROLE === "streamer") {
    if (s === "disconnected" || s === "failed") {
      scheduleIceRestart(peerId, s === "failed" ? 1500 : 4000);
    } else if (s === "connected" || s === "completed") {
      cancelIceRestart(conn);
      conn.iceRestarts = 0;
    }
  }

  if (peerId !== focusedId) return;
  setField("dIce", s, iceClass(s));
  if (s === "failed") {
    showAlert(t("alert.iceFailed"), "bad");
  } else if (s === "disconnected") {
    showAlert(t("alert.iceDisconnected"), "warn");
  } else if (s === "connected" || s === "completed") {
    clearAlert();
  }
}

// Cap the number of ICE restarts per connection so a permanently unreachable
// peer does not keep renegotiating forever.
const MAX_ICE_RESTARTS = 3;

function cancelIceRestart(conn) {
  if (conn && conn.iceRestartTimer) {
    clearTimeout(conn.iceRestartTimer);
    conn.iceRestartTimer = null;
  }
}

function scheduleIceRestart(peerId, delay) {
  const conn = conns.get(peerId);
  if (!conn || conn.iceRestartTimer) return; // one attempt queued at a time
  conn.iceRestartTimer = setTimeout(() => {
    conn.iceRestartTimer = null;
    const pc = conn.pc;
    if (!pc || pc.signalingState === "closed") return;
    const state = pc.iceConnectionState;
    if (state !== "disconnected" && state !== "failed") return; // recovered
    doIceRestart(peerId);
  }, delay);
}

async function doIceRestart(peerId) {
  const conn = conns.get(peerId);
  if (!conn || !conn.pc || typeof conn.pc.restartIce !== "function") return;
  if (conn.iceRestarts >= MAX_ICE_RESTARTS) {
    log(t("log.iceRestartGaveUp", { peer: peerLabel(peerId) }), "bad");
    return;
  }
  conn.iceRestarts++;
  try {
    conn.pc.restartIce();
    const offer = await conn.pc.createOffer({ iceRestart: true });
    await conn.pc.setLocalDescription(offer);
    signal(makeSignal("offer", peerId, conn.pc.localDescription.toJSON()));
    log(t("log.iceRestart", { peer: peerLabel(peerId), attempt: conn.iceRestarts }), "warn");
    // If it is still down a few seconds later, try again (up to the cap).
    scheduleIceRestart(peerId, 6000);
  } catch (e) {
    log(t("log.iceRestartFailed", { peer: peerLabel(peerId), message: e.message }), "warn");
  }
}

// Log candidate type/family without showing or storing the address.
function noteLocalCandidate(peerId, conn, c) {
  const parts = (c.candidate || "").split(" ");
  const addr = parts[4] || "";
  const type = parts[7] || "?";
  let family = "unknown";
  if (addr.endsWith(".local")) family = "mDNS";
  else if (addr.includes(":")) family = "IPv6";
  else if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) family = "IPv4";
  const key = `${family} ${type}`;
  conn.candCounts.local[key] = (conn.candCounts.local[key] || 0) + 1;
  conn.candCounts.total++;
  if (peerId === focusedId) {
    setField("dCands", Object.entries(conn.candCounts.local).map(([k, v]) => `${k} \u00d7${v}`).join(", "));
  }
  log(t("log.localCandidate", { peer: peerLabel(peerId), family, type, proto: parts[2] || "?" }));
}

// Raise the negotiated Opus bitrate/stereo by editing the offer's fmtp line.
// Merges with the parameters the browser already set (e.g. minptime) so the
// existing Opus settings survive.
function preferOpus(sdp) {
  if (!sdp) return sdp;
  const rm = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
  if (!rm) return sdp;
  const pt = rm[1];
  const fmtpRe = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  const existing = sdp.match(fmtpRe);
  const params = new Map();
  if (existing) {
    for (const kv of existing[1].split(";")) {
      const [k, v] = kv.split("=");
      if (k && k.trim()) params.set(k.trim(), (v || "").trim());
    }
  }
  params.set("maxaveragebitrate", String(OPUS_MAX_BITRATE));
  if (OPUS_STEREO) {
    params.set("stereo", "1");
    params.set("sprop-stereo", "1");
  }
  const line = `a=fmtp:${pt} ` + [...params].map(([k, v]) => (v ? `${k}=${v}` : k)).join(";");
  if (existing) return sdp.replace(fmtpRe, line);
  return sdp.replace(new RegExp(`(a=rtpmap:${pt} opus\\/48000[^\\r\\n]*)`), `$1\r\n${line}`);
}

// Streamer: create and send an offer for one viewer.
async function startOffer(peerId) {
  const conn = createPc(peerId);
  const track = localStream.getVideoTracks()[0];
  const tr = conn.pc.addTransceiver(track, { direction: "sendonly", streams: [localStream] });
  applyCodecPreferences(tr, "sender");
  await applyQualityToSender(tr.sender, currentPresetKey());
  // Screen/tab audio rides along on its own transceiver; leave it on the
  // browser's default codec (Opus) rather than the video AV1 preference.
  const audioTrack = localStream.getAudioTracks()[0];
  if (audioTrack) conn.pc.addTransceiver(audioTrack, { direction: "sendonly", streams: [localStream] });
  const offer = await conn.pc.createOffer();
  if (audioTrack) offer.sdp = preferOpus(offer.sdp);
  await conn.pc.setLocalDescription(offer);
  signal(makeSignal("offer", peerId, conn.pc.localDescription.toJSON()));
  log(t("log.offerSent", { peer: peerLabel(peerId), media: t(audioTrack ? "media.videoAudio" : "media.videoOnly") }));
}

// Viewer: answer the streamer's offer. A new offer on a live connection is a
// renegotiation (ICE restart), so reuse the peer connection instead of tearing
// it down — playback recovers without rebuilding from scratch.
async function handleOffer(offer) {
  const existing = conns.get(VIEWER_KEY);
  const conn = existing && existing.pc && existing.pc.signalingState !== "closed"
    ? existing
    : createPc(VIEWER_KEY);
  await conn.pc.setRemoteDescription(offer);
  await flushCandidates(conn);
  const tr = conn.pc.getTransceivers().find((t) => t.receiver && t.receiver.track && t.receiver.track.kind === "video");
  applyCodecPreferences(tr, "receiver");
  const answer = await conn.pc.createAnswer();
  await conn.pc.setLocalDescription(answer);
  signal(makeSignal("answer", VIEWER_KEY, conn.pc.localDescription.toJSON()));
  log(t("log.answerSent"));
}

async function handleAnswer(peerId, answer) {
  const conn = conns.get(peerId);
  if (!conn) return;
  await conn.pc.setRemoteDescription(answer);
  await flushCandidates(conn);
  log(t("log.answerReceived", { peer: peerLabel(peerId) }));
}

async function handleRemoteCandidate(peerId, cand) {
  const conn = conns.get(peerId);
  if (!conn) return;
  if (!conn.pc.remoteDescription) {
    conn.pending.push(cand);
    return;
  }
  await addCandidate(conn, cand);
}

async function addCandidate(conn, cand) {
  try {
    await conn.pc.addIceCandidate(cand || undefined);
  } catch (e) {
    log(t("log.addCandidateFailed", { message: e.message }), "warn");
  }
}

async function flushCandidates(conn) {
  const queued = conn.pending;
  conn.pending = [];
  for (const c of queued) await addCandidate(conn, c);
}

// ---------- Stats ----------

function startStats() {
  if (statsTimer) return;
  statsTimer = setInterval(pollStats, 1000);
}

function stopStats() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
}

function describeFamily(c) {
  const addr = (c && (c.address || c.ip)) || "";
  if (!addr) return "unknown";
  if (addr.endsWith(".local")) return "mDNS";
  if (addr.includes(":")) return "IPv6";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return "IPv4";
  return "unknown";
}

async function pollStats() {
  for (const [peerId, conn] of conns) {
    let stats;
    try { stats = await conn.pc.getStats(); } catch { continue; }
    collectStats(peerId, conn, stats);
  }
  renderFocused();
}

// Turn a getStats() report into a display object stored on the connection.
function collectStats(peerId, conn, stats) {
  const d = {};
  const byId = new Map();
  let selectedPairId = null;
  stats.forEach((r) => {
    byId.set(r.id, r);
    if (r.type === "transport" && r.selectedCandidatePairId) selectedPairId = r.selectedCandidatePairId;
  });

  let pair = selectedPairId ? byId.get(selectedPairId) : null;
  if (!pair) {
    stats.forEach((r) => {
      if (r.type === "candidate-pair" && (r.selected || (r.nominated && r.state === "succeeded"))) pair = r;
    });
  }

  if (pair) {
    const local = byId.get(pair.localCandidateId);
    const remote = byId.get(pair.remoteCandidateId);
    const lf = describeFamily(local), rf = describeFamily(remote);
    const lt = local ? local.candidateType : "?", rt = remote ? remote.candidateType : "?";
    const proto = local && local.protocol ? local.protocol.toUpperCase() : "";
    d.pair = `${t("pair.local")}: ${lf} ${lt} \u00b7 ${t("pair.remote")}: ${rf} ${rt}${proto ? " \u00b7 " + proto : ""}`;

    const relayed = lt === "relay" || rt === "relay";
    if (relayed) {
      d.path = t("path.relayed");
      d.pathCls = "bad";
    } else {
      let fam = "";
      if (lf === "IPv6" && rf === "IPv6") fam = t("path.overIpv6");
      else if (lf === "IPv4" && rf === "IPv4") fam = t("path.overIpv4");
      else if (lf === "unknown" || rf === "unknown" || lf === "mDNS" || rf === "mDNS") fam = t("path.familyHidden");
      d.path = t("path.direct") + fam;
      d.pathCls = lf === "IPv6" && rf === "IPv6" ? "ok" : "";
    }
    if (typeof pair.currentRoundTripTime === "number") {
      d.rtt = `${Math.round(pair.currentRoundTripTime * 1000)} ms`;
    }
  }

  // Audio stats (best-effort; absent when no audio is being shared).
  const audioRtpType = ROLE === "streamer" ? "outbound-rtp" : "inbound-rtp";
  let audioRtp = null;
  stats.forEach((r) => {
    if (r.type === audioRtpType && (r.kind || r.mediaType) === "audio") audioRtp = r;
  });
  if (audioRtp) {
    const acodec = audioRtp.codecId ? byId.get(audioRtp.codecId) : null;
    if (acodec) {
      const isOpus = acodec.mimeType.toLowerCase() === "audio/opus";
      d.audioCodec = acodec.mimeType;
      d.audioCodecCls = isOpus ? "ok" : "";
    }
    const abytes = ROLE === "streamer" ? audioRtp.bytesSent : audioRtp.bytesReceived;
    if (typeof abytes === "number" && typeof audioRtp.timestamp === "number") {
      if (conn.prevAudioBytes && audioRtp.timestamp > conn.prevAudioBytes.ts) {
        const abps = ((abytes - conn.prevAudioBytes.bytes) * 8) / ((audioRtp.timestamp - conn.prevAudioBytes.ts) / 1000);
        d.audioBitrate = `${(abps / 1e3).toFixed(0)} kbps`;
      }
      conn.prevAudioBytes = { bytes: abytes, ts: audioRtp.timestamp };
    }
  }

  // Pick the active video RTP stream (outbound for streamer, inbound for viewer).
  const rtpType = ROLE === "streamer" ? "outbound-rtp" : "inbound-rtp";
  let rtp = null;
  stats.forEach((r) => {
    if (r.type === rtpType && (r.kind || r.mediaType) === "video") {
      if (!rtp || (r.bytesSent || r.bytesReceived || 0) > (rtp.bytesSent || rtp.bytesReceived || 0)) rtp = r;
    }
  });
  if (!rtp) { conn.display = d; return; }

  const codec = rtp.codecId ? byId.get(rtp.codecId) : null;
  if (codec) {
    const mime = codec.mimeType;
    const isAv1 = mime.toLowerCase() === "video/av1";
    d.codec = mime;
    d.codecCls = isAv1 ? "ok" : "warn";
    if (!isAv1 && $("preferAv1").checked && !conn.warnedCodec) {
      conn.warnedCodec = true;
      log(t("log.codecNotAv1", { peer: peerLabel(peerId), mime }), "warn");
      if (peerId === focusedId) {
        showAlert(t("alert.av1Fallback", { mime }), "warn");
      }
    }
    if (isAv1 && !conn.warnedCodec) {
      conn.warnedCodec = true;
      log(t("log.codecIsAv1", { peer: peerLabel(peerId) }), "ok");
    }
  }

  if (rtp.frameWidth && rtp.frameHeight) d.res = `${rtp.frameWidth}\u00d7${rtp.frameHeight}`;
  if (typeof rtp.framesPerSecond === "number") d.fps = `${Math.round(rtp.framesPerSecond)} fps`;

  const impl = ROLE === "streamer" ? rtp.encoderImplementation : rtp.decoderImplementation;
  if (impl) d.impl = `${impl}${rtp.powerEfficientEncoder || rtp.powerEfficientDecoder ? t("diag.implPowerEfficient") : ""}`;

  const bytes = ROLE === "streamer" ? rtp.bytesSent : rtp.bytesReceived;
  if (typeof bytes === "number") {
    if (conn.prevBytes && rtp.timestamp > conn.prevBytes.ts) {
      const bps = ((bytes - conn.prevBytes.bytes) * 8) / ((rtp.timestamp - conn.prevBytes.ts) / 1000);
      d.bitrate = `${(bps / 1e6).toFixed(2)} Mbps`;
    }
    conn.prevBytes = { bytes, ts: rtp.timestamp };
  }

  conn.display = d;
}

function renderFocused() {
  const conn = focusedId ? conns.get(focusedId) : null;
  const d = conn && conn.display;
  if (!d) { resetStatValues(); return; }
  setField("dPair", d.pair || "\u2013");
  setField("dPath", d.path || "\u2013", d.pathCls || "");
  setField("dRtt", d.rtt || "\u2013");
  setField("dCodec", d.codec || "\u2013", d.codecCls || "");
  setField("dRes", d.res || "\u2013");
  setField("dFps", d.fps || "\u2013");
  setField("dBitrate", d.bitrate || "\u2013");
  setField("dAudioCodec", d.audioCodec || "\u2013", d.audioCodecCls || "");
  setField("dAudioBitrate", d.audioBitrate || "\u2013");
  setField("dImpl", d.impl || "\u2013");
  setField("dCands", conn.candCounts.total
    ? Object.entries(conn.candCounts.local).map(([k, v]) => `${k} \u00d7${v}`).join(", ")
    : "\u2013");
}

// ---------- Streamer / viewer flows ----------

function showRoomLink() {
  const url = `${location.origin}/watch/${roomId}`;
  $("roomUrl").value = url;
  $("linkRow").hidden = false;
}

// Viewer placeholder while no streamer is connected. The signaling socket
// stays open, so playback starts automatically when the streamer arrives.
function showWaiting() {
  if (ROLE !== "viewer") return;
  $("video").srcObject = null;
  setVideoActive(false, true);
  checkAudioHint();
}

function randomRoomId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}

// Resolve the streamer's room ID: the typed value, or a fresh random one when
// left blank. Returns null (with an alert) when the typed value is invalid.
function resolveRoomId() {
  const input = $("roomId");
  let id = (input.value || "").trim().toLowerCase();
  if (!id) {
    id = randomRoomId();
    input.value = id;
  }
  if (!ROOM_ID_RE.test(id)) {
    log(t("log.roomIdInvalid", { id }), "bad");
    showAlert(t("alert.roomIdInvalid"), "bad");
    return null;
  }
  return id;
}

// Capture the display. Audio is best-effort and depends on the browser, OS and
// the source the user picks (tabs carry tab audio; screens can carry system
// audio; a window carries only its own audio where the browser supports
// "windowAudio"). The systemAudio/windowAudio hints below tell Chrome which
// audio to offer for each source; other browsers ignore unknown options.
// A real denial/cancel is still surfaced as an error.
async function getDisplayStream(fps, wantAudio) {
  const video = { frameRate: fps };
  if (!wantAudio) return navigator.mediaDevices.getDisplayMedia({ video, audio: false });
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video,
      audio: true,
      systemAudio: "include", // offer system audio (screens) where possible
      windowAudio: "window",  // window shares: only the picked window's audio
    });
  } catch (e) {
    if (e && (e.name === "TypeError" || e.name === "NotSupportedError")) {
      log(t("log.audioRejected", { name: e.name }), "warn");
      return navigator.mediaDevices.getDisplayMedia({ video, audio: false });
    }
    throw e;
  }
}

async function startSharing() {
  $("startBtn").disabled = true;
  const id = resolveRoomId();
  if (!id) { $("startBtn").disabled = false; return; }
  roomId = id;
  try { localStorage.setItem(ROOM_STORAGE_KEY, id); } catch { /* storage unavailable */ }

  const wantAudio = $("shareAudio").checked;
  const preset = QUALITY_PRESETS[currentPresetKey()] || QUALITY_PRESETS["1080p60"];
  const fps = preset.captureFps || 60;
  try {
    localStream = await getDisplayStream(fps, wantAudio);
  } catch (e) {
    log(t("log.captureFailed", { name: e.name, message: e.message }), "bad");
    showAlert(
      window.isSecureContext ? t("alert.captureDenied") : t("alert.captureInsecure"),
      "bad"
    );
    $("startBtn").disabled = false;
    return;
  }
  const audioTracks = localStream.getAudioTracks();
  if (wantAudio && audioTracks.length === 0) {
    log(t("log.noAudioTrack"), "warn");
  } else if (audioTracks.length) {
    log(t("log.audioEnabled", { fps }));
  } else {
    log(t("log.videoOnly", { fps }));
  }
  log(t("log.qualityPreset", { label: presetLabel() }));
  const videoTrack = localStream.getVideoTracks()[0];
  // Hint the encoder that this is screen content so it favours sharp detail
  // (text/UI) over motion. Browsers that don't support it ignore the hint.
  try { videoTrack.contentHint = "detail"; } catch { /* hint unsupported */ }
  const video = $("video");
  video.srcObject = localStream;
  video.muted = true;
  setVideoActive(true);
  videoTrack.addEventListener("ended", () => {
    log(t("log.captureEnded"), "warn");
    stopSharing();
  });
  $("stopBtn").disabled = false;
  $("preferAv1").disabled = true;
  $("shareAudio").disabled = true;
  $("roomId").disabled = true;
  setField("dQuality", presetLabel());
  try {
    await connectSignaling(roomId, "streamer");
  } catch (e) {
    log(e.message, "bad");
    showAlert(e.message, "bad");
    stopSharing();
    return;
  }
}

function stopSharing() {
  closeAllConns();
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  stopReconnecting();
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  $("video").srcObject = null;
  setVideoActive(false);
  checkAudioHint();
  $("linkRow").hidden = true;
  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;
  $("preferAv1").disabled = false;
  $("shareAudio").disabled = false;
  $("roomId").disabled = false;
  setField("dSignaling", t("signal.idle"));
  resetStatsFields();
  log(t("log.sharingStopped"));
}

async function joinRoom() {
  showWaiting();
  try {
    await connectSignaling(roomFromUrl, "viewer");
  } catch (e) {
    // The close handler schedules a retry; the room may just not exist yet.
    log(t("log.retrying", { message: e.message }), "warn");
  }
}

// ---------- Init ----------

function init() {
  $("role").textContent = ROLE === "streamer" ? t("role.host") : t("role.viewer", { room: roomFromUrl });
  const subtitle = $("subtitle");
  if (subtitle) {
    subtitle.textContent = ROLE === "viewer" ? t("sub.viewer") : t("sub.host");
  }
  reportSupport();
  // Start muted so autoplay is permitted; viewers opt into audio via the
  // video controls' speaker icon. The host preview always stays muted, while a
  // viewer's saved volume/mute is applied (unmuted is restored after playback).
  applyAudioState($("video"), ROLE === "streamer" ? { volume: 1, muted: true } : loadAudioPrefs());
  $("peerSelect").addEventListener("change", (e) => setFocused(e.target.value || null));
  $("quality").addEventListener("change", async () => {
    setField("dQuality", presetLabel());
    const preset = QUALITY_PRESETS[currentPresetKey()] || QUALITY_PRESETS["1080p60"];
    if (localStream && preset.captureFps) {
      const vTrack = localStream.getVideoTracks()[0];
      if (vTrack && typeof vTrack.applyConstraints === "function") {
        try {
          await vTrack.applyConstraints({ frameRate: preset.captureFps });
        } catch { /* ignore constraint errors if browser can't re-constrain */ }
      }
    }
    if (conns.size) {
      log(t("log.qualityChanged", { label: presetLabel() }));
      await applyQualityToAllSenders();
    }
  });
  $("copyBtn").addEventListener("click", async () => {
    const btn = $("copyBtn");
    try {
      await navigator.clipboard.writeText($("roomUrl").value);
      log(t("log.linkCopied"));
      const oldHtml = btn.innerHTML;
      btn.innerHTML = `<svg class="btn-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/></svg><span>${t("app.copied")}</span>`;
      btn.classList.add("copied");
      setTimeout(() => {
        btn.innerHTML = oldHtml;
        btn.classList.remove("copied");
      }, 2000);
    } catch {
      $("roomUrl").select();
      log(t("log.clipboardUnavailable"), "warn");
    }
  });

  const roomLink = () => $("roomUrl").value;

  const shareBtn = $("shareBtn");
  if (shareBtn && typeof navigator.share === "function") {
    shareBtn.hidden = false;
    shareBtn.addEventListener("click", async () => {
      try {
        await navigator.share({ title: "Golive", text: t("share.text"), url: roomLink() });
        log(t("log.linkShared"));
      } catch { /* dismissed or unsupported */ }
    });
  }

  const qrModal = $("qrModal");
  if (qrModal && $("qrBtn")) {
    const closeQr = () => {
      qrModal.hidden = true;
      $("qrBox").innerHTML = "";
    };
    $("qrBtn").addEventListener("click", () => {
      try {
        $("qrBox").innerHTML = (typeof QR !== "undefined")
          ? QR.svg(roomLink(), { ecc: "M", margin: 2, label: t("qr.title") })
          : "";
        if (!$("qrBox").innerHTML) throw new Error("no QR");
      } catch {
        log(t("log.qrFailed"), "warn");
        return;
      }
      qrModal.hidden = false;
      $("qrCloseBtn").focus();
    });
    $("qrCloseBtn").addEventListener("click", closeQr);
    qrModal.addEventListener("click", (e) => {
      if (e.target === qrModal) closeQr();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !qrModal.hidden) closeQr();
    });
    $("qrCopyBtn").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(roomLink());
        log(t("log.linkCopied"));
      } catch { /* clipboard unavailable */ }
    });
  }

  // Viewers keep the Log collapsed behind a toggle; the host leaves it open.
  const logToggle = $("logToggle");
  if (logToggle && ROLE !== "streamer") {
    const logEl = $("log");
    const label = logToggle.querySelector("span");
    const setOpen = (open) => {
      logEl.hidden = !open;
      logToggle.setAttribute("aria-expanded", String(open));
      if (label) label.textContent = t(open ? "log.hide" : "log.show");
    };
    logToggle.hidden = false;
    setOpen(false);
    logToggle.addEventListener("click", () => setOpen($("log").hidden));
  }

  const clearBtn = $("clearLogBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      $("log").innerHTML = "";
    });
  }

  const unmuteBtn = $("unmuteBtn");
  if (unmuteBtn) {
    unmuteBtn.addEventListener("click", () => {
      $("video").muted = false;
      const hint = $("audioHint");
      if (hint) hint.hidden = true;
    });
  }
  $("video").addEventListener("volumechange", () => {
    const video = $("video");
    if (video.volume !== audioState.volume || video.muted !== audioState.muted) {
      audioState = { volume: video.volume, muted: video.muted };
      saveAudioPrefs();
    }
    if (!video.muted) {
      const hint = $("audioHint");
      if (hint) hint.hidden = true;
    } else {
      checkAudioHint();
    }
  });

  if (ROLE === "streamer") {
    setVideoActive(false);
    $("startBtn").addEventListener("click", startSharing);
    $("stopBtn").addEventListener("click", stopSharing);

    // Remember the last room ID so the streamer keeps the same link.
    let savedRoom = "";
    try { savedRoom = localStorage.getItem(ROOM_STORAGE_KEY) || ""; } catch { /* storage unavailable */ }
    $("roomId").value = savedRoom;
    $("randomRoomBtn").addEventListener("click", () => {
      $("roomId").value = randomRoomId();
      clearAlert();
    });

    const qsel = $("quality");
    for (const [key, p] of Object.entries(QUALITY_PRESETS)) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = t(p.shortKey);
      opt.title = t(p.labelKey);
      qsel.appendChild(opt);
    }
    const prefs = loadPrefs();
    qsel.value = QUALITY_PRESETS[prefs.quality] ? prefs.quality : "1080p60";
    if (typeof prefs.preferAv1 === "boolean") $("preferAv1").checked = prefs.preferAv1;
    if (typeof prefs.shareAudio === "boolean") $("shareAudio").checked = prefs.shareAudio;
    qsel.addEventListener("change", () => savePrefs({ quality: qsel.value }));
    $("preferAv1").addEventListener("change", () => savePrefs({ preferAv1: $("preferAv1").checked }));
    $("shareAudio").addEventListener("change", () => savePrefs({ shareAudio: $("shareAudio").checked }));
    setField("dQuality", presetLabel());
    $("dViewersLabel").hidden = false;
    $("dViewers").hidden = false;
    $("dPeerLabel").hidden = false;
    $("dPeer").hidden = false;
    $("dQualityLabel").hidden = false;
    $("dQuality").hidden = false;
    updatePeerSelect();
  } else {
    document.querySelectorAll(".streamer-only").forEach((el) => { el.hidden = true; });
    $("startBtn").hidden = true;
    $("stopBtn").hidden = true;
    const pref = $("preferAv1");
    if (pref) {
      const wrap = pref.closest(".check-pill, label");
      if (wrap) wrap.hidden = true;
    }
    $("dViewersLabel").hidden = true;
    $("dViewers").hidden = true;
    $("dPeerLabel").hidden = true;
    $("dPeer").hidden = true;
    $("dQualityLabel").hidden = true;
    $("dQuality").hidden = true;
    setVideoActive(false, true);
    joinRoom();
  }
  window.addEventListener("beforeunload", () => { stopReconnecting(); if (ws) ws.close(); });
}

init();
