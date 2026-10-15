// Golive: browser screen sharing over WebRTC, signaled by Cloudflare Workers.
// Streamer: /          Viewer: /watch/<roomId>
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
        pht.textContent = isWaiting ? "Waiting for the streamer\u2026" : "Disconnected";
      } else {
        pht.textContent = "Click \u201cStart sharing\u201d to begin screen capture";
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
  return ROLE === "viewer" ? "streamer" : `viewer ${peerId}`;
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
    const text = `send: ${send ? "yes" : "no"}, receive: ${recv ? "yes" : "no"}`;
    const relevant = ROLE === "streamer" ? send : recv;
    setField("dSupport", text, relevant ? "ok" : "warn");
    if (!relevant) {
      log(`AV1 is not available for ${ROLE === "streamer" ? "sending" : "receiving"} in this browser; a fallback codec will be used.`, "warn");
    }
  } catch (e) {
    setField("dSupport", "unknown (getCapabilities unavailable)", "warn");
  }
}

// Put AV1 first, keep every other codec (including RTX/RED/FEC) as fallbacks.
function applyCodecPreferences(transceiver, kind) {
  if (!$("preferAv1").checked) {
    log("AV1 preference disabled: using the browser's default codec order.");
    return;
  }
  if (!transceiver || typeof transceiver.setCodecPreferences !== "function") {
    log("setCodecPreferences() is not supported by this browser.", "warn");
    return;
  }
  const caps = (kind === "sender" ? RTCRtpSender : RTCRtpReceiver).getCapabilities("video");
  if (!hasAv1(caps)) {
    log("AV1 not reported as supported; leaving default codec order.", "warn");
    return;
  }
  const isAv1 = (c) => c.mimeType.toLowerCase() === "video/av1";
  const prefs = [...caps.codecs.filter(isAv1), ...caps.codecs.filter((c) => !isAv1(c))];
  try {
    transceiver.setCodecPreferences(prefs);
    log(`Codec preference set: AV1 first, ${prefs.length - caps.codecs.filter(isAv1).length} fallback entries kept.`);
  } catch (e) {
    log(`setCodecPreferences failed: ${e.message}`, "warn");
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
    label: "4K \u00b7 60 fps \u00b7 up to 40 Mbps",
    short: "4K / 60 fps",
    maxBitrate: 40_000_000,
    maxFramerate: 60,
    captureFps: 60,
    targetHeight: 2160,
    scaleResolutionDownBy: 1,
    degradationPreference: "maintain-resolution",
  },
  "4k30": {
    label: "4K \u00b7 30 fps \u00b7 up to 25 Mbps",
    short: "4K / 30 fps",
    maxBitrate: 25_000_000,
    maxFramerate: 30,
    captureFps: 30,
    targetHeight: 2160,
    scaleResolutionDownBy: 1,
    degradationPreference: "maintain-resolution",
  },
  "1440p60": {
    label: "1440p \u00b7 60 fps \u00b7 up to 20 Mbps",
    short: "1440p / 60 fps",
    maxBitrate: 20_000_000,
    maxFramerate: 60,
    captureFps: 60,
    targetHeight: 1440,
    scaleResolutionDownBy: 1,
    degradationPreference: "maintain-resolution",
  },
  "1080p60": {
    label: "1080p \u00b7 60 fps \u00b7 up to 12 Mbps",
    short: "1080p / 60 fps",
    maxBitrate: 12_000_000,
    maxFramerate: 60,
    captureFps: 60,
    targetHeight: 1080,
    scaleResolutionDownBy: 1,
    degradationPreference: "maintain-resolution",
  },
  "1080p30": {
    label: "1080p \u00b7 30 fps \u00b7 up to 8 Mbps",
    short: "1080p / 30 fps",
    maxBitrate: 8_000_000,
    maxFramerate: 30,
    captureFps: 30,
    targetHeight: 1080,
    scaleResolutionDownBy: 1,
    degradationPreference: "maintain-resolution",
  },
  "720p30": {
    label: "720p \u00b7 30 fps \u00b7 up to 4 Mbps",
    short: "720p / 30 fps",
    maxBitrate: 4_000_000,
    maxFramerate: 30,
    captureFps: 30,
    targetHeight: 720,
    scaleResolutionDownBy: 1.5,
    degradationPreference: "balanced",
  },
  low: {
    label: "Data saver \u00b7 24 fps \u00b7 up to 1 Mbps",
    short: "Data saver (1 Mbps)",
    maxBitrate: 1_000_000,
    maxFramerate: 24,
    captureFps: 24,
    targetHeight: 540,
    scaleResolutionDownBy: 2,
    degradationPreference: "maintain-framerate",
  },
  auto: {
    label: "Auto (browser default)",
    short: "Auto (default)",
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
  return QUALITY_PRESETS[key] ? QUALITY_PRESETS[key].label : QUALITY_PRESETS["1080p60"].label;
}

// Encoded resolution follows the preset's target height instead of a fixed
// factor, so a large capture is scaled to the resolution its bitrate budget
// was chosen for (and never upscaled).
function scaleForPreset(preset, sender) {
  const track = sender.track;
  const height = track && typeof track.getSettings === "function" ? track.getSettings().height : 0;
  if (preset.targetHeight && height) return Math.round(Math.max(1, height / preset.targetHeight) * 100) / 100;
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
    log(`Could not apply quality preset \u201c${preset.label}\u201d: ${e.message}`, "warn");
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
    setField("dSignaling", "connecting\u2026");
    const sock = new WebSocket(wsUrl(room, role));
    ws = sock;
    let settled = false;
    sock.onopen = () => {
      reconnectDelay = 1000;
      setField("dSignaling", "connected", "ok");
      if (!settled) { settled = true; resolve(); }
    };
    sock.onerror = () => {
      if (ws !== sock) return;
      setField("dSignaling", "error", "bad");
      if (!settled) { settled = true; reject(new Error("Could not reach the signaling server")); }
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      setField("dSignaling", "closed", "warn");
      if (isLive()) scheduleReconnect();
    };
    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleSignal(msg).catch((e) => log(`Signal handling error: ${e.message}`, "bad"));
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
    log(`Reconnecting to room \u201c${signalingRoom}\u201d\u2026`, "warn");
    try {
      await connectSignaling(signalingRoom, signalingRole);
      log("Signaling reconnected.");
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
      log(`Room \u201c${roomId}\u201d is live. Share the link to invite viewers.`);
      break;
    case "joined":
      closeAllConns(); // fresh peer id after a reconnect
      log(`Joined room ${msg.room}.`);
      showWaiting();
      break;
    case "streamer-waiting":
      showWaiting();
      break;
    case "peer-joined":
      log(`Viewer ${msg.peerId} joined; creating offer.`);
      clearAlert();
      await startOffer(msg.peerId);
      break;
    case "peer-left":
      log(`Viewer ${msg.peerId} left.`, "warn");
      closeConn(msg.peerId);
      break;
    case "streamer-left":
      log("Streamer stopped sharing. Waiting for it to come back\u2026", "warn");
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
    case "error":
      log(`Server: ${msg.message}`, "bad");
      showAlert(msg.message, "bad");
      if (msg.code === "room-in-use" || msg.code === "room-full") {
        if (ROLE === "streamer" && localStream) stopSharing();
        else { stopReconnecting(); if (ws) ws.close(); }
      }
      break;
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
      log(`[${peerLabel(peerId)}] ICE gathering complete.`);
      signal(makeSignal("candidate", peerId, null));
    }
  };
  pc.onicecandidateerror = (e) => {
    // Common for unreachable STUN over one address family; informational.
    log(`[${peerLabel(peerId)}] ICE candidate error ${e.errorCode || ""} ${e.errorText || ""}`.trim(), "warn");
  };
  pc.onicegatheringstatechange = () => log(`[${peerLabel(peerId)}] ICE gathering: ${pc.iceGatheringState}`);
  pc.oniceconnectionstatechange = () => onIceState(peerId);
  pc.onconnectionstatechange = () => {
    log(`[${peerLabel(peerId)}] Peer connection state: ${pc.connectionState}`);
    if (peerId === focusedId) setField("dPc", pc.connectionState);
  };
  pc.ontrack = (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    const video = $("video");
    video.srcObject = stream;
    // Start muted so autoplay is allowed; the viewer unmutes with the
    // video controls' speaker icon or the unmute banner.
    video.muted = true;
    video.play().catch(() => { });
    setVideoActive(true);
    checkAudioHint();
    log(e.track.kind === "audio"
      ? "Remote audio track received. Use the unmute button or player controls to listen."
      : "Remote video track received.");
  };

  startStats();
  return conn;
}

