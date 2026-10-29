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

1. Open `/` and pick **Host** or **Watch**. The host console is `/host`; the
   streamer optionally types a **Room ID** (3-24 chars: `a-z`, `0-9`, `-`, `_`,
   starting with a letter or number; leave it blank for a random one) and clicks
   **Start sharing**, then picks a screen/window/tab. The chosen ID is saved in
   `localStorage`, so the same link works next time. Optionally type a 4-8 digit
   **PIN** (also remembered): viewers then have to enter it before they can
   watch. Leave it blank for an open room.
2. Share the `/watch/<id>` link. On mobile the **Share** button opens the native
   share sheet; on desktop **QR code** shows a scannable code so a phone can join
   without retyping. Up to `MAX_VIEWERS` devices (default 8) can join. If the
   streamer is not live yet, viewers see "Waiting for the streamer…" and connect
   the moment it starts. A bare room code in the address bar (`/test`) redirects
   to the canonical `/watch/test`.
3. A viewer controls sound from a **volume bar** above the player (a mute toggle,
   a slider and a live percentage) or the speaker icon in the video controls;
   audio starts muted for autoplay-policy reasons. Viewers see only the player
   and diagnostics, not the host controls. The viewer's volume and mute choice is
   remembered on the next visit. For viewers the **Log** starts collapsed behind
   a toggle, and status messages and log lines are announced to screen readers
   (`aria-live`). Viewers can also pop the stream out into **picture-in-picture**
   where the browser supports it. If the room has a PIN, the player is covered by
   a PIN prompt until the right code is entered (a wrong one says so and stays).
4. **One page, many rooms** (`/host`, `/watch/<id>`, `/squad` all serve the same
   shell). Every room is a native panel — no iframes — driven by its own
   `createRoom()` engine, so you can host and watch several rooms at once. Add a
   room with a code (or paste a `/watch/…` link); drag the splitters between
   panels to resize them (the layout is remembered in `localStorage`, and
   `/squad` restores it). Each room is still one direct P2P connection; only one
   panel plays sound at a time (its speaker button picks it). The per-panel
   controls keep a live/waiting badge, fullscreen, open-in-a-new-tab and remove.

Shared links get a **link preview** (Open Graph/Twitter): the worker fills the
meta tags per route, so `/watch/<id>` previews as “Golive — assistir à sala
&lt;id&gt;” with `public/og.png` as the image.

## Language

The UI is available in **Portuguese (pt-BR)** and **English**. The default is
pt-BR; the browser language picks English for `en` locales, and the header
picker overrides and remembers the choice (`localStorage`). Add `?lang=en` (or
`?lang=pt-BR`) to force one for a link. Strings live in `public/i18n.js`; markup
opts in with `data-i18n*` attributes and code calls the global `t(key, vars)`.

Before starting, the streamer chooses:

- **Prefer AV1** - prioritize `video/AV1`; compare against the browser default
  when unticked.
