# Golive

## Goal

A tiny browser-based screen-sharing app for sharing with friends. WebRTC
establishes direct peer-to-peer connections (especially over IPv6) and
prefers AV1 video when both browsers support it. Signaling runs on
Cloudflare Workers + Durable Objects; media never touches the server.

Originally a connectivity/codec experiment, now a small friends-only
service. It is still not a production-grade streaming service.

## Scope

-   No database.
-   No authentication or accounts.
-   Share a room using a simple, streamer-chosen URL (`/watch/<id>`).
-   Browser screen capture with `getDisplayMedia()`.
-   WebRTC for video transport, plus optional best-effort tab/system audio
    captured alongside the screen.
-   Streamer-selectable capture frame rate (30 or 60 fps).
-   A Cloudflare Worker + one Durable Object per room to exchange SDP
    offers/answers and ICE candidates over WebSocket.
-   Prefer AV1 when supported by both peers; retain browser-supported
    fallback codecs so connections can still work.
-   Use STUN for ICE discovery.
-   Do not configure a TURN relay by default. If direct connectivity
    fails, show the failure clearly rather than silently relaying media.
-   Display connection and codec diagnostics for testing.

## Stack

-   Frontend: plain HTML/CSS/JavaScript (no build step).
-   Signaling: a Cloudflare Worker plus one Durable Object per room
    (WebSocket Hibernation), deployed to `golive.puhl.dev`.
-   Transport: WebRTC `RTCPeerConnection`, STUN only.
-   No persistent storage: rooms live in Durable Object memory and vanish
    when everyone disconnects. The DO outlives its WebSockets, so viewers
    can wait for the streamer to (re)appear.

## User flow

1.  The streamer opens the app, optionally types a **Room ID** (or keeps
    the remembered one / gets a random default), chooses whether to
    **Prefer AV1**, **Share audio** (best effort), and a video **Quality**
    preset (e.g. 4K/60fps, 4K/30fps, 1440p/60fps, 1080p/60fps,
    1080p/30fps, 720p/30fps, Data saver, Auto), then clicks **Start
    sharing**.
2.  The browser asks the user to select a screen/window/tab.
3.  The app opens signaling for that room ID (creating the room if it did
    not exist), saves the ID in `localStorage`, and displays a shareable
    URL such as `/watch/abc123`. Reusing the same ID gives the same link
    every time.
4.  A viewer opens that URL. If the streamer is not live yet, the viewer
    waits and connects automatically when it starts.
5.  The signaling server exchanges WebRTC session descriptions and ICE
    candidates between the two browsers.
6.  The peers attempt a direct WebRTC connection. The app reports
    whether the selected ICE candidate pair uses IPv6 or IPv4 when that
    information is available.
7.  The viewer sees the screen stream and the negotiated video codec.

## AV1 behavior

-   Detect codecs using `RTCRtpSender.getCapabilities("video")` or
    `RTCRtpReceiver.getCapabilities("video")`.
-   If AV1 is available, prioritize `video/AV1` using
    `RTCRtpTransceiver.setCodecPreferences()` before offer/answer
    negotiation.
-   Keep other browser-supported codecs in the preference list as
    fallbacks. Do not remove auxiliary codecs such as RTX.
-   Verify the actual negotiated codec with
    `RTCPeerConnection.getStats()`; do not assume AV1 was selected just
    because it was preferred.
-   If AV1 is unavailable or negotiation fails, report that clearly and
    allow a fallback codec for comparison.

## IPv6 testing

-   Use normal WebRTC ICE gathering and STUN; do not try to open raw
    sockets from the browser.
-   Do not assume that having IPv6 guarantees direct connectivity.
    Firewalls, router policy, browser behavior, and the other peer's
    network can prevent it.
-   Inspect ICE candidate and selected-pair statistics where supported.
    Log candidate types and address family when available, but avoid
    displaying or storing public IP addresses in the UI.
-   Run tests between devices on different networks. A same-LAN test
    alone does not prove internet IPv6 connectivity.
