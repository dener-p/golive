// Minimal in-memory signaling server for the WebRTC AV1 + IPv6 test.
// Serves the static frontend and relays SDP / ICE messages between one
// streamer and one viewer per room. No media passes through this server.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "::"; // dual-stack: listen on IPv6 and IPv4
const MAX_VIEWERS = 1; // first milestone: one streamer, one viewer
const MAX_MSG_BYTES = 64 * 1024;
const MAX_ROOMS = 1000;
const ROOM_ID_RE = /^[a-z0-9]{8}$/;
const PUBLIC_DIR = path.join(__dirname, "public");

const STATIC_FILES = {
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};

// roomId -> { streamer: WebSocket, viewers: Set<WebSocket> }
const rooms = new Map();

function newRoomId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let attempt = 0; attempt < 10; attempt++) {
    const bytes = crypto.randomBytes(8);
    let id = "";
    for (const b of bytes) id += alphabet[b % alphabet.length];
    if (!rooms.has(id)) return id;
  }
  return null;
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || "/").split("?")[0];
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };

  let file, type;
  if (urlPath === "/" || /^\/watch\/[a-z0-9]{8}$/.test(urlPath)) {
    file = "index.html";
    type = "text/html; charset=utf-8";
  } else if (STATIC_FILES[urlPath]) {
    [file, type] = STATIC_FILES[urlPath];
  } else if (urlPath === "/healthz") {
    res.writeHead(200, { ...headers, "Content-Type": "text/plain" });
    res.end("ok\n");
    return;
  } else {
    res.writeHead(404, { ...headers, "Content-Type": "text/plain" });
    res.end("Not found\n");
    return;
  }

  fs.readFile(path.join(PUBLIC_DIR, file), (err, data) => {
    if (err) {
      res.writeHead(500, { ...headers, "Content-Type": "text/plain" });
      res.end("Server error\n");
      return;
    }
    res.writeHead(200, { ...headers, "Content-Type": type });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: MAX_MSG_BYTES });

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function otherPeer(ws) {
  const room = rooms.get(ws.roomId);
  if (!room) return null;
  if (ws.role === "streamer") return [...room.viewers][0] || null;
  return room.streamer;
}

function leave(ws) {
  const room = rooms.get(ws.roomId);
  if (!room) return;
  if (ws.role === "streamer" && room.streamer === ws) {
    for (const v of room.viewers) {
      send(v, { type: "streamer-left" });
      v.roomId = null;
    }
    rooms.delete(ws.roomId);
  } else if (ws.role === "viewer" && room.viewers.delete(ws)) {
    send(room.streamer, { type: "peer-left" });
  }
  ws.roomId = null;
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.roomId = null;
  ws.role = null;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return send(ws, { type: "error", code: "bad-json", message: "Invalid JSON" });
    }
    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "create": {
        if (ws.roomId) return send(ws, { type: "error", code: "already-in-room", message: "Already in a room" });
        if (rooms.size >= MAX_ROOMS) return send(ws, { type: "error", code: "server-full", message: "Too many rooms" });
        const id = newRoomId();
        if (!id) return send(ws, { type: "error", code: "server-error", message: "Could not allocate room" });
        rooms.set(id, { streamer: ws, viewers: new Set() });
        ws.roomId = id;
        ws.role = "streamer";
        send(ws, { type: "created", room: id });
        break;
      }
      case "join": {
        if (ws.roomId) return send(ws, { type: "error", code: "already-in-room", message: "Already in a room" });
        if (typeof msg.room !== "string" || !ROOM_ID_RE.test(msg.room)) {
          return send(ws, { type: "error", code: "bad-room", message: "Invalid room ID" });
        }
        const room = rooms.get(msg.room);
        if (!room) return send(ws, { type: "error", code: "room-not-found", message: "Room not found (the streamer may have stopped sharing)" });
        if (room.viewers.size >= MAX_VIEWERS) return send(ws, { type: "error", code: "room-full", message: "Room already has a viewer" });
        room.viewers.add(ws);
        ws.roomId = msg.room;
        ws.role = "viewer";
        send(ws, { type: "joined", room: msg.room });
        send(room.streamer, { type: "peer-joined" });
        break;
      }
      case "offer":
      case "answer":
      case "candidate": {
        if (!ws.roomId) return;
        // Only the streamer sends offers; only the viewer sends answers.
        if (msg.type === "offer" && ws.role !== "streamer") return;
        if (msg.type === "answer" && ws.role !== "viewer") return;
        const peer = otherPeer(ws);
        if (peer) send(peer, { type: msg.type, payload: msg.payload });
        break;
      }
      default:
        send(ws, { type: "error", code: "unknown-type", message: "Unknown message type" });
    }
  });

  ws.on("close", () => leave(ws));
  ws.on("error", () => leave(ws));
});

// Drop dead connections so rooms don't linger.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on("close", () => clearInterval(heartbeat));

// The WebSocketServer re-emits http server errors; handling them below, so
// give it a no-op listener to avoid an unhandled 'error' crash.
wss.on("error", () => {});

function listen(host, allowFallback) {
  const onError = (err) => {
    server.removeListener("listening", onListening);
    if (allowFallback && (err.code === "EAFNOSUPPORT" || err.code === "EADDRNOTAVAIL")) {
      console.warn(`Cannot bind ${host} (${err.code}); this machine has no IPv6. Falling back to 0.0.0.0 (IPv4 only).`);
      listen("0.0.0.0", false);
    } else {
      console.error(`Failed to listen on ${host}:${PORT}: ${err.message}`);
      process.exit(1);
    }
  };
  const onListening = () => {
    server.removeListener("error", onError);
    console.log(`Signaling + static server on http://localhost:${PORT} (host ${host})`);
    console.log("Screen capture needs a secure context: use localhost or serve over HTTPS (wss:// for signaling).");
  };
  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(PORT, host);
}

// Default "::" is dual-stack (IPv6 + IPv4); fall back to IPv4 if unsupported.
listen(HOST, !process.env.HOST);