- **Share audio** - include captured tab/system audio (best effort, see below).
- **Quality** - a sender preset: Native (screen resolution, 30 Mbps), 4K/60fps
  (40 Mbps), 4K/30fps (25 Mbps),
  1440p/60fps (20 Mbps), 1080p/60fps (12 Mbps), 1080p/30fps (8 Mbps),
  Text/sharp (15 fps, 8 Mbps), 720p/30fps (4 Mbps), Data saver (1 Mbps) or Auto.
  Each sets a bitrate ceiling,
  fps cap and resolution via `RTCRtpSender.setParameters()` and can be changed
  live mid-share. The encoded resolution fits the capture into a 16:9 box of the
  preset's target (a 4K capture is scaled to 1080p for the 1080p presets; an
  ultrawide or portrait screen is scaled by its larger ratio so it does not
  overshoot the target and its bitrate budget), and the high-resolution presets
  prefer sharpness (`maintain-resolution`) since screen content is mostly static.
  **Native** opts out of that scaling instead: it encodes at the captured size
  (`scaleResolutionDownBy: 1`), so nothing is fractionally resampled — a
  non-integer scale (e.g. 1440p into 1080p = 1.33x) is what softens text. The
  achieved bitrate can be lower than the ceiling. **Text/sharp** spends its bits
  on detail instead of frames, so documents and code stay crisp when the content
  barely moves. Each preset also sets the track's `contentHint`: `"text"` for the
  screen presets (sharp edges and flat colour), applied through
  `applyContentHint()`, which reads the value back and falls back to `"detail"`
  when a browser does not implement `"text"`; **Data saver** uses `"motion"` since
  it already prefers framerate. The chosen preset, **Prefer AV1** and **Share
  audio** are remembered in `localStorage` for the next visit. A viewer can also
  be pinned to its own preset: the diagnostics panel's picker
  (`perViewerQuality`) applies only to the focused viewer's sender, so one laggy
  peer can be dialed down to 720p without lowering the room for everyone. The
  override lasts as long as that viewer stays connected, and the rest follow the
  room preset.

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
- **AV1** is put first via `setCodecPreferences()` only when the matching
  `RTCRtpSender`/`RTCRtpReceiver` `getCapabilities("video")` reports it; every
  other codec (including RTX) stays as a fallback. Diagnostics show send and
  receive separately, and the host's **Prefer AV1** pill gets a live encode
  status from `mediaCapabilities.encodingInfo()` (hardware / software / may lag
  / unavailable) for the current preset. If the browser lists AV1 but cannot
  encode it, the checkbox is disabled instead of pretending it will be used.
  The UI shows the codec that was *actually* negotiated after connecting.
- **ICE** uses STUN only (**no TURN**): Google's two servers plus Cloudflare's
  dual-stack one, and an `iceCandidatePoolSize` so candidates are ready before
  the first offer. The redundancy means one blocked STUN does not cost us
  candidates, and the dual-stack server is what yields an IPv6 server-reflexive
  candidate when the network has working IPv6 (the NAT-free path). If no direct
  path exists, ICE goes to `failed` and the UI says so. The diagnostics panel
  reports separately whether an IPv6 srflx candidate was actually gathered, so
  it is clear whether the IPv6 path was available. When a drop is seen, the
  streamer (the offerer) retries the path with an **ICE restart**
  (`restartIce()` + a fresh offer, up to 3 times per connection), so a network
  change can recover without tearing the session down. When ICE fails, the alert
  is annotated from the candidates that were gathered (see `failureHints()`): a
  connection with only local/mDNS candidates points at a same-network problem
  (router client isolation or a Public-network firewall), while no srflx at all
  points at blocked UDP/STUN. A **viewer** cannot restart ICE itself (it does not
  send offers), so when its path stalls it recovers on its own: on
  `failed`/`disconnected` it asks the streamer (a `renegotiate` relay) to rebuild
  the connection with a fresh offer, up to 5 times, falling back to a full
  signaling reconnect in which the server assigns a new peer id. Without this a
  stalled viewer stayed frozen until the host restarted the transmission. While a
  connection is `disconnected` or `failed`, the diagnostics panel also offers a
  **Reconnect** button: the streamer forces an ICE restart past the automatic
  cap, and a viewer immediately re-opens signaling for a brand-new connection.
