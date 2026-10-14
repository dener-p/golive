# WebRTC AV1 + IPv6 Connection Test

## Goal

Build a tiny browser-only screen-sharing app to test whether WebRTC can
establish direct peer-to-peer connections, especially over IPv6, while
preferring AV1 video when both browsers support it.

This is a connectivity/codec experiment, not a production-ready
streaming service.

## Scope

-   No database.
-   No authentication or accounts.
-   Share a room using a simple URL.
-   Browser screen capture with `getDisplayMedia()`.
-   WebRTC for video transport.
-   A minimal WebSocket signaling server to exchange SDP offers/answers
    and ICE candidates.
-   Prefer AV1 when supported by both peers; retain browser-supported
    fallback codecs so connections can still work.
-   Use STUN for ICE discovery.
-   Do not configure a TURN relay by default. If direct connectivity
    fails, show the failure clearly rather than silently relaying media.
-   Display connection and codec diagnostics for testing.

## Suggested stack

-   Frontend: plain HTML/CSS/JavaScript or a small Vite app.
-   Signaling server: Go WebSocket server or Node.js.
-   Transport: WebRTC `RTCPeerConnection`.
-   No persistent storage: keep rooms in server memory and remove them
    when peers disconnect.

## User flow

1.  The streamer opens the app and clicks **Start sharing**.
2.  The browser asks the user to select a screen/window/tab.
3.  The app creates a short room ID and displays a shareable URL, such
    as `/watch/abc123`.
4.  A viewer opens that URL.
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
stream. - Connection state: `new`, `checking`, `connected`,
`disconnected`, `failed`. - Selected candidate-pair information when
available: IPv4/IPv6 and direct/relay candidate type. - Actual video
codec, resolution, frame rate, and bitrate when available. - Clear
diagnostic messages if AV1 is unavailable or ICE fails.

## Security and limitations

-   Anyone with the room URL can attempt to join; this is intentional
    for the test, so do not use it for private content.
-   Use HTTPS for the web app and secure WebSocket (`wss://`) in
    deployed tests. Browsers generally require a secure context for
    screen capture.
-   Validate room IDs and limit each room to one streamer and a small
    number of viewers.
-   In-memory rooms disappear when the signaling server restarts.
-   Direct P2P is best-effort. Some network combinations will fail
    without TURN.
-   Mesh connections to multiple viewers multiply the streamer's upload
    bandwidth. Start with one streamer and one viewer.

## Acceptance checklist

-   [ ] Streamer can start and stop screen sharing.
-   [ ] Viewer can join using a room URL without an account.
-   [ ] Signaling works without a database.
-   [ ] The app prioritizes AV1 only when the browser reports support.
-   [ ] The app displays the codec actually negotiated.
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

Implement one streamer and one viewer, room URLs, in-memory WebSocket
signaling, screen capture, AV1 preference, and a small diagnostics
panel. Test actual codec negotiation and ICE candidate selection before
adding any other features.
