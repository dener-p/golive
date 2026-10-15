# Golive

Friends-only browser screen sharing. WebRTC carries the media peer-to-peer
(AV1 preferred, IPv6-friendly), while a Cloudflare Worker with one Durable
Object per room relays signaling. No accounts, no database, and no media ever
passes through Cloudflare.

## Run

Prerequisites: Node 18+ and a Cloudflare account that owns the domain you
deploy to.

```bash
cd src
npm install
npx wrangler login
npm run dev       # http://localhost:3000  (wrangler dev: local Worker + DO)
npm run deploy    # publishes the Worker and static assets
```

`MAX_VIEWERS` (default `8`) lives in `wrangler.jsonc` under `vars`.

`localhost` counts as a secure context, so screen capture works locally. The
deployed site is HTTPS and the client upgrades signaling to `wss://`
automatically.

## Deploy to Cloudflare

`wrangler.jsonc` declares `golive.puhl.dev` as a `custom_domain`, so a single
`npm run deploy` uploads:

- the Worker (`worker.js`) and its Durable Object class, and
- the static frontend from `public/` (bound as the `ASSETS` fetcher).

If another service (for example a `cloudflared` tunnel) already owns that
hostname, remove its ingress/DNS record first; Wrangler creates the DNS record
and certificate for the custom domain on deploy. To try it out without a
domain, delete the `routes` entry and deploy to `golive.<account>.workers.dev`.

## Use

1. The streamer opens `/`, optionally types a **Room ID** (3-24 chars: `a-z`,
   `0-9`, `-`, `_`, starting with a letter or number; leave it blank for a
   random one) and clicks **Start sharing**, then picks a screen/window/tab.
   The chosen ID is saved in `localStorage`, so the same link works next time.
2. Share the `/watch/<id>` link. Up to `MAX_VIEWERS` devices (default 8) can
   join. If the streamer is not live yet, viewers see "Waiting for the
   streamer…" and connect the moment it starts.
3. A viewer unmutes with the speaker icon in the video controls (audio starts
   muted for autoplay-policy reasons).

Before starting, the streamer chooses:

- **Prefer AV1** - prioritize `video/AV1`; compare against the browser default
  when unticked.
- **Share audio** - include captured tab/system audio (best effort, see below).
- **Quality** - a sender preset: 4K/60fps (40 Mbps), 4K/30fps (25 Mbps),
  1440p/60fps (20 Mbps), 1080p/60fps (12 Mbps), 1080p/30fps (8 Mbps),
  720p/30fps (4 Mbps), Data saver (1 Mbps) or Auto. Each sets a bitrate ceiling,
  fps cap and resolution via `RTCRtpSender.setParameters()` and can be changed
  live mid-share. The encoded resolution follows the preset (a 4K capture is
  scaled to 1080p for the 1080p presets), and the high-resolution presets prefer
  sharpness (`maintain-resolution`) since screen content is mostly static. The
  achieved bitrate can be lower than the ceiling.

## Design notes

- **Signaling**: WebSocket at `/ws?room=<id>&role=streamer|viewer`. The Worker
  routes each connection to the `Room` Durable Object named after the room, so
  the DO *is* the room. It holds one streamer and up to `MAX_VIEWERS` viewers,
  registers them on connect (no create/join handshake), and relays
  SDP/ICE. WebSocket Hibernation keeps idle viewers connected cheaply.
- **Ephemeral rooms**: a room disappears when everyone leaves, but the DO
  survives with zero sockets, so a viewer can open a link early and wait.
- **Room IDs**: 3-24 lowercase `[a-z0-9_-]`, starting with a letter or number.
  The streamer may pick one (remembered in `localStorage`) or get a random
  8-char ID. A second streamer on a live ID is rejected with `room-in-use`.
- **Video is a mesh**: the streamer opens one `RTCPeerConnection` (and one
  encoder) per viewer, so upload bandwidth scales with viewer count. Each
  viewer gets a short `peerId`; the streamer's diagnostics dropdown picks which
  viewer to inspect.
- **AV1** is put first via `setCodecPreferences()` only when
  `getCapabilities("video")` reports it; every other codec (including RTX)
  stays as a fallback. The UI shows the codec that was *actually* negotiated.
- **ICE** uses STUN (`stun:stun.l.google.com:19302`) only. **No TURN.** If no
  direct path exists, ICE goes to `failed` and the UI says so.
- **Audio** comes from the display stream (`getDisplayMedia({ audio: true })`)
  on its own transceiver using Opus. The offer's Opus `fmtp` is edited
  (`preferOpus()`) to raise `maxaveragebitrate` to 128 kbps and request stereo,
  since the browser default is only ~32 kbps. Best effort and source-dependent:
  - **Chrome tab** - carries the tab's audio on all platforms.
  - **Entire screen** - carries system audio (Windows/ChromeOS; macOS 14.2+).
  - **Window** - normally has none; prefer a tab or the whole screen.
  - Firefox and Safari do not offer screen-share audio.
  When no audio track comes back, the app logs why and continues video-only.
- **Reconnect**: the client reopens the signaling socket with backoff while it
  is live, so brief Worker restarts or network blips recover on their own.
- Candidate logs show type and address family only; IP addresses are never
  displayed or stored. Anyone with the room link can join, so don't share
  private content.

## Files

- `worker.js` - Worker routing + the `Room` Durable Object (signaling)
- `wrangler.jsonc` - Cloudflare Worker, assets, DO and domain configuration
- `public/index.html`, `public/app.js`, `public/style.css` - frontend
- `public/favicon.png` - icon
