// golive-helper: headless native helper.
//
//	GStreamer (screen capture + AV1 encode, ONCE)  ->  loopback TCP  ->  this process
//	this process: AV1 OBU -> RTP packets -> one shared track -> N pion PeerConnections (P2P, STUN)
//
// It keeps one outbound WebSocket to the signaling server; that socket carries presence,
// host commands (start/stop) and the SDP/ICE exchange with every viewer.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	randv2 "math/rand/v2"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

func logf(f string, a ...any) { log.Printf(f, a...) }

var stunServers = []string{
	"stun:stun.l.google.com:19302",
	"stun:stun1.l.google.com:19302",
	"stun:stun.cloudflare.com:3478",
	"stun:stun.nextcloud.com:443",
}

type peer struct {
	id      string
	pc      *webrtc.PeerConnection
	ready   chan struct{} // closed once the offer has been sent
	mu      sync.Mutex
	sender  *webrtc.RTPSender
	pending []webrtc.ICECandidateInit
	hasRem  bool
	// connection state (updated by state callbacks; read under mu)
	state  string
	path   string
	reason string
	// candidate diagnostics (under mu)
	localCands []string // candidate types we gathered (host / srflx / prflx / relay)
	remCands   []string // candidate types the viewer signaled
	// timing (all under mu)
	createdAt        time.Time // NewPeerConnection
	offerAt          time.Time // offer sent to viewer
	gatherCompleteAt time.Time // ICE gathering complete
	connectAt        time.Time // PeerConnectionStateConnected
	failAt           time.Time // PeerConnectionStateFailed
	// stats (under mu, refreshed by rtcpLoop)
	rttMs    int
	loss     uint32 // cumulative RTP packets lost, from viewer Receiver Reports
	jitterMs int
}

type helper struct {
	server, room, key string
	defaults          captureOpts

	api   *webrtc.API
	track *webrtc.TrackLocalStaticRTP

	wsMu sync.Mutex
	ws   *websocket.Conn

	mu    sync.Mutex
	peers map[string]*peer

	capMu   sync.Mutex
	cap     *capture
	capOpts captureOpts
	capErr  string

	pkt    packetizer
	t0     time.Time
	bytes  int64 // encoded bytes since last stats tick (atomic-ish, guarded by statMu)
	statMu sync.Mutex
	kbps   int
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	var (
		server    = flag.String("server", envOr("GOLIVE_SERVER", "wss://golive.puhl.dev"), "signaling server base URL (ws:// or wss://, http(s) also accepted); GOLIVE_SERVER env override")
		room      = flag.String("room", "", "room id (default: generated once and remembered)")
		key       = flag.String("key", "", "host key (default: generated once and remembered)")
		enc       = flag.String("encoder", "auto", "auto | svt | nv | qsv | va | amf")
		kbps      = flag.Int("bitrate", 4000, "default bitrate, kbit/s")
		fps       = flag.Int("fps", 30, "default framerate")
		source    = flag.String("source", "", `capture source: "" = screen, "test" = test pattern, or a raw GStreamer source fragment`)
		autostart = flag.Bool("autostart", false, "start streaming as soon as connected")
		rc        = flag.String("rc", "lcvbr", "amf rate control: default | cqp | lcvbr | vbr | cbr")
		usage     = flag.String("usage", "low-latency", "amf usage: low-latency | transcoding")
		tray      = flag.Bool("tray", false, "run with a system tray icon (open host page, copy link, pairing code, start/stop, quit); off = plain console. Auto-enabled when no console is attached (packaged build); logs then go to %APPDATA%\\golive\\helper.log")
	)
	flag.Parse()

	// An explicit -tray value always wins. With none given, tray auto-enables when this
	// process has no console window — the packaged build is linked as a GUI subsystem
	// (-H=windowsgui) and would otherwise be an invisible process with no UI at all.
	explicit := map[string]bool{}
	flag.Visit(func(f *flag.Flag) { explicit[f.Name] = true })
	guiHidden := runtime.GOOS == "windows" && !consoleVisible()
	if f := openLogFile(); f != nil && (guiHidden || *tray) {
		defer f.Close()
		// File FIRST, stderr best-effort: io.MultiWriter stops at the first erroring writer,
		// and a GUI-subsystem process has no usable stderr once the launcher detaches — that
		// used to silently starve the log file after the first few lines.
		log.SetOutput(io.MultiWriter(f, os.Stderr))
	}

	r, k := loadIdentity(*room, *key)
	h := &helper{
		server: strings.NewReplacer("http://", "ws://", "https://", "wss://").Replace(strings.TrimRight(*server, "/")),
		room:   r, key: k,
		defaults: captureOpts{Source: *source, Encoder: *enc, Bitrate: *kbps, FPS: *fps,
			RateControl: *rc, Usage: *usage},
		peers: map[string]*peer{},
		pkt:   packetizer{seq: uint16(time.Now().UnixNano()), maxPayload: 1100},
		t0:    time.Now(),
	}
	h.setupWebRTC()

	// Tray mode owns the main goroutine (systray needs its message loop there) and boots the
	// signaling/streaming loop in the background. Console mode boots inline.
	if wantTray(*tray, explicit["tray"], !guiHidden) && runtime.GOOS == "windows" {
		serveTray(h, func() { boot(h, *autostart) })
		return
	}
	boot(h, *autostart)
}