function closeConn(peerId) {
  const conn = conns.get(peerId);
  if (!conn) return;
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
    opt.textContent = "(no viewers)";
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const peerId of conns.keys()) {
    const opt = document.createElement("option");
    opt.value = peerId;
    opt.textContent = `viewer ${peerId}`;
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
  log(`[${peerLabel(peerId)}] ICE connection state: ${s}`, iceClass(s));
  if (peerId !== focusedId) return;
  setField("dIce", s, iceClass(s));
  if (s === "failed") {
    showAlert(
      "ICE failed: no direct path between the peers. No TURN relay is configured, so media was not relayed. " +
      "Check firewalls/NAT, try different networks, or verify that both sides have working IPv6.",
      "bad"
    );
  } else if (s === "disconnected") {
    showAlert("ICE disconnected. It may recover; if not, the connection will move to failed.", "warn");
  } else if (s === "connected" || s === "completed") {
    clearAlert();
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
  log(`[${peerLabel(peerId)}] Local candidate: ${family} ${type} (${parts[2] || "?"})`);
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
  log(`Offer sent to ${peerLabel(peerId)}${audioTrack ? " (video + audio)" : " (video only)"}.`);
}

// Viewer: answer the streamer's offer.
async function handleOffer(offer) {
  const conn = createPc(VIEWER_KEY);
  await conn.pc.setRemoteDescription(offer);
  await flushCandidates(conn);
  const tr = conn.pc.getTransceivers().find((t) => t.receiver && t.receiver.track && t.receiver.track.kind === "video");
  applyCodecPreferences(tr, "receiver");
  const answer = await conn.pc.createAnswer();
  await conn.pc.setLocalDescription(answer);
  signal(makeSignal("answer", VIEWER_KEY, conn.pc.localDescription.toJSON()));
  log("Answer sent.");
}

async function handleAnswer(peerId, answer) {
  const conn = conns.get(peerId);
  if (!conn) return;
  await conn.pc.setRemoteDescription(answer);
  await flushCandidates(conn);
  log(`[${peerLabel(peerId)}] Answer received.`);
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
    log(`addIceCandidate failed: ${e.message}`, "warn");
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
    d.pair = `local: ${lf} ${lt} \u00b7 remote: ${rf} ${rt}${proto ? " \u00b7 " + proto : ""}`;

    const relayed = lt === "relay" || rt === "relay";
    if (relayed) {
      d.path = "RELAYED (TURN)";
      d.pathCls = "bad";
    } else {
      let fam = "";
      if (lf === "IPv6" && rf === "IPv6") fam = " over IPv6";
      else if (lf === "IPv4" && rf === "IPv4") fam = " over IPv4";
      else if (lf === "unknown" || rf === "unknown" || lf === "mDNS" || rf === "mDNS") fam = " (address family hidden by browser)";
      d.path = `direct${fam}`;
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
      log(`[${peerLabel(peerId)}] Negotiated codec is ${mime}, not AV1.`, "warn");
      if (peerId === focusedId) {
        showAlert(`AV1 was preferred but the negotiated codec is ${mime}. Check AV1 support on both peers.`, "warn");
      }
    }
    if (isAv1 && !conn.warnedCodec) {
      conn.warnedCodec = true;
      log(`[${peerLabel(peerId)}] Negotiated codec: video/AV1`, "ok");
    }
  }

  if (rtp.frameWidth && rtp.frameHeight) d.res = `${rtp.frameWidth}\u00d7${rtp.frameHeight}`;
  if (typeof rtp.framesPerSecond === "number") d.fps = `${Math.round(rtp.framesPerSecond)} fps`;

  const impl = ROLE === "streamer" ? rtp.encoderImplementation : rtp.decoderImplementation;
  if (impl) d.impl = `${impl}${rtp.powerEfficientEncoder || rtp.powerEfficientDecoder ? " (power efficient)" : ""}`;

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
    log(`Invalid room ID \u201c${id}\u201d. Use 3\u201324 chars: a\u2013z, 0\u20139, - or _, starting with a letter or number.`, "bad");
    showAlert("Room ID must be 3\u201324 characters (a\u2013z, 0\u20139, - or _), starting with a letter or number.", "bad");
    return null;
  }
  return id;
}

