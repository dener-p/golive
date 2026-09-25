# golive (minimal build)

This is a stripped-down implementation of the `golive` spec, covering **only the hard
part**: native capture → AV1 encode → P2P WebRTC to N viewers, with a thin signaling
relay. Everything called out as skippable is skipped:

- **No auth.** Rooms are protected by an unguessable room id + a helper "key" printed to
  the console, nothing more.
- **No TURN.** STUN only. If direct connectivity can't be established, the viewer sees a
  clear error ("Direct connection failed…") instead of silently failing — that's the one
  piece of the TURN-related spec that's cheap to keep and worth keeping.
- **No pairing codes, no tray icon.** Host identity is the printed room key + optional
  Discord OAuth binding (see `DISCORD-AUTH.md`) on the `feature/discord-oauth` branch.

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

## Distribution to users (v1)

The v1 delivery model is **one operator-hosted server**; viewers need nothing, and hosts get
a single self-contained Windows download. The helper's default `-server` is the public
signaling URL (`wss://golive.puhl.dev/ws`), overridable with `-server` or the
`GOLIVE_SERVER` env var for private/self-hosted instances.

What the helper resolves and bundles (see `helper/pipeline.go`):

- It looks for a GStreamer runtime **next to its own executable** (`<exe>/gstreamer/bin/…`)
  before falling back to PATH — so the download is fully portable. When the bundled runtime
  is used it sets `GST_PLUGIN_SYSTEM_PATH` / `GST_PLUGIN_SCANNER` so the relocated install
  finds its own plugins.
- Encoder auto-select covers the field: `amfav1enc` (AMD) → `nvav1enc`/`qsvav1enc`/`vaav1enc`
  (when those elements exist on the machine) → `svtav1enc` (software, any CPU). All AV1.

Packaging (`packaging/`):

```powershell
powershell -ExecutionPolicy Bypass -File packaging\build-bundle.ps1
```

This builds the helper, assembles `dist/golive/` = helper + pruned GStreamer runtime + license
notices, zips a portable build, and — if [Inno Setup 6](https://jrsoftware.org/isinfo.php) is
installed — compiles `golive-setup-<ver>.exe`. Artifacts + `latest.json` are published to
`server/public/helper/` (gitignored) and served by the backend at `/api/helper/latest` and
`/api/helper/download`; the landing page at `/` links them.

Once running, the helper (packaged build) lives in the **system tray** (`-tray`): Open host
page, Copy viewer link, Start/Stop, Quit — and it shows a live **pairing code**. On
`golive.puhl.dev/host/<room>` a host signs in with Discord and types that code to bind the room
to their account, no printed key required (see `DISCORD-AUTH.md` §6.1). Console mode
(`-tray` off) still prints the viewer/host links as before.

Known release to-dos: Windows code-signing (SmartScreen warning otherwise) and publishing the
installer build on the live server.

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
6. **Encoder tuning pass**: the AMF pipeline now runs `usage=low-latency rate-control=lcvbr
   bitrate=<target> max-bitrate=<target>`, keyframe interval is user-tunable (1/2/4 s in the
   host UI), and the fallback SVT path got `max-bitrate` + verified. Round-trips were
   checked by decoding the encoder's own output back (`amfav1enc → av1parse → dav1ddec`):
   the live 1080p screen decodes to real, detailed frames (confirmed by pixel content of the
   decoded PNGs), and the bitrate matrix above was measured on-wire per config.

```
2026/09/25 viewer v1: connected via direct prflx (local host fdfd::1aba:db37:55921 <-> remote prflx fdfd::1aba:db37:55945)
RESULT viewer=2ea81f3707 direct=true connectedMs=1263 rtpPkts=1171 keyframes=4 rate=195 pps
```

What I still cannot verify here: an actual browser tab decoding AV1 via WebCodecs/WebRTC
(needs you to open the viewer link in a real Chrome). Real-world NAT combinations are
exercised with the NAT test matrix (`matrix/`): the signaling server is publicly reachable
at `https://golive.puhl.dev` (tunneled to this box), media stays P2P, and
`tools/webrtc-check` measures direct-vs-failed from any network. One-command runner:

    .\matrix\run.ps1 -Server https://golive.puhl.dev -Room <room> -Label "B=phone-hotspot-4g" -Key <key>

Rows are appended to `matrix/RESULTS.md`; see `matrix/README.md` for the procedure and
how to read the rows. Fan-out scaling (M4 exit: single encode through ~10 viewers) is
exercised with `.\matrix\soak.ps1 -Viewers 10 -Seconds 20` against the live room;
results land in `matrix/SOAK-RESULTS.md`.

## Encoder defaults & tuning (measured on the RX 9060 XT)

The helper ships tuned live-streaming defaults and the tuning knobs the pass used:

- `-rc` — AMF rate-control: `default | cqp | lcvbr | vbr | cbr` (default `lcvbr`)
- `-usage` — AMF usage: `low-latency | transcoding` (default `low-latency`)
- Keyframe interval is a host-UI control (1/2/4 s), relayed as `params.gop` → `GOP = fps × sec`

Measured end-to-end (helper → RTP → `tools/webrtc-check`, 1080p30 @ "4000 kbit/s", 1 s keyframes):

| content | AMF lcvbr + low-latency (default) | AMF cbr | AMF vbr / cbr+transcoding | SVT preset 10 |
|---|---|---|---|---|
| real desktop (mostly static UI) | ~0.7 Mbps, briefly ~3.8 on busy UI | — | — | — |
| moving-ball test pattern | ~120 kbps | ~121 kbps | ~115–121 kbps | — |
| random noise ("snow") stress | ~20–29 Mbps | ~20–23 Mbps | ~20–23 Mbps | ~13.5–18 Mbps (~2.5 CPU cores) |

Keyframes landed at the configured 1/s interval in every configuration. What this says
(and the honest caveat that goes with it):

- **Static/desktop screens are cheap.** The default `lcvbr` mode sits far below the target
  on real desktop content, so the host UI's "bitrate × viewers" upload estimate is an upper
  bound in practice — the encoder does not pad static scenes with filler (the "undershoot"
  seen earlier is content-driven, not a bug).
- **On this AMF driver the bitrate target is a quality hint, not a hard cap.** Every
  rate-control mode blew past "4000 kbit/s" to ~20 Mbps on a random-noise stress pattern
  (SVT overshoots less, ~13.5–18 Mbps, at real CPU cost). For real desktop use this is an
  edge case — the worst thing measured on the actual screen was ~3.8 Mbps — but streaming
  genuinely busy content (fast fullscreen video/games) through this build needs an upload
  budget: lower FPS (host UI) or `-rc`/resolution.
- `usage=low-latency` works on this driver and is the default. `-rc default -usage transcoding`
  reproduces the old behavior rate-for-rate on the same content (the RC knob is a hint, not
  the thing that kept rates low).

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
