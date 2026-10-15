// Golive signaling: a Cloudflare Worker that routes WebSocket connections to a
// Durable Object per room. Each Room DO holds one streamer plus up to
// MAX_VIEWERS viewers and relays SDP/ICE between them (a mesh: the streamer
// keeps one RTCPeerConnection per viewer). No media passes through Cloudflare;
// WebRTC stays peer-to-peer.
//
// Rooms are ephemeral and exist only while participants are connected, but the
// DO survives with zero WebSockets, so a viewer that opens a link early just
// waits in the room until the streamer (re)appears.

const ROOM_ID_RE = /^[a-z0-9][a-z0-9_-]{2,23}$/;
const MAX_MSG_BYTES = 64 * 1024;
const NO_STORE = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function text(body, status) {
  return new Response(body, {
    status,
    headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" },
  });
}

// Link-preview image (1200x630). Served as a static asset.
const OG_IMAGE = "/og.png";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Open Graph metadata per route. Crawlers (WhatsApp, Discord, ...) don't run
// JS, so the shell's meta tags are filled in here, server-side. Defaults to
// Portuguese, matching the app's default locale.
function ogFor(kind, room) {
  if (kind === "home") {
    return {
      title: "Golive",
      description: "Assista ou compartilhe a tela por um link privado. WebRTC direto entre navegadores, sem conta e sem servidor no meio.",
    };
  }
  if (kind === "host") {
    return {
      title: "Golive \u2014 compartilhar a tela",
      description: "Compartilhe sua tela, uma janela ou aba e envie o link da sala para os amigos.",
    };
  }
  return {
    title: `Golive \u2014 assistir \u00e0 sala ${room}`,
    description: `Assista \u00e0 transmiss\u00e3o de tela da sala ${room}.`,
  };
}

