// webrtc-check: dev-only "stand-in viewer". Connects to a golive room the same way a
// browser tab would (signaling via WS, WebRTC answer, trickle ICE), receives the AV1
// RTP stream, and prints connection diagnostics. No AV1 decoding — counting RTP packets
// and decoding are separate things; browsers decode, this measures reachability.
//
// Also opens a host-role socket (needs the room key) to print live host status,
// including the per-viewer diagnostics the helper now reports.
//
// Matrix mode: run the helper on one network, this tool on another, compare
// "direct vs failed". Use -label to tag which side this run came from and -json for a
// single machine-readable line (what matrix/run.ps1 parses).
//
//	go run ./tools/webrtc-check -server http://localhost:8080 -room <id> -key <hostKey>
//	go run ./tools/webrtc-check -server https://xxxx.trycloudflare.com -room <id> -label "B=phone-hotspot-4g" -json
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
)

func main() {
	server := flag.String("server", "http://localhost:8080", "signaling server base URL")
	room := flag.String("room", "", "room id")
	key := flag.String("key", "", "host key (needed for host-role status)")
	secs := flag.Int("seconds", 8, "how long to receive before disconnecting")
	label := flag.String("label", "", "free-text tag for this run (e.g. 'B=phone-hotspot-4g')")
	jsonOut := flag.Bool("json", false, "print RESULT as a single JSON line (what matrix/run.ps1 parses)")
	verbose := flag.Bool("verbose", false, "print gathered local candidates and the selected pair")
	noStun := flag.Bool("no-stun", false, "simulate a UDP-restricted network: gather host candidates only (no STUN)")
	anon := flag.Bool("anon", false, "anonymize RESULT before printing (strip addresses, keep types + counts)")
	flag.Parse()
	if *room == "" {
		log.Fatal("-room is required")
	}
	wsBase := strings.NewReplacer("http://", "ws://", "https://", "wss://").Replace(strings.TrimRight(*server, "/"))
	start := time.Now()

	// candidate / pair / state tracking for the matrix diagnostics
	dc := &diag{}

	// signaling socket (dialed below); writes are serialized because candidate
	// callbacks and the reader goroutine both write to it.
	var ws *websocket.Conn
	var wsMu sync.Mutex
	sendSignal := func(data any) {
		wsMu.Lock()
		defer wsMu.Unlock()
		if ws != nil {
			ws.WriteJSON(map[string]any{"type": "signal", "data": data})
		}
	}

	// Host role: prints live status (helper-supplied diagnostics).
	stopStatus := make(chan struct{})
	done := make(chan struct{})
	if *key != "" {
		go func() {
			defer close(done)
			u := fmt.Sprintf("%s/ws?role=host&room=%s&key=%s", wsBase, url.QueryEscape(*room), url.QueryEscape(*key))
			ws, _, err := websocket.DefaultDialer.Dial(u, nil)
			if err != nil {
				log.Printf("host role: %v", err)
				return
			}
			defer ws.Close()
			ticks := time.NewTicker(2 * time.Second)
			defer ticks.Stop()
			for {
				select {
				case <-stopStatus:
					return
				case <-ticks.C:
					if err := ws.WriteJSON(map[string]any{"type": "cmd", "cmd": "noop"}); err != nil {
						return
					}
				}
			}
		}()
		// separate goroutine to read status frames
		go func() {
			u := fmt.Sprintf("%s/ws?role=host&room=%s&key=%s", wsBase, url.QueryEscape(*room), url.QueryEscape(*key))
			ws, _, err := websocket.DefaultDialer.Dial(u, nil)
			if err != nil {
				return
			}
			defer ws.Close()
			ws.WriteJSON(map[string]any{"type": "cmd", "cmd": "list-sources"})
			for {
				var m map[string]any
				if err := ws.ReadJSON(&m); err != nil {
					return
				}
				switch m["type"] {
				case "status":
					b, _ := json.MarshalIndent(m, "", "  ")
					fmt.Printf("HOST STATUS\n%s\n", b)
				case "sources":
					b, _ := json.MarshalIndent(m, "", "  ")
					fmt.Printf("CAPTURE SOURCES\n%s\n", b)
				}
			}
		}()
		defer close(stopStatus)
	}

	// Viewer role.
	me := &webrtc.MediaEngine{}
	if err := me.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeAV1, ClockRate: 90000,
			RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}},
		},
		PayloadType: 96,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		log.Fatal(err)
	}
	ir := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(me, ir); err != nil {
		log.Fatal(err)
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(me), webrtc.WithInterceptorRegistry(ir))

	var (
		pkts   atomic.Int64
		byts   atomic.Int64
		keyf   atomic.Int64
		connAt atomic.Int64 // unix ms when connected
	)

	// candidate / pair / state tracking for the matrix diagnostics
	var iceServers []webrtc.ICEServer
	if !*noStun {
		iceServers = []webrtc.ICEServer{{URLs: []string{
			"stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478",
		}}}
	} else {
		fmt.Println("no-stun: gathering host candidates only (simulating a UDP-restricted network)")
	}
	pc, err := api.NewPeerConnection(webrtc.Configuration{
		ICEServers:         iceServers,
		ICETransportPolicy: webrtc.ICETransportPolicyAll,
	})
	if err != nil {
		log.Fatal(err)
	}

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		dc.addLocal(c)
		if *verbose {
			fmt.Printf("local %s %s:%d\n", c.Typ, c.Address, c.Port)
		}
		init := c.ToJSON()
		go func() {
			sendSignal(map[string]any{"candidate": init}) // full trickle, same as the browser tab
		}()
	})
	pc.OnICEConnectionStateChange(func(s webrtc.ICEConnectionState) {
		fmt.Printf("ICE: %s\n", s)
		dc.setIce(s.String())
	})
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		fmt.Printf("PC: %s\n", s)
		dc.setConn(s.String())
		if s == webrtc.PeerConnectionStateConnected {
			connAt.Store(time.Now().UnixMilli())
		}
	})
	pc.OnTrack(func(t *webrtc.TrackRemote, r *webrtc.RTPReceiver) {
		fmt.Printf("track: %s\n", t.Codec().MimeType)
		// poll the selected candidate pair off the receiving transport (same API the helper uses)
		if tr := r.Transport(); tr != nil {
			it := tr.ICETransport()
			if it != nil {
				go func() {
					for {
						if p, err := it.GetSelectedCandidatePair(); err == nil && p != nil {
							dc.setPair(p)
							if *verbose {
								fmt.Printf("pair selected: %s %s:%d <-> %s %s:%d\n", p.Local.Typ, p.Local.Address, p.Local.Port, p.Remote.Typ, p.Remote.Address, p.Remote.Port)
							}
						}
						time.Sleep(300 * time.Millisecond)
					}
				}()
			}
		}
		go func() {
			buf := make([]byte, 1500)
			for {
				n, _, err := t.Read(buf)
				if err != nil {
					return
				}
				if n > 12 && buf[12]&0x08 != 0 { // AV1 payload header, N bit = new coded video sequence
					keyf.Add(1)
				}
				byts.Add(int64(n))
				pkts.Add(1)
			}
		}()
	})

	u := fmt.Sprintf("%s/ws?role=viewer&room=%s", wsBase, url.QueryEscape(*room))
	if ws, _, err = websocket.DefaultDialer.Dial(u, nil); err != nil {
		log.Fatal(err)
	}
	defer ws.Close()

	remoteSet := false
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			var m struct {
				Type string          `json:"type"`
				Data json.RawMessage `json:"data"`
			}
			if err := ws.ReadJSON(&m); err != nil {
				return
			}
			if m.Type != "signal" {
				continue
			}
			var d struct {
				SDP       *webrtc.SessionDescription `json:"sdp"`
				Candidate *webrtc.ICECandidateInit   `json:"candidate"`
			}
			if json.Unmarshal(m.Data, &d) != nil {
				continue
			}
			switch {
			case d.SDP != nil && d.SDP.Type == webrtc.SDPTypeOffer:
				if err := pc.SetRemoteDescription(*d.SDP); err != nil {
					log.Printf("set remote: %v", err)
					continue
				}
				remoteSet = true
				ans, err := pc.CreateAnswer(nil)
				if err != nil {
					log.Printf("create answer: %v", err)
					continue
				}
				if err := pc.SetLocalDescription(ans); err != nil {
					log.Printf("set answer: %v", err)
					continue
				}
				sendSignal(map[string]any{"sdp": pc.LocalDescription()})
			case d.Candidate != nil && remoteSet:
				dc.addRemote(d.Candidate.Candidate)
				if *verbose {
					fmt.Printf("remote %s\n", d.Candidate.Candidate)
				}
				if err := pc.AddICECandidate(*d.Candidate); err != nil {
					log.Printf("add remote candidate: %v", err)
				}
			}
		}
	}()

	deadline := time.After(time.Duration(*secs) * time.Second)
	<-deadline

	ws.Close()
	pc.Close()
	<-readDone

	dur := time.Since(start).Seconds()
	direct := connAt.Load() > 0
	connMs := int64(0)
	if direct {
		connMs = connAt.Load() - start.UnixMilli()
	}
	r := result{
		Label:          *label,
		Room:           *room,
		Direct:         direct,
		ICEFinal:       dc.ice,
		ConnFinal:      dc.conn,
		Path:           dc.path(),
		Local:          dc.lcl(),
		Remote:         dc.rcl(),
		LocalCandidate: dc.localCands(),
		RemoteCands:    dc.remoteCands(),
		SrflxLearned:   dc.srflx,
		ConnectedMs:    connMs,
		RTPPkts:        pkts.Load(),
		Keyframes:      keyf.Load(),
		Bytes:          byts.Load(),
		Duration:       dur,
		PPS:            float64(pkts.Load()) / dur,
	}
	if *anon {
		r = r.anon()
	}
	if *jsonOut {
		b, _ := json.Marshal(r)
		fmt.Printf("RESULT %s\n", b)
	} else {
		extra := ""
		if r.Path != "" {
			extra += " path=" + r.Path
		}
		if r.Label != "" {
			extra += " label=" + r.Label
		}
		if r.ICEFinal != "" {
			extra += " ice=" + r.ICEFinal
		}
		if r.RemoteCands != "" {
			extra += " theirs=" + r.RemoteCands
		}
		fmt.Printf("RESULT viewer=%s direct=%v connectedMs=%d rtpPkts=%d keyframes=%d bytes=%d duration=%.1fs rate=%.0f pps%s\n",
			*room, direct, connMs, pkts.Load(), keyf.Load(), byts.Load(), dur, float64(pkts.Load())/dur, extra)
	}
	if pkts.Load() == 0 {
		os.Exit(1)
	}
}