// wantTray decides whether tray mode is active. An explicit -tray flag wins; without one,
// tray is the default whenever no console is attached (the packaged GUI build), so a bare
// double-click of the exe still presents the tray UI.
func wantTray(flagVal, explicit, hasConsole bool) bool {
	if explicit {
		return flagVal
	}
	return !hasConsole
}

// boot runs everything the helper does once identity + WebRTC are ready: print the link,
// start the pairing-code refresh, the stats loop, autostart, and the reconnect loop.
func boot(h *helper, autostart bool) {
	httpBase := strings.NewReplacer("ws://", "http://", "wss://", "https://").Replace(h.server)
	logf("viewer link: %s/watch/%s", httpBase, h.room)
	logf("host page : %s/host/%s?key=%s", httpBase, h.room, h.key)

	h.startPairRefresh()
	go h.statsLoop()
	if autostart {
		go func() { time.Sleep(time.Second); h.start(h.defaults) }()
	}
	h.run()
}

func loadIdentity(room, key string) (string, string) {
	dir, _ := os.UserConfigDir()
	f := filepath.Join(dir, "golive", "identity")
	haveFile := false
	if b, err := os.ReadFile(f); err == nil {
		if p := strings.Fields(string(b)); len(p) == 2 {
			haveFile = true
			if room == "" {
				room = p[0]
			}
			if key == "" {
				key = p[1]
			}
		}
	}
	rnd := func(n int) string { b := make([]byte, n); rand.Read(b); return hex.EncodeToString(b) }
	generated := false
	if room == "" {
		room = rnd(5) // 10 chars
		generated = true
	}
	if key == "" {
		key = rnd(8)
		generated = true
	}
	// Persist only identities that were generated here (no file, or only flag-less first
	// run). Explicit -room/-key flags are a transient override and must never overwrite the
	// stored identity — otherwise one off-run would silently rebrand the user's room.
	if generated && !haveFile {
		os.MkdirAll(filepath.Dir(f), 0o700)
		os.WriteFile(f, []byte(room+" "+key), 0o600)
	}
	return room, key
}

func (h *helper) setupWebRTC() {
	me := &webrtc.MediaEngine{}
	err := me.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:     webrtc.MimeTypeAV1,
			ClockRate:    90000,
			RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}},
		},
		PayloadType: 96,
	}, webrtc.RTPCodecTypeVideo)
	if err != nil {
		log.Fatal(err)
	}
	ir := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(me, ir); err != nil {
		log.Fatal(err)
	}
	h.api = webrtc.NewAPI(webrtc.WithMediaEngine(me), webrtc.WithInterceptorRegistry(ir))
	h.track, err = webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeAV1, ClockRate: 90000}, "video", "golive")
	if err != nil {
		log.Fatal(err)
	}
}

// ---------------------------------------------------------------- signaling connection

func (h *helper) run() {
	backoff := time.Second
	for {
		started := time.Now()
		err := h.session()
		logf("disconnected from server: %v (retrying in %s)", err, backoff)
		h.closeAllPeers()
		if time.Since(started) > 30*time.Second {
			backoff = time.Second
		}
		// ±250 ms jitter so multiple helpers don't reconnect in lockstep
		jitter := time.Duration(randv2.Int64N(500)*int64(time.Millisecond)) - 250*time.Millisecond
		time.Sleep(backoff + jitter)
		if backoff < 15*time.Second {
			backoff *= 2
		}
	}
}

