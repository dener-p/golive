// webrtc-check: dev-only "stand-in viewer". Connects to a golive room the same way a
// browser tab would (signaling via WS, WebRTC answer, trickle ICE), receives the AV1
// RTP stream, and prints connection diagnostics. No AV1 decoding — counting RTP packets
// and decoding are separate things; browsers decode, this measures reachability.
//
// Also opens a host-role socket (needs the room key) to print live host status,
// including the per-viewer diagnostics the helper now reports.
//
// Use it as the seed of the NAT regression suite: run the helper on one network,
// this tool on another, and compare "direct vs failed" outcomes.
//
//	go run ./tools/webrtc-check -server http://localhost:8080 -room <id> -key <hostKey>
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"strings"
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
	flag.Parse()
	if *room == "" {
		log.Fatal("-room is required")
	}
	wsBase := strings.NewReplacer("http://", "ws://", "https://", "wss://").Replace(strings.TrimRight(*server, "/"))

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
		pkts  atomic.Int64
		byts  atomic.Int64
		keyf  atomic.Int64
		connAt atomic.Int64 // unix ms when connected
	)
	start := time.Now()

	var pc *webrtc.PeerConnection
	pc, err := api.NewPeerConnection(webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{{URLs: []string{
			"stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478",
		}}},
		ICETransportPolicy: webrtc.ICETransportPolicyAll,
	})
	if err != nil {
		log.Fatal(err)
	}
	pc.OnTrack(func(t *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		fmt.Printf("track: %s\n", t.Codec().MimeType)
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
	pc.OnICEConnectionStateChange(func(s webrtc.ICEConnectionState) {
		fmt.Printf("ICE: %s\n", s)
	})
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		fmt.Printf("PC: %s\n", s)
		if s == webrtc.PeerConnectionStateConnected {
			connAt.Store(time.Now().UnixMilli())
		}
	})

	u := fmt.Sprintf("%s/ws?role=viewer&room=%s", wsBase, url.QueryEscape(*room))
	ws, _, err := websocket.DefaultDialer.Dial(u, nil)
	if err != nil {
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
				ws.WriteJSON(map[string]any{"type": "signal", "data": map[string]any{"sdp": pc.LocalDescription()}})
			case d.Candidate != nil && remoteSet:
				pc.AddICECandidate(*d.Candidate)
			}
		}
	}()

	deadline := time.After(time.Duration(*secs) * time.Second)
	<-deadline

	ws.Close()
	pc.Close()
	<-readDone

	dur := time.Since(start).Seconds()
	fmt.Printf("\nRESULT viewer=%s direct=%v connectedMs=%d rtpPkts=%d keyframes=%d bytes=%d duration=%.1fs rate=%.0f pps\n",
		*room, connAt.Load() > 0, connAt.Load()-start.UnixMilli(), pkts.Load(), keyf.Load(), byts.Load(), dur,
		float64(pkts.Load())/dur)
	if pkts.Load() == 0 {
		os.Exit(1)
	}
}