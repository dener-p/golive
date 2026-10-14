// Smoke test for the signaling server. Run with the server already started:
//   npm start &  node test-signaling.js
const WebSocket = require("ws");
const URL = `ws://localhost:${process.env.PORT || 3000}/ws`;

function client() {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    ws.inbox = [];
    ws.waiters = [];
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      const w = ws.waiters.shift();
      if (w) w(m); else ws.inbox.push(m);
    });
    ws.next = () => new Promise((r) => (ws.inbox.length ? r(ws.inbox.shift()) : ws.waiters.push(r)));
    ws.on("open", () => resolve(ws));
  });
}

function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("ok  -", msg);
}

(async () => {
  const s = await client();
  s.send(JSON.stringify({ type: "create" }));
  const created = await s.next();
  assert(created.type === "created" && /^[a-z0-9]{8}$/.test(created.room), "room created with valid ID");

  const bad = await client();
  bad.send(JSON.stringify({ type: "join", room: "../etc" }));
  assert((await bad.next()).code === "bad-room", "invalid room ID rejected");
  bad.send(JSON.stringify({ type: "join", room: "zzzzzzzz" }));
  assert((await bad.next()).code === "room-not-found", "unknown room rejected");

  const v = await client();
  v.send(JSON.stringify({ type: "join", room: created.room }));
  assert((await v.next()).type === "joined", "viewer joined");
  assert((await s.next()).type === "peer-joined", "streamer notified of viewer");

  const v2 = await client();
  v2.send(JSON.stringify({ type: "join", room: created.room }));
  assert((await v2.next()).code === "room-full", "second viewer rejected (room full)");

  s.send(JSON.stringify({ type: "offer", payload: { type: "offer", sdp: "x" } }));
  assert((await v.next()).type === "offer", "offer relayed to viewer");
  v.send(JSON.stringify({ type: "answer", payload: { type: "answer", sdp: "y" } }));
  assert((await s.next()).type === "answer", "answer relayed to streamer");
  v.send(JSON.stringify({ type: "candidate", payload: { candidate: "c" } }));
  assert((await s.next()).type === "candidate", "candidate relayed");

  v.send(JSON.stringify({ type: "offer", payload: {} }));
  s.send(JSON.stringify({ type: "candidate", payload: null }));
  assert((await v.next()).type === "candidate", "viewer cannot forge offers (dropped)");

  v.close();
  assert((await s.next()).type === "peer-left", "streamer notified when viewer leaves");

  const v3 = await client();
  v3.send(JSON.stringify({ type: "join", room: created.room }));
  await v3.next(); await s.next();
  s.close();
  assert((await v3.next()).type === "streamer-left", "viewer notified when streamer leaves");

  const v4 = await client();
  v4.send(JSON.stringify({ type: "join", room: created.room }));
  assert((await v4.next()).code === "room-not-found", "room removed after streamer disconnect");

  console.log("All signaling checks passed.");
  process.exit(0);
})();
