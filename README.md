# golive (minimal build)

This is a stripped-down implementation of the `golive` spec, covering **only the hard
part**: native capture → AV1 encode → P2P WebRTC to N viewers, with a thin signaling
relay. Everything called out as skippable is skipped:

- **No auth.** Rooms are protected by an unguessable room id + a helper "key" printed to
  the console, nothing more.
- **No TURN.** STUN only. If direct connectivity can't be established, the viewer sees a
  clear error ("Direct connection failed…") instead of silently failing — that's the one
  piece of the TURN-related spec that's cheap to keep and worth keeping.
- **No Discord OAuth, no pairing codes, no download page, no tray icon.**

What's real and working end-to-end (tested in this session, see "What I verified" below):

- A **native helper** (`helper/`, plain Go binary) that shells out to `gst-launch-1.0` to
  capture the screen (or a test pattern) and encode it as AV1 **once**, in real time,
  preferring a hardware encoder if `gst-inspect-1.0` reports one is available
  (`nvav1enc`/`qsvav1enc`/`amfav1enc`/`vaav1enc`), falling back to `svtav1enc`.
- A hand-rolled **AV1 RTP payloader/depacketizer-compatible packetizer**
  (`helper/av1rtp.go`), because the AV1 RTP payloader (`rtpav1pay`) lives in
  `gst-plugins-rs` and is missing from a lot of stock GStreamer installs. Parsing the OBU
  stream and packetizing per the [AV1 RTP spec](https://aomediacodec.github.io/av1-rtp-spec/)
  ourselves means the only GStreamer requirement is capture + an AV1 encoder + `av1parse`
  (all in `gst-plugins-base`/`bad`/`good`), which is much more likely to already be
  installed. Verified against pion's own AV1 depacketizer in `av1rtp_test.go`.
- One [pion/webrtc](https://github.com/pion/webrtc) `PeerConnection` per connected viewer,
  all fed from a single `TrackLocalStaticRTP` — the "encode once, tee N ways" architecture
  from the spec, using pion (not GStreamer's `webrtcbin`) so the whole helper is one static
  Go binary with no GStreamer WebRTC plugin dependency.
- A **signaling/relay server** (`server/`) that does nothing but relay: helper presence,
  host start/stop commands, and SDP/ICE between helper and each viewer. It never touches
  media.
- A **single HTML file** (`server/index.html`, embedded into the server binary) that is
  both the viewer page and the host control page, per the spec's "same frontend, host mode
  unlocks" idea.

## Running it

You need [GStreamer](https://gstreamer.freedesktop.org/) installed (`gst-launch-1.0`,
`gst-inspect-1.0`, and the AV1 encoder of your choice — `svtav1enc` ships in
`gst-plugins-bad`) and Go 1.22+.

```bash
# 1. server (signaling relay + the web page), on any always-reachable machine
go run ./server -addr :8080

# 2. helper, on the host's machine (same machine or LAN; talks out to the server, never
#    receives inbound connections)
go run ./helper -server http://<server-host>:8080 -source test   # "test" = test pattern
# drop -source test to capture the real screen; add -autostart to skip clicking Start
```

The helper prints the viewer link and host-page link (with its key) on startup:

```
Viewer link : http://<server-host>:8080/watch/<roomId>
Host page   : http://<server-host>:8080/host/<roomId>?key=<key>
```

Open the host page to start/stop the stream and see connected viewers; open the viewer
link (from another machine, or another browser profile) to watch. No login for either.

`-source` also accepts a raw GStreamer source element/fragment if you want to point it at
something other than the real screen or the test pattern.

## What I verified in this sandbox

I don't have a GUI browser or a real screen here, so I couldn't click through the actual
HTML page, but I did verify the parts that are actually hard, end to end, with real
network sockets and real code (no mocks):

1. `helper/av1rtp_test.go`: the packetizer's output round-trips correctly through pion's
   independent AV1 RTP depacketizer for a range of OBU sizes (tiny, huge, fragmented
   across many packets).
2. Built and ran the real `server` and `helper` binaries together, plus a throwaway pion
   client standing in for a browser viewer (browsers speak the same WebRTC/RTP wire
   protocol, so this exercises the identical code path a real Chrome tab would):
   real GStreamer test-pattern capture → real SVT-AV1 encode → real RTP packetization →
   a real ICE/DTLS/SRTP handshake over the loopback network → **the viewer's WebRTC stack
   received and decoded actual RTP video packets** (logs below).
3. Repeated with **three simultaneous viewers** against the same room: one encoder
   instance, three independent `PeerConnection`s, all receiving packets — confirming the
   "encode once, fan out N ways" design actually holds.

```
viewer v1: connected via direct prflx (local host 192.0.2.2:59675 <-> remote prflx 192.0.2.2:37103)
got track video/AV1
SUCCESS: received first RTP frame
```

What I did *not* verify here: an actual browser tab decoding AV1 via WebCodecs/WebRTC
(needs a real Chrome + display), real screen capture on Windows/macOS (this sandbox is
headless Linux — `ximagesrc`/test-pattern is what I could exercise), and a real NAT/TURN
failure case. The `videotestsrc`-based flow having exercised the encoder → RTP → ICE →
SRTP path end-to-end is a good sign for those, but isn't a substitute for trying it on
your actual machine.

## Known simplifications vs. the full spec (intentional, per your instructions)

- Room "auth" is a printed key, not Discord OAuth.
- STUN only; TURN is left as a `TODO` in `helper/main.go`'s `ICEServers` list — add a
  `URLs`/`Username`/`Credential` entry there when you want it, no other code changes
  needed since `ICETransportPolicyAll` is already set.
- Helper reconnect/backoff to the server exists (simple exponential backoff), but there's
  no pairing flow — the helper just remembers a generated room id + key in
  `$XDG_CONFIG_HOME/golive/identity` (or the OS equivalent) so restarting it keeps the same
  room link.
- No download page / installer — you run `go run ./helper` or build it yourself.
