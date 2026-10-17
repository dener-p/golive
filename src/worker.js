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
// Optional room PIN: 4-8 digits. Anything else is treated as "no PIN".
const PIN_RE = /^\d{4,8}$/;
const MAX_MSG_BYTES = 64 * 1024;
const WS_OPEN = 1; // WebSocket.OPEN
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
  if (kind === "squad") {
    return {
      title: "Golive \u2014 multistream",
      description: "Assista a v\u00e1rias salas do Golive ao mesmo tempo, lado a lado.",
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
    .replaceAll("__OG_IMAGE__", escapeHtml(url.origin + OG_IMAGE))
    .replaceAll("__APP_VERSION__", escapeHtml(String(env.APP_VERSION || "")));
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

    // Multistream console: several rooms side by side, each one an embedded
    // viewer (/watch/<id>?embed=1) in its own iframe.
    if (lower === "/squad") return serveShell(env, url, "/squad.html", ogFor("squad"));

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
    // Optional room PIN. It has to outlive this instance: a viewer can connect
    // (and revive the DO) before the host ever appears, so it is persisted
    // rather than kept only in memory.
    this.pin = "";
    ctx.blockConcurrencyWhile(async () => {
      this.pin = (await ctx.storage.get("pin")) || "";
    });
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

  // Accepted, still-open sockets with a role, optionally excluding one socket.
  // getWebSockets() can briefly keep returning a socket after it closed, so
  // closed sockets are filtered out; otherwise a stale one blocks a reconnect as
  // "room in use" / "room full".
  socketsWithRole(role, exclude) {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws !== exclude && ws.readyState === WS_OPEN && this.roleOf(ws) === role);
  }

  // Replace a socket that is being reconnected over. The old client is told it
  // was replaced, so a still-live duplicate (a duplicated tab) stops instead of
  // reconnecting and fighting over the seat; a client that already reconnected
  // ignores the message on its now-dead socket. `quiet` suppresses the departure
  // notice for the streamer, whose viewers keep their connections across the
  // reconnect.
  replaceSocket(ws, quiet) {
    if (quiet) {
      const a = this.attachment(ws);
      if (a) {
        a.gone = true;
        try {
          ws.serializeAttachment(a);
        } catch {
          /* socket already closed */
        }
      }
    }
    this.send(ws, { type: "error", code: "room-taken", message: "This room was taken over by another session." });
    try {
      ws.close(4000, "replaced by reconnect");
    } catch {
      /* socket already closed */
    }
  }

  send(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* socket already gone */
    }
  }

  // Persist the PIN so it survives eviction. The host re-sends it on every
  // (re)connect, so storage is the backstop for a viewer arriving first.
  async setPin(pin) {
    if (pin === this.pin) return;
    this.pin = pin;
    if (pin) await this.ctx.storage.put("pin", pin);
    else await this.ctx.storage.delete("pin");
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return text("Expected a WebSocket upgrade\n", 426);
    }

    const url = new URL(request.url);
    const role = url.searchParams.get("role") === "streamer" ? "streamer" : "viewer";
    const room = (url.searchParams.get("room") || "").toLowerCase();
    const token = url.searchParams.get("token") || "";
    // An optional room PIN rides on the socket URL, so enforcing it costs no
    // extra messages: anything that is not 4-8 digits counts as "no PIN".
    const rawPin = url.searchParams.get("pin") || "";
    const pin = PIN_RE.test(rawPin) ? rawPin : "";

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
      const others = this.socketsWithRole("streamer");
      // The same host reconnecting (same token) reclaims its room by replacing
      // its own stale socket; a different host is still turned away so two
      // people cannot share a room ID.
      const conflicts = token
        ? others.filter((ws) => (this.attachment(ws)?.token || "") !== token)
        : others;
      if (conflicts.length) {
        return reject("room-in-use", "That room ID is already live. Pick another one.", "room-in-use");
      }
      for (const old of others) this.replaceSocket(old, true);
      // The host owns the PIN: setting one (or clearing it with an empty value)
      // takes effect from now on. Done before registration so a viewer racing the
      // host's reconnect cannot slip in against the old value.
      await this.setPin(pin);
    } else {
      // A viewer must present the room's PIN before anything else, so a wrong
      // PIN never disturbs an existing seat.
      if (this.pin && pin !== this.pin) {
        return reject(pin ? "pin-wrong" : "pin-required", "This room is PIN-protected.", "pin-required");
      }
      // A viewer reconnecting (same token) frees its own old slot instead of
      // taking another one, so reconnects cannot fill the room with ghosts.
      if (token) {
        for (const old of this.socketsWithRole("viewer")) {
          if ((this.attachment(old)?.token || "") === token) this.replaceSocket(old, false);
        }
      }
      if (this.socketsWithRole("viewer").length >= this.maxViewers) {
        return reject("room-full", `Room is full (${this.maxViewers} viewers).`, "room-full");
      }
    }

    // Registration happens on connect: no create/join handshake.
    const peerId = role === "viewer" ? newPeerId() : null;
    server.serializeAttachment({ role, peerId, token, pin });
    this.ctx.acceptWebSocket(server, [role]);

    if (role === "streamer") {
      this.send(server, { type: "created", room });
      // Tell viewers already in the room the streamer is here, so one holding on
      // through a signaling blip can settle instead of timing out its grace
      // period, and offer to each of them.
      for (const viewer of this.socketsWithRole("viewer", server)) {
        // Viewers that joined before the PIN existed are asked for it too, so a
        // protected room is never watched through an early, pin-less seat.
        if (pin && (this.attachment(viewer)?.pin || "") !== pin) {
          this.send(viewer, { type: "error", code: "pin-required", message: "This room is PIN-protected." });
          try {
            viewer.close(1013, "pin-required");
          } catch {
            /* socket already closed */
          }
          continue;
        }
        const pid = this.attachment(viewer)?.peerId;
        this.send(viewer, { type: "streamer-back" });
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
      case "renegotiate":
        // A viewer cannot restart ICE on its own, so when its path stalls it
        // asks the streamer to rebuild the connection with a fresh offer. This
        // keeps the same peer id, so it recovers without restarting the stream.
        if (role !== "viewer") return;
        this.relayToStreamer({ type: "renegotiate", from: this.attachment(ws)?.peerId });
        break;
      case "handoff-request":
        // A viewer offers to present. The streamer decides; nothing changes
        // until it answers with handoff-grant/handoff-deny.
        if (role !== "viewer") return;
        this.relayToStreamer({ type: "handoff-request", from: this.attachment(ws)?.peerId });
        break;
      case "handoff-deny":
        if (role !== "streamer") return;
        this.relayToViewer(msg.to, { type: "handoff-deny" });
        break;
      case "handoff-grant": {
        if (role !== "streamer") return;
        const requester = this.socketsWithRole("viewer").find((v) => this.attachment(v)?.peerId === msg.to);
        if (!requester) {
          this.send(ws, { type: "error", code: "handoff-missing", message: "That viewer is no longer in the room." });
          return;
        }
        // Move the stage. Both participants retire their current seat at once:
        // the outgoing streamer so the requester can take the streamer role
        // without hitting "room in use" (its socket can linger a moment past the
        // client's close), and the requester so the new streamer does not offer
        // to its own lingering viewer socket. The other viewers are told to
        // rebuild: a new presenter means new ICE credentials and a new DTLS
        // fingerprint, which cannot be applied to the old peer connection.
        for (const out of [ws, requester]) {
          const a = this.attachment(out);
          if (a) {
            a.role = "leaving";
            try {
              out.serializeAttachment(a);
            } catch {
              /* socket already closed */
            }
          }
        }
        for (const viewer of this.socketsWithRole("viewer", requester)) {
          this.send(viewer, { type: "peer-reset" });
        }
        this.send(requester, { type: "handoff-grant" });
        break;
      }
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
