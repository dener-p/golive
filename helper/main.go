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
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/interceptor"
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
	pending []webrtc.ICECandidateInit
	hasRem  bool
	state   string
	path    string
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

func main() {
	var (
		server    = flag.String("server", "ws://localhost:8080", "signaling server base URL (ws:// or wss://, http(s) also accepted)")
		room      = flag.String("room", "", "room id (default: generated once and remembered)")
		key       = flag.String("key", "", "host key (default: generated once and remembered)")
		enc       = flag.String("encoder", "auto", "auto | svt | nv | qsv | va | amf")
		kbps      = flag.Int("bitrate", 4000, "default bitrate, kbit/s")
		fps       = flag.Int("fps", 30, "default framerate")
		source    = flag.String("source", "", `capture source: "" = screen, "test" = test pattern, or a raw GStreamer source fragment`)
		autostart = flag.Bool("autostart", false, "start streaming as soon as connected")
	)
	flag.Parse()

	r, k := loadIdentity(*room, *key)
	h := &helper{
		server: strings.NewReplacer("http://", "ws://", "https://", "wss://").Replace(strings.TrimRight(*server, "/")),
		room:   r, key: k,
		defaults: captureOpts{Source: *source, Encoder: *enc, Bitrate: *kbps, FPS: *fps},
		peers:    map[string]*peer{},
		pkt:      packetizer{seq: uint16(time.Now().UnixNano()), maxPayload: 1100},
		t0:       time.Now(),
	}
	h.setupWebRTC()

	httpBase := strings.NewReplacer("ws://", "http://", "wss://", "https://").Replace(h.server)
	fmt.Printf("\n  Viewer link : %s/watch/%s\n  Host page   : %s/host/%s?key=%s\n\n", httpBase, h.room, httpBase, h.room, h.key)

	go h.statsLoop()
	if *autostart {
		go func() { time.Sleep(time.Second); h.start(h.defaults) }()
	}
	h.run()
}

func loadIdentity(room, key string) (string, string) {
	dir, _ := os.UserConfigDir()
	f := filepath.Join(dir, "golive", "identity")
	if b, err := os.ReadFile(f); err == nil {
		if p := strings.Fields(string(b)); len(p) == 2 {
			if room == "" {
				room = p[0]
			}
			if key == "" {
				key = p[1]
			}
		}
	}
	rnd := func(n int) string { b := make([]byte, n); rand.Read(b); return hex.EncodeToString(b) }
	if room == "" {
		room = rnd(5) // 10 chars
	}
	if key == "" {
		key = rnd(8)
	}
	os.MkdirAll(filepath.Dir(f), 0o700)
	os.WriteFile(f, []byte(room+" "+key), 0o600)
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
		logf("disconnected from server: %v", err)
		h.closeAllPeers()
		if time.Since(started) > 30*time.Second {
			backoff = time.Second
		}
		time.Sleep(backoff)
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
	h.sendStatus()

	for {
		var m struct {
			Type   string          `json:"type"`
			Viewer string          `json:"viewer"`
			Cmd    string          `json:"cmd"`
			Data   json.RawMessage `json:"data"`
			Params struct {
				Bitrate int `json:"bitrate"`
				FPS     int `json:"fps"`
				Monitor int `json:"monitor"`
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
				o.Monitor = m.Params.Monitor
				go h.start(o)
			case "stop":
				go h.stop()
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

func (h *helper) sendStatus() {
	h.capMu.Lock()
	streaming := h.cap != nil
	enc, errStr, o := "", h.capErr, h.capOpts
	if streaming {
		enc = h.cap.Encoder
	}
	h.capMu.Unlock()

	h.mu.Lock()
	viewers := []map[string]string{}
	for _, p := range h.peers {
		p.mu.Lock()
		viewers = append(viewers, map[string]string{"id": p.id, "state": p.state, "path": p.path})
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
		h.sendStatus()
	}
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
	p := &peer{id: id, pc: pc, ready: make(chan struct{}), state: "new"}
	sender, err := pc.AddTrack(h.track)
	if err != nil {
		logf("viewer %s: %v", id, err)
		pc.Close()
		return
	}
	go func() { // RTCP must be read for NACK/reports to work
		buf := make([]byte, 1500)
		for {
			if _, _, err := sender.Read(buf); err != nil {
				return
			}
		}
	}()

	pc.OnICECandidate(func(c *webrtc.ICECandidate) { // full trickle: send every candidate immediately
		if c == nil {
			return
		}
		go func() {
			<-p.ready
			h.sendToViewer(id, map[string]any{"candidate": c.ToJSON()})
		}()
	})
	pc.OnICEConnectionStateChange(func(s webrtc.ICEConnectionState) {
		logf("viewer %s: ICE %s", id, s)
	})
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		p.mu.Lock()
		p.state = s.String()
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
			logf("viewer %s: FAILED - direct connection impossible and no TURN configured", id)
			h.sendToViewer(id, map[string]any{"error": "Direct connection failed. The host needs to configure a TURN server for this network."})
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
		p.mu.Lock()
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