func (h *helper) session() error {
	u := fmt.Sprintf("%s/ws?role=helper&room=%s&key=%s", h.server, url.QueryEscape(h.room), url.QueryEscape(h.key))
	ws, resp, err := websocket.DefaultDialer.Dial(u, nil)
	if err != nil {
		if resp != nil {
			return fmt.Errorf("%v (HTTP %d)", err, resp.StatusCode)
		}
		return err
	}
	defer ws.Close()
	ws.SetReadDeadline(time.Now().Add(70 * time.Second))
	ws.SetPingHandler(func(d string) error {
		ws.SetReadDeadline(time.Now().Add(70 * time.Second))
		h.wsMu.Lock()
		defer h.wsMu.Unlock()
		return ws.WriteControl(websocket.PongMessage, []byte(d), time.Now().Add(5*time.Second))
	})
	h.wsMu.Lock()
	h.ws = ws
	h.wsMu.Unlock()
	logf("connected to %s as helper for room %s", h.server, h.room)
	h.refreshPair() // (re)connect to the server => the room is registered again; mint a live pairing code
	h.sendStatus()

	for {
		var m struct {
			Type   string          `json:"type"`
			Viewer string          `json:"viewer"`
			Cmd    string          `json:"cmd"`
			Data   json.RawMessage `json:"data"`
			Params struct {
				Bitrate int    `json:"bitrate"`
				FPS     int    `json:"fps"`
				Gop     int    `json:"gop"` // keyframe interval in seconds (0 = default 1s)
				Monitor int    `json:"monitor"`
				Source  string `json:"source"` // "" = screen, "test" = test pattern
			} `json:"params"`
		}
		if err := ws.ReadJSON(&m); err != nil {
			return err
		}
		switch m.Type {
		case "viewer-join":
			go h.addViewer(m.Viewer)
		case "viewer-leave":
			h.removeViewer(m.Viewer)
		case "signal":
			h.onSignal(m.Viewer, m.Data)
		case "cmd":
			switch m.Cmd {
			case "start":
				o := h.defaults
				if m.Params.Bitrate > 0 {
					o.Bitrate = m.Params.Bitrate
				}
				if m.Params.FPS > 0 {
					o.FPS = m.Params.FPS
				}
				if m.Params.Source != "" {
					o.Source = m.Params.Source
				}
				if m.Params.Gop > 0 {
					o.GOP = o.FPS * m.Params.Gop // seconds -> frames
				}
				o.Monitor = m.Params.Monitor
				go h.start(o)
			case "stop":
				go h.stop()
			case "list-sources":
				go func() {
					h.send(map[string]any{"type": "sources", "data": map[string]any{"sources": enumMonitors()}})
				}()
			}
		}
	}
}

func (h *helper) send(v any) {
	h.wsMu.Lock()
	defer h.wsMu.Unlock()
	if h.ws == nil {
		return
	}
	h.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if err := h.ws.WriteJSON(v); err != nil {
		h.ws.Close()
	}
}

func (h *helper) sendToViewer(id string, data any) {
	h.send(map[string]any{"type": "to-viewer", "viewer": id, "data": data})
}

// isStreaming reports whether a capture pipeline is currently running — the single source
// of truth for start/stop UI (host page, tray toggle).
func (h *helper) isStreaming() bool {
	h.capMu.Lock()
	defer h.capMu.Unlock()
	return h.cap != nil
}

func (h *helper) sendStatus() {
	h.capMu.Lock()
	streaming := h.cap != nil
	enc, errStr, o := "", h.capErr, h.capOpts
	if streaming {
		enc = h.cap.Encoder
	}
	h.capMu.Unlock()

	h.mu.Lock()
	viewers := []map[string]any{}
	for _, p := range h.peers {
		p.mu.Lock()
		viewers = append(viewers, map[string]any{
			"id": p.id, "state": p.state, "path": p.path, "reason": p.reason,
			"rttMs": p.rttMs, "loss": p.loss, "jitterMs": p.jitterMs,
			"gatherMs":  msSince(p.createdAt, p.gatherCompleteAt),
			"checkMs":   msSince(p.offerAt, p.connectAt),
			"connectMs": msSince(p.createdAt, p.connectAt),
			"cands":     "local " + candCounts(p.localCands) + " / viewer " + candCounts(p.remCands),
		})
		p.mu.Unlock()
	}
	h.mu.Unlock()
	h.statMu.Lock()
	kbps := h.kbps
	h.statMu.Unlock()

	h.send(map[string]any{
		"type": "status", "streaming": streaming, "encoder": enc, "error": errStr,
		"bitrate": o.Bitrate, "fps": o.FPS, "actualKbps": kbps, "viewers": viewers,
	})
}