// diag collects ICE state, candidates and the selected pair (all read at the end).
type diag struct {
	mu     sync.Mutex
	ice    string // final ICEConnectionState
	conn   string // final PeerConnectionState
	local  []string
	remote []string // remote candidate lines as received via signaling
	pair   string   // "<ltype> <laddr>:<lport> <-> <rtype> <raddr>:<rport>"
	lt, rt string   // selected pair types only
	laddr  string
	raddr  string
	srflx  bool // learned a server-reflexive local address
}

func (d *diag) setIce(s string)   { d.mu.Lock(); d.ice = s; d.mu.Unlock() }
func (d *diag) setConn(s string)  { d.mu.Lock(); d.conn = s; d.mu.Unlock() }
func (d *diag) addRemote(line string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.remote = append(d.remote, line)
}
func (d *diag) addLocal(c *webrtc.ICECandidate) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.local = append(d.local, fmt.Sprintf("%s %s:%d", c.Typ, c.Address, c.Port))
	if c.Typ == webrtc.ICECandidateTypeSrflx {
		d.srflx = true
	}
}
func (d *diag) setPair(p *webrtc.ICECandidatePair) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.lt, d.rt = p.Local.Typ.String(), p.Remote.Typ.String()
	d.laddr = fmt.Sprintf("%s:%d", p.Local.Address, p.Local.Port)
	d.raddr = fmt.Sprintf("%s:%d", p.Remote.Address, p.Remote.Port)
	d.pair = fmt.Sprintf("%s %s <-> %s %s", d.lt, d.laddr, d.rt, d.raddr)
}
func (d *diag) path() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.pair
}
func (d *diag) lcl() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.laddr
}
func (d *diag) rcl() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.raddr
}
func (d *diag) localCands() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.local) == 0 {
		return nil
	}
	out := make([]string, len(d.local))
	copy(out, d.local)
	return out
}