-   The signaling server only exchanges connection setup messages; it
    should not carry video traffic.

## Minimal UI

Show: - **Start sharing** button for the streamer. - Room URL and **Copy
link** action. - Video element for the local preview and remote
stream. - Streamer options for **Prefer AV1**, **Share audio**, and a video
**Quality** preset (4K/60fps, 4K/30fps, 1440p/60fps, 1080p/60fps,
1080p/30fps, 720p/30fps, Data saver, Auto) applied to each viewer's sender,
with Opus audio lifted to 192 kbps full-band stereo. - Viewer unmutes audio via the video controls'
speaker icon (audio starts muted for autoplay-policy reasons). - On the
streamer, a **Connected viewers** count and a **Diagnostics for**
selector to inspect one viewer's connection. - Connection state: `new`, `checking`,
`connected`, `disconnected`, `failed`. - Selected candidate-pair
information when available: IPv4/IPv6 and direct/relay candidate type. -
Actual video codec, resolution, frame rate, and bitrate when available,
plus the actual audio codec and bitrate when audio is shared. - Clear
diagnostic messages if AV1 is unavailable, audio could not be captured, or
ICE fails.

## Security and limitations

-   Anyone with the room link can attempt to join; this is intentional for
    a friends-only service, so do not use it for private content.
-   Streamer-chosen room IDs are guessable; the link is the only secret.
-   Deploy over HTTPS so signaling uses `wss://`. Browsers require a
    secure context for screen capture.
-   Room IDs are validated and each room is limited to one streamer and
    `MAX_VIEWERS` viewers. A second streamer on a live ID is rejected.
-   Rooms disappear when everyone disconnects (no persistent storage). A
    viewer that opens the link early waits in the Durable Object until the
    streamer appears.
-   Direct P2P is best-effort. Some network combinations will fail
    without TURN.
-   Mesh connections to multiple viewers multiply the streamer's upload
    bandwidth. Start with one streamer and one viewer.

## Deployment

`wrangler.jsonc` deploys the Worker, its `Room` Durable Object and the
static frontend from `public/` to the `golive.puhl.dev` custom domain:

```bash
cd src
npm install
npx wrangler login
npm run dev      # local Worker + DO on http://localhost:3000
npm run deploy   # publish to Cloudflare
```

Remove any existing tunnel/DNS record for `golive.puhl.dev` before the
first deploy; Wrangler creates the DNS record and certificate for the
custom domain.

## Acceptance checklist

-   [ ] Streamer can start and stop screen sharing.
-   [ ] Streamer can reuse a custom room ID and get the same link again.
-   [ ] Viewer can join using a room URL without an account.
-   [ ] A viewer that opens the link early waits and connects when the
    streamer starts.
-   [ ] Starting a second stream on a live room ID is rejected.
-   [ ] Multiple viewers (up to `MAX_VIEWERS`, default 8) can watch the same
    room at once, each with its own peer connection.
-   [ ] Signaling works without a database.
-   [ ] The app prioritizes AV1 only when the browser reports support.
-   [ ] The app displays the codec actually negotiated.
-   [ ] The streamer can choose resolution/fps presets (e.g. 1080p/60fps, 4K/30fps) and optionally share tab/system
    audio; the viewer can enable sound and see the negotiated audio codec.
-   [ ] The app reports ICE connection state and IPv4/IPv6
    candidate-pair details when available.
-   [ ] No TURN relay is configured by default.
-   [ ] Direct-connection failures are visible and useful for debugging.
-   [ ] Tests are run between different networks, including an
    IPv6-capable setup.

## Out of scope

-   Accounts, authentication, database, persistent rooms, chat,
    recording, mobile/native helper, SFU, automatic TURN fallback, and
    production-grade privacy controls.

## First milestone

Implemented: one streamer and many viewers, custom room URLs, Cloudflare
Worker + Durable Object signaling, screen capture, AV1 preference, and a
diagnostics panel. Next: verify real codec negotiation and ICE candidate
selection from a deployed Worker before adding anything else.