func (h *helper) statsLoop() {
	t := time.NewTicker(2 * time.Second)
	for range t.C {
		h.statMu.Lock()
		h.kbps = int(h.bytes * 8 / 1000 / 2)
		h.bytes = 0
		h.statMu.Unlock()
		// per-viewer stats come from RTCP Receiver Reports (see rtcpLoop); no extra
		// polling here — the SRs pion generates make the RTT measurement valid.
		h.sendStatus()
	}
}

func msSince(from, to time.Time) int {
	if from.IsZero() || to.IsZero() || to.Before(from) {
		return -1
	}
	return int(to.Sub(from).Milliseconds())
}

// ---------------------------------------------------------------- capture control

func (h *helper) start(o captureOpts) {
	h.stop()
	if o.GOP == 0 {
		o.GOP = o.FPS // ~1 keyframe/second: this is how late-joining viewers get picture
	}
	h.capMu.Lock()
	h.capErr = ""
	h.capMu.Unlock()
	c, err := startCapture(o, h.onFrame, func(err error) {
		logf("%v", err)
		h.capMu.Lock()
		h.cap, h.capErr = nil, err.Error()
		h.capMu.Unlock()
		h.sendStatus()
	})
	h.capMu.Lock()
	if err != nil {
		h.capErr = err.Error()
		logf("start failed: %v", err)
	} else {
		h.cap, h.capOpts = c, o
		logf("streaming with %s encoder, %d kbit/s, %d fps", c.Encoder, o.Bitrate, o.FPS)
	}
	h.capMu.Unlock()
	h.sendStatus()
}

func (h *helper) stop() {
	h.capMu.Lock()
	c := h.cap
	h.cap = nil
	h.capMu.Unlock()
	if c != nil {
		c.Stop()
		<-c.done
		logf("stopped")
	}
	h.sendStatus()
}

// onFrame runs for every encoded frame: ONE encode, packetized ONCE, written to the single
// shared track. pion's TrackLocalStaticRTP then copies each packet to every viewer's
// PeerConnection (rewriting SSRC/payload type per viewer), so N viewers cost N sends and 0 encodes.
func (h *helper) onFrame(u []obu) {
	ts := uint32(time.Since(h.t0).Seconds() * 90000) // wall-clock: continuous across stop/start
	n := 0
	for _, p := range h.pkt.packetize(u, ts) {
		n += len(p.Payload)
		h.track.WriteRTP(p)
	}
	h.statMu.Lock()
	h.bytes += int64(n)
	h.statMu.Unlock()
}

// ---------------------------------------------------------------- viewers (one PeerConnection each)