// Capture the display. Audio is best-effort and depends on the browser, OS and
// the source the user picks (tabs carry tab audio; screens can carry system
// audio; a single window usually has none unless the browser supports
// "windowAudio"). The systemAudio/windowAudio hints below let Chrome offer
// audio for window/screen shares too; other browsers ignore unknown options.
// A real denial/cancel is still surfaced as an error.
async function getDisplayStream(fps, wantAudio) {
  const video = { frameRate: fps };
  if (!wantAudio) return navigator.mediaDevices.getDisplayMedia({ video, audio: false });
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video,
      audio: true,
      systemAudio: "include", // offer system audio (screens) where possible
      windowAudio: "system",  // offer system audio when a window is picked
    });
  } catch (e) {
    if (e && (e.name === "TypeError" || e.name === "NotSupportedError")) {
      log(`This browser/source rejected audio capture (${e.name}); retrying with video only.`, "warn");
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
    log(`Screen capture failed: ${e.name}: ${e.message}`, "bad");
    showAlert(
      window.isSecureContext
        ? "Screen capture was cancelled or denied."
        : "Screen capture requires a secure context (HTTPS or localhost).",
      "bad"
    );
    $("startBtn").disabled = false;
    return;
  }
  const audioTracks = localStream.getAudioTracks();
  if (wantAudio && audioTracks.length === 0) {
    log("The selected source provided no audio track. Tabs and screens can share audio; a single window usually cannot \u2014 try a Chrome tab or the entire screen with \u201cShare system audio\u201d. Sharing video only.", "warn");
  } else if (audioTracks.length) {
    log(`Audio capture enabled at ${fps} fps video; the audio track will be sent to each viewer.`);
  } else {
    log(`Sharing video only at ${fps} fps.`);
  }
  log(`Quality preset: ${presetLabel()}.`);
  const videoTrack = localStream.getVideoTracks()[0];
  // Hint the encoder that this is screen content so it favours sharp detail
  // (text/UI) over motion. Browsers that don't support it ignore the hint.
  try { videoTrack.contentHint = "detail"; } catch { /* hint unsupported */ }
  const video = $("video");
  video.srcObject = localStream;
  video.muted = true;
  setVideoActive(true);
  videoTrack.addEventListener("ended", () => {
    log("Screen capture ended by the browser.", "warn");
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
  setField("dSignaling", "idle");
  resetStatsFields();
  log("Sharing stopped.");
}

async function joinRoom() {
  showWaiting();
  try {
    await connectSignaling(roomFromUrl, "viewer");
  } catch (e) {
    // The close handler schedules a retry; the room may just not exist yet.
    log(`${e.message}; retrying\u2026`, "warn");
  }
}

// ---------- Init ----------

function init() {
  $("role").textContent = ROLE === "streamer" ? "Streamer" : `Viewer \u00b7 room ${roomFromUrl}`;
  reportSupport();
  // Start muted so autoplay is permitted; viewers opt into audio via the
  // video controls' speaker icon.
  $("video").muted = true;
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
      log(`Quality preset set to \u201c${presetLabel()}\u201d.`);
      await applyQualityToAllSenders();
    }
  });
  $("copyBtn").addEventListener("click", async () => {
    const btn = $("copyBtn");
    try {
      await navigator.clipboard.writeText($("roomUrl").value);
      log("Link copied.");
      const oldHtml = btn.innerHTML;
      btn.innerHTML = `<svg class="btn-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/></svg><span>Copied!</span>`;
      btn.classList.add("copied");
      setTimeout(() => {
        btn.innerHTML = oldHtml;
        btn.classList.remove("copied");
      }, 2000);
    } catch {
      $("roomUrl").select();
      log("Clipboard unavailable; link selected \u2014 copy it manually.", "warn");
    }
  });

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
    if (!$("video").muted) {
      const hint = $("audioHint");
      if (hint) hint.hidden = true;
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
      opt.textContent = p.short || p.label;
      opt.title = p.label;
      qsel.appendChild(opt);
    }
    qsel.value = "1080p60";
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
