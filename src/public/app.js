// WebRTC screen share with AV1 preference and connectivity diagnostics.
// Streamer: /          Viewer: /watch/<roomId>
"use strict";

const $ = (id) => document.getElementById(id);

// STUN only. No TURN on purpose: if no direct path exists, ICE fails visibly.
const RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

const match = location.pathname.match(/^\/watch\/([a-z0-9]{8})$/);
const roomFromUrl = match ? match[1] : null;
const ROLE = roomFromUrl ? "viewer" : "streamer";

let ws = null;
let pc = null;
let localStream = null;
let roomId = roomFromUrl;
let pendingCandidates = [];
let statsTimer = null;
let prevBytes = null;
let warnedCodec = false;
let candCounts = null;

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

function resetStatsFields() {
  ["dPair", "dPath", "dRtt", "dCodec", "dRes", "dFps", "dBitrate", "dImpl"].forEach((id) => setField(id, "\u2013"));
  prevBytes = null;
  warnedCodec = false;
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

// ---------- Signaling ----------

function wsUrl() {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

function openSignaling() {
  return new Promise((resolve, reject) => {
    setField("dSignaling", "connecting\u2026");
    ws = new WebSocket(wsUrl());
    ws.onopen = () => {
      setField("dSignaling", "connected", "ok");
      resolve();
    };
    ws.onerror = () => {
      setField("dSignaling", "error", "bad");
      reject(new Error("Could not connect to signaling server"));
    };
    ws.onclose = () => {
      setField("dSignaling", "closed", "warn");
      ws = null;
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleSignal(msg).catch((e) => log(`Signal handling error: ${e.message}`, "bad"));
    };
  });
}

function signal(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

async function handleSignal(msg) {
  switch (msg.type) {
    case "created":
      roomId = msg.room;
      showRoomLink();
      log(`Room ${roomId} created. Waiting for a viewer\u2026`);
      break;
    case "joined":
      log(`Joined room ${msg.room}. Waiting for the streamer's offer\u2026`);
      break;
    case "peer-joined":
      log("Viewer joined; creating offer.");
      await startOffer();
      break;
    case "peer-left":
      log("Viewer left.", "warn");
      closePc();
      break;
    case "streamer-left":
      log("Streamer stopped sharing.", "warn");
      showAlert("The streamer stopped sharing or disconnected.", "warn");
      closePc();
      $("video").srcObject = null;
      break;
    case "offer":
      await handleOffer(msg.payload);
      break;
    case "answer":
      await handleAnswer(msg.payload);
      break;
    case "candidate":
      await handleRemoteCandidate(msg.payload);
      break;
    case "error":
      log(`Server: ${msg.message}`, "bad");
      showAlert(msg.message, "bad");
      break;
  }
}

// ---------- Peer connection ----------

function createPc() {
  closePc();
  clearAlert();
  resetStatsFields();
  candCounts = { local: {}, total: 0 };
  pendingCandidates = [];

  pc = new RTCPeerConnection(RTC_CONFIG);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      noteLocalCandidate(e.candidate);
      signal({ type: "candidate", payload: e.candidate.toJSON() });
    } else {
      log("ICE gathering complete.");
      signal({ type: "candidate", payload: null });
    }
  };
  pc.onicecandidateerror = (e) => {
    // Common for unreachable STUN over one address family; informational.
    log(`ICE candidate error ${e.errorCode || ""} ${e.errorText || ""}`.trim(), "warn");
  };
  pc.onicegatheringstatechange = () => log(`ICE gathering: ${pc.iceGatheringState}`);
  pc.oniceconnectionstatechange = onIceState;
  pc.onconnectionstatechange = () => {
    setField("dPc", pc.connectionState);
    log(`Peer connection state: ${pc.connectionState}`);
  };
  pc.ontrack = (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    $("video").srcObject = stream;
    $("video").play().catch(() => { });
    log("Remote video track received.");
  };

  startStats();
  return pc;
}

function onIceState() {
  const s = pc.iceConnectionState;
  const cls = s === "connected" || s === "completed" ? "ok" : s === "failed" ? "bad" : s === "disconnected" ? "warn" : "";
  setField("dIce", s, cls);
  log(`ICE connection state: ${s}`, cls);
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

function closePc() {
  stopStats();
  if (pc) {
    pc.onicecandidate = pc.oniceconnectionstatechange = pc.onconnectionstatechange = pc.ontrack = null;
    pc.close();
    pc = null;
  }
  pendingCandidates = [];
  setField("dIce", "new");
  setField("dPc", "\u2013");
}

// Log candidate type/family without showing or storing the address.
function noteLocalCandidate(c) {
  const parts = (c.candidate || "").split(" ");
  const addr = parts[4] || "";
  const type = parts[7] || "?";
  let family = "unknown";
  if (addr.endsWith(".local")) family = "mDNS";
  else if (addr.includes(":")) family = "IPv6";
  else if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) family = "IPv4";
  const key = `${family} ${type}`;
  candCounts.local[key] = (candCounts.local[key] || 0) + 1;
  candCounts.total++;
  setField(
    "dCands",
    Object.entries(candCounts.local).map(([k, v]) => `${k} \u00d7${v}`).join(", ")
  );
  log(`Local candidate: ${family} ${type} (${parts[2] || "?"})`);
}

// Streamer: create and send the offer.
async function startOffer() {
  createPc();
  const track = localStream.getVideoTracks()[0];
  const tr = pc.addTransceiver(track, { direction: "sendonly", streams: [localStream] });
  applyCodecPreferences(tr, "sender");
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  signal({ type: "offer", payload: pc.localDescription.toJSON() });
  log("Offer sent.");
}

// Viewer: answer the streamer's offer.
async function handleOffer(offer) {
  createPc();
  await pc.setRemoteDescription(offer);
  await flushCandidates();
  const tr = pc.getTransceivers().find((t) => t.receiver && t.receiver.track && t.receiver.track.kind === "video");
  applyCodecPreferences(tr, "receiver");
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  signal({ type: "answer", payload: pc.localDescription.toJSON() });
  log("Answer sent.");
}

async function handleAnswer(answer) {
  if (!pc) return;
  await pc.setRemoteDescription(answer);
  await flushCandidates();
  log("Answer received.");
}

async function handleRemoteCandidate(cand) {
  if (!pc) return;
  if (!pc.remoteDescription) {
    pendingCandidates.push(cand);
    return;
  }
  await addCandidate(cand);
}

async function addCandidate(cand) {
  try {
    await pc.addIceCandidate(cand || undefined);
  } catch (e) {
    log(`addIceCandidate failed: ${e.message}`, "warn");
  }
}

async function flushCandidates() {
  const queued = pendingCandidates;
  pendingCandidates = [];
  for (const c of queued) await addCandidate(c);
}

// ---------- Stats ----------

function startStats() {
  stopStats();
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
  if (!pc) return;
  let stats;
  try { stats = await pc.getStats(); } catch { return; }

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
    setField("dPair", `local: ${lf} ${lt} \u00b7 remote: ${rf} ${rt}${proto ? " \u00b7 " + proto : ""}`);

    const relayed = lt === "relay" || rt === "relay";
    if (relayed) {
      setField("dPath", "RELAYED (TURN)", "bad");
    } else {
      let fam = "";
      if (lf === "IPv6" && rf === "IPv6") fam = " over IPv6";
      else if (lf === "IPv4" && rf === "IPv4") fam = " over IPv4";
      else if (lf === "unknown" || rf === "unknown" || lf === "mDNS" || rf === "mDNS") fam = " (address family hidden by browser)";
      setField("dPath", `direct${fam}`, lf === "IPv6" && rf === "IPv6" ? "ok" : "");
    }
    if (typeof pair.currentRoundTripTime === "number") {
      setField("dRtt", `${Math.round(pair.currentRoundTripTime * 1000)} ms`);
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
  if (!rtp) return;

  const codec = rtp.codecId ? byId.get(rtp.codecId) : null;
  if (codec) {
    const mime = codec.mimeType;
    const isAv1 = mime.toLowerCase() === "video/av1";
    setField("dCodec", mime, isAv1 ? "ok" : "warn");
    if (!isAv1 && $("preferAv1").checked && !warnedCodec) {
      warnedCodec = true;
      showAlert(`AV1 was preferred but the negotiated codec is ${mime}. Check AV1 support on both peers.`, "warn");
      log(`Negotiated codec is ${mime}, not AV1.`, "warn");
    }
    if (isAv1 && !warnedCodec) {
      warnedCodec = true;
      log("Negotiated codec: video/AV1", "ok");
    }
  }

  if (rtp.frameWidth && rtp.frameHeight) setField("dRes", `${rtp.frameWidth}\u00d7${rtp.frameHeight}`);
  if (typeof rtp.framesPerSecond === "number") setField("dFps", `${Math.round(rtp.framesPerSecond)} fps`);

  const impl = ROLE === "streamer" ? rtp.encoderImplementation : rtp.decoderImplementation;
  if (impl) setField("dImpl", `${impl}${rtp.powerEfficientEncoder || rtp.powerEfficientDecoder ? " (power efficient)" : ""}`);

  const bytes = ROLE === "streamer" ? rtp.bytesSent : rtp.bytesReceived;
  if (typeof bytes === "number") {
    if (prevBytes && rtp.timestamp > prevBytes.ts) {
      const bps = ((bytes - prevBytes.bytes) * 8) / ((rtp.timestamp - prevBytes.ts) / 1000);
      setField("dBitrate", `${(bps / 1e6).toFixed(2)} Mbps`);
    }
    prevBytes = { bytes, ts: rtp.timestamp };
  }
}

// ---------- Streamer / viewer flows ----------

function showRoomLink() {
  const url = `${location.origin}/watch/${roomId}`;
  $("roomUrl").value = url;
  $("linkRow").hidden = false;
}

async function startSharing() {
  $("startBtn").disabled = true;
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
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
  const video = $("video");
  video.srcObject = localStream;
  video.muted = true;
  localStream.getVideoTracks()[0].addEventListener("ended", () => {
    log("Screen capture ended by the browser.", "warn");
    stopSharing();
  });
  $("stopBtn").disabled = false;
  $("preferAv1").disabled = true;
  try {
    await openSignaling();
  } catch (e) {
    log(e.message, "bad");
    showAlert(e.message, "bad");
    stopSharing();
    return;
  }
  signal({ type: "create" });
}

function stopSharing() {
  closePc();
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  $("video").srcObject = null;
  $("linkRow").hidden = true;
  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;
  $("preferAv1").disabled = false;
  setField("dSignaling", "idle");
  resetStatsFields();
  log("Sharing stopped.");
}

async function joinRoom() {
  try {
    await openSignaling();
  } catch (e) {
    log(e.message, "bad");
    showAlert(e.message, "bad");
    return;
  }
  signal({ type: "join", room: roomFromUrl });
}

// ---------- Init ----------

function init() {
  $("role").textContent = ROLE === "streamer" ? "Streamer" : `Viewer \u00b7 room ${roomFromUrl}`;
  reportSupport();
  $("copyBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("roomUrl").value);
      log("Link copied.");
    } catch {
      $("roomUrl").select();
      log("Clipboard unavailable; link selected \u2014 copy it manually.", "warn");
    }
  });

  if (ROLE === "streamer") {
    $("startBtn").addEventListener("click", startSharing);
    $("stopBtn").addEventListener("click", stopSharing);
  } else {
    $("startBtn").hidden = true;
    $("stopBtn").hidden = true;
    joinRoom();
  }
  window.addEventListener("beforeunload", () => { if (ws) ws.close(); });
}

init();