func (h *helper) addViewer(id string) {
	h.removeViewer(id) // idempotent: a rejoin replaces the old connection

	pc, err := h.api.NewPeerConnection(webrtc.Configuration{
		ICEServers:         []webrtc.ICEServer{{URLs: stunServers}},
		ICETransportPolicy: webrtc.ICETransportPolicyAll, // direct first; TURN (later) is just another candidate
	})
	if err != nil {
		logf("viewer %s: %v", id, err)
		return
	}
	p := &peer{id: id, pc: pc, ready: make(chan struct{}), state: "new", createdAt: time.Now()}
	sender, err := pc.AddTrack(h.track)
	if err != nil {
		logf("viewer %s: %v", id, err)
		pc.Close()
		return
	}
	p.sender = sender
	go h.rtcpLoop(p) // RTCP must be read for NACK/reports to work; also gives us loss/jitter

	pc.OnICEGatheringStateChange(func(s webrtc.ICEGatheringState) {
		if s == webrtc.ICEGatheringStateComplete {
			p.mu.Lock()
			p.gatherCompleteAt = time.Now()
			p.mu.Unlock()
		}
	})
	pc.OnICECandidate(func(c *webrtc.ICECandidate) { // full trickle: send every candidate immediately
		if c == nil {
			return
		}
		p.mu.Lock()
		p.localCands = append(p.localCands, c.Typ.String())
		p.mu.Unlock()
		init := c.ToJSON()
		go func() {
			<-p.ready
			h.sendToViewer(id, map[string]any{"candidate": init})
		}()
	})
	pc.OnICEConnectionStateChange(func(s webrtc.ICEConnectionState) {
		logf("viewer %s: ICE %s", id, s)
	})
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		p.mu.Lock()
		p.state = s.String()
		switch s {
		case webrtc.PeerConnectionStateConnected:
			p.connectAt, p.reason = time.Now(), ""
		case webrtc.PeerConnectionStateDisconnected:
			p.reason = "disconnected"
		case webrtc.PeerConnectionStateFailed:
			p.reason = "direct connection failed (no route; TURN is v2+)"
			p.failAt = time.Now()
		case webrtc.PeerConnectionStateClosed:
			p.reason = "closed"
		}
		p.mu.Unlock()
		switch s {
		case webrtc.PeerConnectionStateConnected:
			if pair, err := sender.Transport().ICETransport().GetSelectedCandidatePair(); err == nil && pair != nil {
				path := describePath(pair.Local.Typ, pair.Remote.Typ)
				p.mu.Lock()
				p.path = path
				p.mu.Unlock()
				logf("viewer %s: connected via %s (local %s %s:%d <-> remote %s %s:%d)", id, path,
					pair.Local.Typ, pair.Local.Address, pair.Local.Port, pair.Remote.Typ, pair.Remote.Address, pair.Remote.Port)
			}
		case webrtc.PeerConnectionStateFailed:
			p.mu.Lock()
			diag := p.failDiagLocked()
			p.mu.Unlock()
			logf("viewer %s: FAILED - direct connection impossible (no relay in v1): %s", id, diag)
			h.sendToViewer(id, map[string]any{
				"error": "Direct connection failed — no direct route found to this viewer. golive v1 is direct-only (no relay); it will retry automatically if you reconnect.",
				"diag":  diag,
			})
			h.removeViewer(id)
		}
		h.sendStatus()
	})

	h.mu.Lock()
	h.peers[id] = p
	h.mu.Unlock()

	offer, err := pc.CreateOffer(nil)
	if err == nil {
		err = pc.SetLocalDescription(offer)
	}
	if err != nil {
		logf("viewer %s: offer: %v", id, err)
		h.removeViewer(id)
		return
	}
	p.mu.Lock()
	p.offerAt = time.Now()
	p.mu.Unlock()
	h.sendToViewer(id, map[string]any{"sdp": pc.LocalDescription()})
	close(p.ready)
	logf("viewer %s: offer sent", id)
	h.sendStatus()
}

func describePath(local, remote webrtc.ICECandidateType) string {
	if local == webrtc.ICECandidateTypeRelay || remote == webrtc.ICECandidateTypeRelay {
		return "TURN relay"
	}
	for _, t := range []webrtc.ICECandidateType{webrtc.ICECandidateTypePrflx, webrtc.ICECandidateTypeSrflx} {
		if local == t || remote == t {
			return "direct " + t.String()
		}
	}
	return "direct host"
}

func (h *helper) onSignal(id string, raw json.RawMessage) {
	var d struct {
		SDP       *webrtc.SessionDescription `json:"sdp"`
		Candidate *webrtc.ICECandidateInit   `json:"candidate"`
	}
	if json.Unmarshal(raw, &d) != nil {
		return
	}
	h.mu.Lock()
	p := h.peers[id]
	h.mu.Unlock()
	if p == nil {
		return
	}
	switch {
	case d.SDP != nil && d.SDP.Type == webrtc.SDPTypeAnswer:
		if err := p.pc.SetRemoteDescription(*d.SDP); err != nil {
			logf("viewer %s: answer: %v", id, err)
			return
		}
		p.mu.Lock()
		p.hasRem = true
		pend := p.pending
		p.pending = nil
		p.mu.Unlock()
		for _, c := range pend {
			p.pc.AddICECandidate(c)
		}
	case d.Candidate != nil:
		typ := candType(d.Candidate.Candidate)
		p.mu.Lock()
		p.remCands = append(p.remCands, typ)
		if !p.hasRem {
			p.pending = append(p.pending, *d.Candidate)
			p.mu.Unlock()
			return
		}
		p.mu.Unlock()
		if err := p.pc.AddICECandidate(*d.Candidate); err != nil {
			logf("viewer %s: candidate: %v", id, err)
		}
	}
}