- **Audio** comes from the display stream (`getDisplayMedia`) on its own
  transceiver using Opus. Capture disables the browser's voice processing (echo
  cancellation, noise suppression, auto gain) and asks for 48 kHz stereo, so
  tab/system music is not pumped or muffled. The offer's Opus `fmtp` is edited
  (`preferOpus()`) to raise `maxaveragebitrate` to 192 kbps, advertise full-band
  48 kHz stereo (`maxplaybackrate`/`sprop-maxcapturerate`), and enable in-band
  FEC (`useinbandfec=1`). Silence suppression stays off (`usedtx=0`) because
  DTX clips the start of sounds and makes music choppy. The same parameters are
  re-applied on ICE-restart offers, otherwise audio would fall back to the
  browser's ~32 kbps mono defaults after a reconnect. Best effort and source-dependent:
  - **Chrome tab** - carries the tab's audio on all platforms.
  - **Entire screen** - carries system audio (Windows/ChromeOS; macOS 14.2+).
  - **Window** - carries only the picked window's audio where the browser
    supports per-window capture (`windowAudio: "window"`), so other windows stay
    silent; falls back to video-only when unsupported.
  - Firefox and Safari do not offer screen-share audio.
  When no audio track comes back, the app logs why and continues video-only.
- **Reconnect**: the client reopens the signaling socket with exponential backoff
  (1s→15s) while it is live, so brief Worker restarts or network blips recover on
  their own. The backoff only resets once a socket has been stable for ~10s
  (`SIGNAL_STABLE_MS`), so a connection that opens and immediately drops keeps
  backing off rather than reconnecting every second — which matters because each
  retry re-runs a full offer plus candidate exchange, and every WebSocket message
  is a Durable Object request.
- **Reconnects reclaim the seat**: each tab carries a per-tab `SIGNAL_TOKEN`
  (kept in `sessionStorage`) on the socket URL. When the same participant
  reconnects, the room replaces its own stale socket instead of refusing the
  connection as *room in use* / *room full*. Cloudflare can briefly keep
  returning a closed socket from `getWebSockets()`, which previously left a live
  room permanently occupied until the host picked a new room ID; a genuinely
  different host is still turned away.
- **A signaling blip does not interrupt the video**: on the streamer's reconnect
  the room does not announce *streamer-left* for its own viewers, the streamer
  keeps the peer connections that are still healthy (`beginConnSweep`) and only
  drops viewers that left, and a viewer holds its connection through a short
  grace period (`STREAMER_GRACE_MS`) rather than tearing down. Only the
  signaling socket blinks, not the media.
- **Signaling efficiency**: a connection's ICE candidates are coalesced and sent
  as one message per ~100ms window (`queueLocalCandidate`/`CANDIDATE_FLUSH_MS`)
  instead of one message per candidate, cutting the dominant source of Durable
  Object requests several-fold. The receiver accepts either a batch or a single
  candidate, so the format is backward compatible. For context, Cloudflare counts
  each incoming WebSocket message as a Durable Object request (at a 20:1 ratio for
  compute-requests billing, though metrics show actual counts); outgoing messages
  and protocol pings are not charged.
- **Diagnostics**: beyond the selected candidate pair and the negotiated codec,
  the panel shows packet loss, jitter and (on a viewer) freezes, and the
  streamer sees the **total upload** across all viewers — the number that decides
  how many the connection can feed — with a one-time log warning past 25 Mbps.
  The streamer also sees the encoder's **quality-limitation reason** (CPU vs
  bandwidth), and a **Copy diagnostics** button snapshots the panel plus the log
  to the clipboard for easy reporting.
- **Bug reports leave quickly**: both pages carry a footer with a GitHub link and
  a **Report a bug** button (also in the diagnostics panel). It puts a pre-filled
  report on the clipboard — version, page, locale and, in the app, the whole
  diagnostics panel and log — and shows where to send it: the maintainer's
  Discord handle or a new GitHub issue. `report.js` is shared by the app and the
  landing page. Discord has no username-to-DM link, so the handle is offered for
  a manual DM rather than deep-linked.
- **Version**: `APP_VERSION` in `wrangler.jsonc` is injected into the page's
  `<meta name="golive-version">` by the Worker, so bug reports name the deploy.
  Keep it in sync with `package.json`.
- **Wake lock**: while a stream is live (hosting or watching) the page holds a
  Screen Wake Lock so the device does not sleep mid-session, re-acquiring it when
  the tab becomes visible again.