// remoteCands returns the candidate-type summary the remote signaled, e.g. "3 (host 1, srflx 2)".
func (d *diag) remoteCands() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.remote) == 0 {
		return "0 (none)"
	}
	host, srflx, prflx, relay := 0, 0, 0, 0
	for _, line := range d.remote {
		if i := strings.Index(line, "typ "); i >= 0 {
			rest := line[i+4:]
			if j := strings.IndexByte(rest, ' '); j >= 0 {
				rest = rest[:j]
			}
			switch rest {
			case "host":
				host++
			case "srflx":
				srflx++
			case "prflx":
				prflx++
			case "relay":
				relay++
			}
		}
	}
	parts := []string{}
	if host > 0 {
		parts = append(parts, fmt.Sprintf("host %d", host))
	}
	if srflx > 0 {
		parts = append(parts, fmt.Sprintf("srflx %d", srflx))
	}
	if prflx > 0 {
		parts = append(parts, fmt.Sprintf("prflx %d", prflx))
	}
	if relay > 0 {
		parts = append(parts, fmt.Sprintf("relay %d", relay))
	}
	if len(parts) == 0 {
		return fmt.Sprintf("%d (other)", len(d.remote))
	}
	return fmt.Sprintf("%d (%s)", len(d.remote), strings.Join(parts, ", "))
}