// candType extracts the candidate type ("host", "srflx", "prflx", "relay") from a
// SDP candidate line, e.g. "candidate:1 1 UDP 2122252543 100.85.80.7 58857 typ host ...".
func candType(line string) string {
	if i := strings.Index(line, "typ "); i >= 0 {
		rest := line[i+4:]
		if j := strings.IndexByte(rest, ' '); j >= 0 {
			rest = rest[:j]
		}
		return rest
	}
	return "?"
}

// candCounts renders a candidate-type histogram: "host 3, srflx 2".
func candCounts(types []string) string {
	c := map[string]int{}
	for _, t := range types {
		c[t]++
	}
	parts := []string{}
	for _, t := range []string{"host", "srflx", "prflx", "relay"} {
		if c[t] > 0 {
			parts = append(parts, fmt.Sprintf("%s %d", t, c[t]))
		}
	}
	if len(parts) == 0 {
		return "none"
	}
	return strings.Join(parts, ", ")
}

func hasSrflx(types []string) bool {
	for _, t := range types {
		if t == "srflx" {
			return true
		}
	}
	return false
}

// failDiagLocked explains a failed direct connection from the candidate evidence.
// Caller holds p.mu.
func (p *peer) failDiagLocked() string {
	parts := []string{fmt.Sprintf("our candidates: %d (%s)", len(p.localCands), candCounts(p.localCands))}
	parts = append(parts, fmt.Sprintf("viewer candidates: %d (%s)", len(p.remCands), candCounts(p.remCands)))
	if t := msSince(p.offerAt, p.failAt); t >= 0 {
		parts = append(parts, fmt.Sprintf("ICE ran %d ms", t))
	}
	if t := msSince(p.createdAt, p.gatherCompleteAt); t >= 0 {
		parts = append(parts, fmt.Sprintf("gathered in %d ms", t))
	}
	switch {
	case len(p.remCands) == 0:
		parts = append(parts, "viewer sent no ICE candidates at all")
	case !hasSrflx(p.remCands):
		parts = append(parts, "viewer side learned no server-reflexive address (STUN/UDP restricted there)")
	case !hasSrflx(p.localCands):
		parts = append(parts, "our side learned no server-reflexive address (STUN/UDP restricted here)")
	default:
		parts = append(parts, "both sides reach STUN but the NATs did not mutual-hole-punch (symmetric/CGNAT usually)")
	}
	return strings.Join(parts, "; ")
}

// rtcpLoop drains the viewer's RTCP so NACK/reports work, and keeps per-viewer
// stats fresh from the viewer's Receiver Reports: RTT (computed against the Sender
// Reports pion generates for us), cumulative loss, and jitter.
func (h *helper) rtcpLoop(p *peer) {
	for {
		pkts, _, err := p.sender.ReadRTCP()
		if err != nil {
			return
		}
		now := ntpMid(time.Now())
		for _, pkt := range pkts {
			if rr, ok := pkt.(*rtcp.ReceiverReport); ok {
				for _, rep := range rr.Reports {
					p.mu.Lock()
					if rep.LastSenderReport != 0 {
						rtt := now - rep.LastSenderReport - rep.Delay // 1/65536 s units
						p.rttMs = int(rtt) * 1000 / 65536
					}
					p.loss = rep.TotalLost
					p.jitterMs = int(rep.Jitter / 90) // 90 kHz RTP clock -> ms
					p.mu.Unlock()
				}
			}
		}
	}
}

// ntpMid returns the middle 32 bits of the 64-bit NTP timestamp for now, the unit
// used by RTCP LastSenderReport / Delay fields (1/65536 s).
func ntpMid(t time.Time) uint32 {
	sec := uint64(t.Unix() + 2208988800)               // seconds since 1900
	frac := uint64(t.Nanosecond()) * (1 << 32) / 1e9   // 32-bit fraction
	return uint32((sec&0xffff)<<16) | uint32(frac>>16) // middle 32 bits
}

func (h *helper) removeViewer(id string) {
	h.mu.Lock()
	p := h.peers[id]
	delete(h.peers, id)
	h.mu.Unlock()
	if p != nil {
		p.pc.Close()
		logf("viewer %s: removed", id)
		go h.sendStatus()
	}
}

func (h *helper) closeAllPeers() {
	h.mu.Lock()
	ps := h.peers
	h.peers = map[string]*peer{}
	h.mu.Unlock()
	for _, p := range ps {
		p.pc.Close()
	}
}