- **Theater mode and shortcuts**: the video carries a control that (like `T`)
  hides the page chrome and lets the stream fill the window, with the alert,
  "unmute" hint and volume bar floating over it; the choice is remembered and
  `Esc` (outside fullscreen) leaves it. `F` toggles fullscreen, `P`
  picture-in-picture and `M` mute (viewers only). Shortcuts are ignored while
  typing in a field or with the QR/report dialog open.
- **Presenter handoff**: a viewer can ask to present (its button appears while a
  streamer is in the room) and the host answers **Let them present** / **Not
  now**. The requester captures its screen on the click — screen capture needs a
  user gesture, so it can never be triggered remotely — and holds the stream
  until the answer. On a grant the room swaps the stage rather than opening a
  second one: `handoff-grant` retires both seats at once (the outgoing streamer
  so its socket cannot linger as "room in use", and the requester so the new
  streamer is not offered to its own old viewer socket), every other viewer gets
  `peer-reset` and rebuilds — a new presenter means new ICE credentials and a
  new DTLS fingerprint, which an existing `RTCPeerConnection` cannot adopt — and
  the requester reconnects as the streamer on the same room and token. The old
  host then re-joins the same room as a viewer, so both keep watching the same
  link with no reload. Denials and unanswered requests (45s) release the
  captured tracks.
- **Optional room PIN**: the host may set a 4-8 digit PIN, which rides on the
  signaling socket URL (`/ws?...&pin=`) so the Durable Object enforces it with
  no extra messages (incoming WS messages are the billed DO requests). A viewer
  without it is rejected with `pin-required` and the client shows a gate that
  covers the player; a wrong one gets `pin-wrong`. The PIN is persisted in DO
  storage because a viewer can connect — and revive the DO — before the host
  ever appears, and when the host turns a PIN on any viewer already waiting
  without it (`pin` recorded in its attachment) is asked too, so a protected
  room is never watched through an early, pin-less seat. The host re-sends the
  PIN on every reconnect; leaving the field empty clears it. It is a second
  factor on top of the link, not an account: anyone who has both the link and
  the PIN gets in, and the link itself is still the real secret.
- **One page, many rooms**: `/host`, `/watch/<id>` and `/squad` all serve the same
  shell (`index.html` + `shell.js` + `room.js`). A room is a panel built from a
  `<template>`, and each panel gets its own `createRoom()` instance; element
  lookups go through a per-panel `data-el` map instead of `document` ids, so any
  number of rooms can run side by side. Signaling and media are unchanged — each
  room is still one direct P2P connection, not a mesh/SFU. The shell owns the
  header, toolbar, log, diagnostics, QR and report flow, and lays panels out in a
  grid of columns with draggable splitters (weights saved in `localStorage`).
  Panels report their log/diagnostics/state back through callbacks, so the
  selected room's table and the live/waiting badge stay in sync. The realistic
  limit (2–4 streams, more on a strong machine) is decode CPU and bandwidth on
  the viewer, not the Durable Object.
- Candidate logs show type and address family only; IP addresses are never
  displayed or stored. Anyone with the room link can join, so don't share
  private content.
## Files

- `worker.js` - Worker routing + the `Room` Durable Object (signaling)
- `wrangler.jsonc` - Cloudflare Worker, assets, DO and domain configuration
- `public/index.html` - unified app shell (host/viewer/multi-room), `public/shell.js`
  - panel grid + global chrome, `public/room.js` - per-room engine (signaling, P2P)
- `public/style.css` - all styling, including the shell layout and splitters
- `public/home.html` - landing page at `/` (Host or Watch)
- `public/i18n.js` - pt-BR / en translations (no build step)
- `public/qr.js` - dependency-free QR encoder (room link as a scannable code)
- `public/report.js` - shareable "Report a bug" flow (clipboard + Discord/GitHub)
- `public/og.png` - 1200x630 link-preview image (worker injects the meta tags)
- `public/favicon.png` - icon