// Serve an HTML shell (the app or the landing page) without caching so a
// deploy takes effect on the next load, filling in the link-preview meta tags.
async function serveShell(env, url, assetPath, og) {
  const res = await env.ASSETS.fetch(new Request(new URL(assetPath, url.origin)));
  let html = await res.text();
  html = html
    .replaceAll("__OG_TITLE__", escapeHtml(og.title))
    .replaceAll("__OG_DESC__", escapeHtml(og.description))
    .replaceAll("__OG_URL__", escapeHtml(url.origin + url.pathname))
    .replaceAll("__OG_IMAGE__", escapeHtml(url.origin + OG_IMAGE));
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(NO_STORE)) headers.set(k, v);
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(html, { status: res.status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const lower = path.toLowerCase();

    // Signaling: relay to the Durable Object that owns this room.
    if (path === "/ws") {
      const room = (url.searchParams.get("room") || "").toLowerCase();
      if (!ROOM_ID_RE.test(room)) return text("Invalid room ID\n", 400);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
      return stub.fetch(request);
    }

    // Landing page: pick Host or Watch.
    if (path === "/") return serveShell(env, url, "/home.html", ogFor("home"));

    // Host console. The client decides its role from the path; "/host" has no
    // room segment, so it is treated as a streamer.
    if (lower === "/host") return serveShell(env, url, "/index.html", ogFor("host"));

    // Canonical viewer URL. Room IDs are lowercase; redirect a mixed-case path
    // to its canonical form.
    if (lower.startsWith("/watch/")) {
      const watch = lower.match(/^\/watch\/([a-z0-9][a-z0-9_-]{2,23})$/);
      if (!watch) return text("Not found\n", 404);
      if (path !== lower) {
        const target = new URL(`/watch/${watch[1]}`, url.origin);
        target.search = url.search;
        return Response.redirect(target.toString(), 302);
      }
      return serveShell(env, url, "/index.html", ogFor("watch", watch[1]));
    }

    // Short alias: a bare room ID (/test) redirects to the canonical
    // /watch/<id>, so typing a room code in the address bar just works.
    const alias = lower.match(/^\/([a-z0-9][a-z0-9_-]{2,23})$/);
    if (alias) {
      const target = new URL(`/watch/${alias[1]}`, url.origin);
      target.search = url.search;
      return Response.redirect(target.toString(), 302);
    }

    // Everything else (app.js, style.css, favicon.png, ...) is a static asset.
    return env.ASSETS.fetch(request);
  },
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  get maxViewers() {
    const n = parseInt(this.env.MAX_VIEWERS ?? "8", 10);
    return Number.isFinite(n) && n > 0 ? n : 8;
  }

  attachment(ws) {
    return ws.deserializeAttachment() || null;
  }

  roleOf(ws) {
    const a = this.attachment(ws);
    return a ? a.role : null;
  }

  // Accepted sockets with a role, optionally excluding one socket.
  socketsWithRole(role, exclude) {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws !== exclude && this.roleOf(ws) === role);
  }

  send(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* socket already gone */
    }
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return text("Expected a WebSocket upgrade\n", 426);
    }

    const url = new URL(request.url);
    const role = url.searchParams.get("role") === "streamer" ? "streamer" : "viewer";
    const room = (url.searchParams.get("room") || "").toLowerCase();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept just long enough to deliver a structured error, then close.
    const reject = (code, message, reason) => {
      server.serializeAttachment({ role: "rejected", peerId: null });
      this.ctx.acceptWebSocket(server, ["rejected"]);
      this.send(server, { type: "error", code, message });
      server.close(1013, reason);
      return new Response(null, { status: 101, webSocket: client });
    };

    if (role === "streamer") {
      if (this.socketsWithRole("streamer").length > 0) {
        return reject("room-in-use", "That room ID is already live. Pick another one.", "room-in-use");
      }
    } else if (this.socketsWithRole("viewer").length >= this.maxViewers) {
      return reject("room-full", `Room is full (${this.maxViewers} viewers).`, "room-full");
    }

    // Registration happens on connect: no create/join handshake.
    const peerId = role === "viewer" ? newPeerId() : null;
    server.serializeAttachment({ role, peerId });
    this.ctx.acceptWebSocket(server, [role]);

    if (role === "streamer") {
      this.send(server, { type: "created", room });
      // Offer to any viewers already waiting in the room.
      for (const viewer of this.socketsWithRole("viewer", server)) {
        const pid = this.attachment(viewer)?.peerId;
        if (pid) this.send(server, { type: "peer-joined", peerId: pid });
      }
    } else {
      this.send(server, { type: "joined", room, peerId });
      const streamer = this.socketsWithRole("streamer", server)[0];
      if (streamer) this.send(streamer, { type: "peer-joined", peerId });
      else this.send(server, { type: "streamer-waiting" });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const role = this.roleOf(ws);
    if (role !== "streamer" && role !== "viewer") return;
    if (typeof message !== "string" || message.length > MAX_MSG_BYTES) return;

    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return this.send(ws, { type: "error", code: "bad-json", message: "Invalid JSON" });
    }
    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "offer":
        // Only the streamer sends offers, addressed to one viewer.
        if (role !== "streamer") return;
        this.relayToViewer(msg.to, { type: "offer", payload: msg.payload });
        break;
      case "answer":
        // Only viewers send answers; tag them with the sender's peer id.
        if (role !== "viewer") return;
        this.relayToStreamer({ type: "answer", from: this.attachment(ws)?.peerId, payload: msg.payload });
        break;
      case "candidate":
        // ICE candidates flow both ways; the streamer's copy carries "to".
        if (role === "streamer") this.relayToViewer(msg.to, { type: "candidate", payload: msg.payload });
        else this.relayToStreamer({ type: "candidate", from: this.attachment(ws)?.peerId, payload: msg.payload });
        break;
      default:
        this.send(ws, { type: "error", code: "unknown-type", message: "Unknown message type" });
    }
  }

  relayToViewer(peerId, obj) {
    if (!peerId) return;
    const viewer = this.socketsWithRole("viewer").find((ws) => this.attachment(ws)?.peerId === peerId);
    if (viewer) this.send(viewer, obj);
  }

  relayToStreamer(obj) {
    const streamer = this.socketsWithRole("streamer")[0];
    if (streamer) this.send(streamer, obj);
  }

  webSocketClose(ws) {
    this.announceGone(ws);
  }

  webSocketError(ws) {
    this.announceGone(ws);
  }

  // Tell the surviving side that a peer vanished. Guarded so close+error for
  // the same socket do not notify twice.
  announceGone(ws) {
    const a = this.attachment(ws);
    if (!a || a.gone) return;
    a.gone = true;
    try {
      ws.serializeAttachment(a);
    } catch {
      /* socket already closed */
    }

    if (a.role === "streamer") {
      for (const viewer of this.socketsWithRole("viewer", ws)) this.send(viewer, { type: "streamer-left" });
    } else if (a.role === "viewer") {
      const streamer = this.socketsWithRole("streamer", ws)[0];
      if (streamer) this.send(streamer, { type: "peer-left", peerId: a.peerId });
    }
  }
}

function newPeerId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}
