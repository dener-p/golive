// golive server: static page + WebSocket signaling/control relay. Carries no media.
//
//	helper  --ws--> server <--ws-- host page   (start/stop commands, status)
//	                server <--ws-- viewer page (SDP/ICE relay to/from helper)
package main

import (
	_ "embed"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

//go:embed index.html
var indexHTML []byte

type client struct {
	ws *websocket.Conn
	mu sync.Mutex
	id string
}

func (c *client) send(v any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if err := c.ws.WriteJSON(v); err != nil {
		c.ws.Close()
	}
}

type room struct {
	mu      sync.Mutex
	hostKey string
	helper  *client
	hosts   map[*client]bool
	viewers map[string]*client
	status  json.RawMessage
	live    bool
}

var (
	roomsMu sync.Mutex
	rooms   = map[string]*room{}
	nextID  int
	up      = websocket.Upgrader{ReadBufferSize: 1 << 16, WriteBufferSize: 1 << 16}
)

func getRoom(id string, create bool) *room {
	roomsMu.Lock()
	defer roomsMu.Unlock()
	r := rooms[id]
	if r == nil && create {
		r = &room{hosts: map[*client]bool{}, viewers: map[string]*client{}}
		rooms[id] = r
	}
	return r
}

func (r *room) viewerStatus() any {
	return map[string]any{"type": "status", "helper": r.helper != nil, "live": r.live}
}

func (r *room) hostStatus() any {
	if r.helper == nil {
		return map[string]any{"type": "status", "helper": false}
	}
	return map[string]any{"type": "status", "helper": true, "info": r.status}
}

func (r *room) broadcast() { // caller holds r.mu
	for h := range r.hosts {
		h.send(r.hostStatus())
	}
	for _, v := range r.viewers {
		v.send(r.viewerStatus())
	}
}

func wsHandler(w http.ResponseWriter, req *http.Request) {
	q := req.URL.Query()
	role, roomID, key := q.Get("role"), q.Get("room"), q.Get("key")
	if roomID == "" || len(roomID) > 64 {
		http.Error(w, "bad room", 400)
		return
	}
	r := getRoom(roomID, role == "helper")
	if r == nil {
		if role == "viewer" { // viewer may arrive before the helper ever did: create lazily
			r = getRoom(roomID, true)
		} else {
			http.Error(w, "unknown room", 404)
			return
		}
	}

	// Cheap capability check (not real auth): the host page URL carries the helper's key.
	r.mu.Lock()
	switch role {
	case "helper":
		if key == "" || (r.helper != nil && r.hostKey != key) {
			r.mu.Unlock()
			http.Error(w, "room taken", 409)
			return
		}
	case "host":
		if key == "" || key != r.hostKey {
			r.mu.Unlock()
			http.Error(w, "bad host key", 403)
			return
		}
	case "viewer":
	default:
		r.mu.Unlock()
		http.Error(w, "bad role", 400)
		return
	}
	r.mu.Unlock()

	ws, err := up.Upgrade(w, req, nil)
	if err != nil {
		return
	}
	c := &client{ws: ws}
	defer ws.Close()

	// keepalive
	ws.SetReadDeadline(time.Now().Add(60 * time.Second))
	ws.SetPongHandler(func(string) error { ws.SetReadDeadline(time.Now().Add(60 * time.Second)); return nil })
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		t := time.NewTicker(20 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				c.mu.Lock()
				err := ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
				c.mu.Unlock()
				if err != nil {
					return
				}
			}
		}
	}()

	switch role {
	case "helper":
		r.mu.Lock()
		if r.helper != nil {
			r.helper.ws.Close() // same key: newer helper replaces the older one
		}
		r.helper, r.hostKey, r.status, r.live = c, key, nil, false
		for id := range r.viewers {
			c.send(map[string]any{"type": "viewer-join", "viewer": id})
		}
		r.broadcast()
		r.mu.Unlock()
		log.Printf("[%s] helper online", roomID)
		defer func() {
			r.mu.Lock()
			if r.helper == c {
				r.helper, r.status, r.live = nil, nil, false
				r.broadcast()
			}
			r.mu.Unlock()
			log.Printf("[%s] helper offline", roomID)
			cleanup(roomID, r)
		}()
		for {
			var m struct {
				Type   string          `json:"type"`
				Viewer string          `json:"viewer"`
				Data   json.RawMessage `json:"data"`
			}
			raw := json.RawMessage{}
			if err := ws.ReadJSON(&raw); err != nil {
				return
			}
			if json.Unmarshal(raw, &m) != nil {
				continue
			}
			r.mu.Lock()
			switch m.Type {
			case "status":
				var s struct {
					Streaming bool `json:"streaming"`
				}
				json.Unmarshal(raw, &s)
				changed := s.Streaming != r.live
				r.status, r.live = raw, s.Streaming
				for h := range r.hosts {
					h.send(r.hostStatus())
				}
				if changed {
					for _, v := range r.viewers {
						v.send(r.viewerStatus())
					}
				}
			case "to-viewer":
				if v := r.viewers[m.Viewer]; v != nil {
					v.send(map[string]any{"type": "signal", "data": m.Data})
				}
			}
			r.mu.Unlock()
		}

	case "host":
		r.mu.Lock()
		r.hosts[c] = true
		c.send(r.hostStatus())
		r.mu.Unlock()
		defer func() {
			r.mu.Lock()
			delete(r.hosts, c)
			r.mu.Unlock()
			cleanup(roomID, r)
		}()
		for {
			var m map[string]any
			if err := ws.ReadJSON(&m); err != nil {
				return
			}
			if m["type"] != "cmd" {
				continue
			}
			r.mu.Lock()
			if r.helper != nil {
				r.helper.send(m) // relayed as-is: {"type":"cmd","cmd":"start","params":{...}}
			} else {
				c.send(map[string]any{"type": "error", "message": "helper is offline"})
			}
			r.mu.Unlock()
		}

	case "viewer":
		r.mu.Lock()
		nextID++
		c.id = "v" + strconv.Itoa(nextID)
		r.viewers[c.id] = c
		c.send(map[string]any{"type": "hello", "id": c.id})
		c.send(r.viewerStatus())
		if r.helper != nil {
			r.helper.send(map[string]any{"type": "viewer-join", "viewer": c.id})
		}
		r.mu.Unlock()
		defer func() {
			r.mu.Lock()
			delete(r.viewers, c.id)
			if r.helper != nil {
				r.helper.send(map[string]any{"type": "viewer-leave", "viewer": c.id})
			}
			r.mu.Unlock()
			cleanup(roomID, r)
		}()
		for {
			var m struct {
				Type string          `json:"type"`
				Data json.RawMessage `json:"data"`
			}
			if err := ws.ReadJSON(&m); err != nil {
				return
			}
			if m.Type == "signal" {
				r.mu.Lock()
				if r.helper != nil {
					r.helper.send(map[string]any{"type": "signal", "viewer": c.id, "data": m.Data})
				}
				r.mu.Unlock()
			}
		}
	}
}

func cleanup(id string, r *room) {
	roomsMu.Lock()
	defer roomsMu.Unlock()
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.helper == nil && len(r.hosts) == 0 && len(r.viewers) == 0 {
		delete(rooms, id)
	}
}

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	flag.Parse()
	page := func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(indexHTML)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", wsHandler)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, "ok") })
	mux.HandleFunc("/watch/", page)
	mux.HandleFunc("/host/", page)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.Trim(r.URL.Path, "/") != "" {
			http.NotFound(w, r)
			return
		}
		page(w, r)
	})
	log.Printf("listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
