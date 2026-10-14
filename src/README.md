# WebRTC AV1 + IPv6 Connection Test

Tiny browser-only screen-sharing app to test direct peer-to-peer WebRTC
connectivity (especially IPv6) while preferring AV1 video. It is a
connectivity/codec experiment, not a production streaming service.

## Run

```bash
npm install
npm start          # http://localhost:3000  (PORT / HOST env vars supported)
npm run test:signaling   # with the server running
```

`localhost` counts as a secure context, so screen capture works locally.
For tests between devices on different networks, deploy behind HTTPS
(for example a reverse proxy such as Caddy or nginx with TLS, forwarding
`/` and the `/ws` WebSocket to this server). The client automatically uses
`wss://` when the page is served over HTTPS. The server listens
dual-stack (`::`) by default so it is reachable over IPv4 and IPv6.

## Use

1. Streamer opens `/`, clicks **Start sharing**, picks a screen/window/tab.
2. Copy the displayed `/watch/<room>` link and open it on another device
   on a different network.
3. Both pages show ICE state, selected candidate pair (IPv4/IPv6, candidate
   types, direct vs relay), actual codec from `getStats()`, resolution,
   frame rate and bitrate.

Untick **Prefer AV1** (before starting) on either side to compare against
the browser's default codec order.

## Design notes

- Signaling is a WebSocket relay at `/ws` with in-memory rooms: one streamer
  and one viewer per room. Rooms vanish when the streamer disconnects or the
  server restarts. No database, no accounts.
- Room IDs are 8 random lowercase alphanumeric characters (server-validated).
- AV1 is put first via `setCodecPreferences()` only when
  `getCapabilities("video")` reports it; all other codecs (including RTX)
  stay as fallbacks. The UI shows the codec that was *actually* negotiated and
  warns if it isn't AV1.
- ICE uses STUN (`stun:stun.l.google.com:19302`) only. **No TURN.** If no
  direct path exists, ICE goes to `failed` and the UI says so.
- Candidate logs show type and address family only; IP addresses are never
  displayed or stored. Browsers may hide host addresses behind mDNS
  (`.local`), in which case the family shows as `mDNS`/unknown.
- Anyone with the room URL can join. Don't use it for private content.

## Files

- `server.js` - static file server + WebSocket signaling
- `public/index.html`, `public/app.js`, `public/style.css` - frontend
- `test-signaling.js` - signaling smoke test