// result is the machine-readable outcome of one test run.
type result struct {
	Label          string   `json:"label,omitempty"`
	Room           string   `json:"room"`
	Direct         bool     `json:"direct"`
	ICEFinal       string   `json:"iceFinal,omitempty"`
	ConnFinal      string   `json:"connFinal,omitempty"`
	Path           string   `json:"path,omitempty"`
	Local          string   `json:"local,omitempty"`
	Remote         string   `json:"remote,omitempty"`
	LocalCandidate []string `json:"localCandidates,omitempty"`
	RemoteCands    string   `json:"remoteCandidates,omitempty"`
	SrflxLearned   bool     `json:"srflxLearned"`
	ConnectedMs    int64    `json:"connectedMs"`
	RTPPkts        int64    `json:"rtpPkts"`
	Keyframes      int64    `json:"keyframes"`
	Bytes          int64    `json:"bytes"`
	Duration       float64  `json:"duration"`
	PPS            float64  `json:"pps"`
}

// anon removes network-identifying detail for safe sharing: any IP addresses,
// ports and the selected pair's addressing are stripped; types and counts stay
// (they are the diagnostics that matter). Room id is kept (it is a random token).
func (r result) anon() result {
	if p := strings.Fields(r.Path); len(p) >= 5 {
		r.Path = p[0] + " <-> " + p[3]
	}
	r.Local, r.Remote = "", ""
	lc := make([]string, 0, len(r.LocalCandidate))
	for _, c := range r.LocalCandidate {
		if i := strings.IndexByte(c, ' '); i >= 0 {
			c = c[:i]
		}
		lc = append(lc, c)
	}
	r.LocalCandidate = lc
	return r
}