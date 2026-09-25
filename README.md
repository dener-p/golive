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

## What I verified

Verified on a real Windows machine (AMD RX 9060 XT, real screen + Parsec virtual display),
with real network sockets, real code, and the real binaries (no mocks):

1. `helper/av1rtp_test.go`: the packetizer's output round-trips correctly through pion's
   independent AV1 RTP depacketizer for a range of OBU sizes (tiny, huge, fragmented
   across many packets).
2. Real **Windows screen capture** (`d3d11screencapturesrc`) → real **AMD hardware AV1
   encode** (`amfav1enc`, auto-detected) → RTP packetization → real ICE/DTLS/SRTP to a
   stand-in viewer over the network → the viewer receives RTP video + keyframes at the
   configured GOP interval. Encoder choice, monitor index, and per-viewer ICE path are all
   visible in the helper log and host UI.
3. The **diagnostics** slice: the helper now reports per-viewer ICE gather time, connect
   time, selected candidate type (`host`/`srflx`/`prflx`), and RTCP-derived RTT/loss/jitter
   (computed against the Sender Reports pion generates), plus disconnect reason. The host
   UI shows a per-viewer table, and the viewer page shows time-to-first-frame.
4. **Capture-source enumeration**: a `list-sources` command round-trips through the relay
   and lists real monitors (index, device name, primary) for the host-UI picker.
5. Three simultaneous viewers (pion stand-ins) against one room: one encoder instance,
   three independent `PeerConnection`s, all receiving packets — the "encode once, fan out
   N ways" design holds.

```
2026/09/25 viewer v1: connected via direct prflx (local host fdfd::1aba:db37:55921 <-> remote prflx fdfd::1aba:db37:55945)
RESULT viewer=2ea81f3707 direct=true connectedMs=1263 rtpPkts=1171 keyframes=4 rate=195 pps
```

What I still cannot verify here: an actual browser tab decoding AV1 via WebCodecs/WebRTC
(needs you to open the viewer link in a real Chrome) and real-world NAT combinations
(loopback always connects). For NAT testing, `tools/webrtc-check` is the stand-in viewer —
run the helper on one network and the check tool on another and compare the `direct=`
result (see "Development tools" below).

## Development tools

- `tools/webrtc-check` — scriptable stand-in viewer for connection testing: connects to a
  room exactly like a browser tab (WS signaling, WebRTC answer, trickle ICE), counts RTP
  packets/keyframes, and also opens a host-role socket to print live status and capture
  sources. This is the seed of the NAT regression suite.

  ```bash
  go run ./tools/webrtc-check -server http://<server-host>:8080 -room <roomId> -key <hostKey> -seconds 8
  ```

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
