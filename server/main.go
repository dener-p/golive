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
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// loadEnv reads a .env file (KEY=VALUE lines, # comments, optional quotes) into the
// process environment. Already-set variables win. Looked up next to the executable,
// then server/.env, then .env in the working directory. Missing file is fine.
func loadEnv() {
	for _, p := range []string{
		filepath.Join(filepath.Dir(os.Args[0]), ".env"),
		"server/.env",
		".env",
	} {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(b), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			eq := strings.Index(line, "=")
			if eq <= 0 {
				continue
			}
			k := strings.TrimSpace(line[:eq])
			v := strings.Trim(strings.TrimSpace(line[eq+1:]), `"'`)
			if os.Getenv(k) == "" {
				os.Setenv(k, v)
			}
		}
		log.Printf("loaded env file: %s", p)
		return
	}
}

//go:embed index.html
var indexHTML []byte

//go:embed public/favicon.png
var faviconPNG []byte

type client struct {
	ws   *websocket.Conn
	mu   sync.Mutex
	id   string
	user *discordUser // Discord identity when the browser sent a valid session cookie
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
	sources json.RawMessage
	live    bool
}

var (
	roomsMu sync.Mutex
	rooms   = map[string]*room{}
	nextID  int
	up      = websocket.Upgrader{ReadBufferSize: 1 << 16, WriteBufferSize: 1 << 16}
	db      *store
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
	var info any = r.status
	if enriched, err := enrichViewerIdentity(r.status, r.viewers); err == nil {
		info = enriched
	}
	return map[string]any{"type": "status", "helper": true, "info": info}
}

// enrichViewerIdentity overlays the server's session knowledge onto the helper's status
// viewer rows: a viewer who signed in with Discord shows a {id,name,avatar} identity, so
// the host table can render a badge. Unknown/anonymous viewers are left untouched.
func enrichViewerIdentity(raw json.RawMessage, viewers map[string]*client) (any, error) {
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return raw, err
	}
	vs, ok := obj["viewers"].([]any)
	if !ok {
		return obj, nil
	}
	for _, v := range vs {
		row, ok := v.(map[string]any)
		if !ok {
			continue
		}
		id, _ := row["id"].(string)
		if c := viewers[id]; c != nil && c.user != nil {
			row["identity"] = map[string]any{
				"id": c.user.ID, "name": c.user.displayName(), "avatar": c.user.Avatar,
			}
		}
	}
	return obj, nil
}

// GET /api/owner?room=<id> — public streamer identity for the watch page ("who is
// streaming"). Channel info, not a secret.
func handleOwnerInfo(w http.ResponseWriter, r *http.Request) {
	room := r.URL.Query().Get("room")
	if room == "" {
		http.Error(w, "missing room", 400)
		return
	}
	id, name, avatar, claimed := db.ownerInfo(room)
	json.NewEncoder(w).Encode(map[string]any{"claimed": claimed, "id": id, "name": name, "avatar": avatar})
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
		owns := r.hostKey != "" && key == r.hostKey
		if !owns {
			if u := sessionUser(req); u == nil || db.owner(roomID) != u.ID {
				r.mu.Unlock()
				http.Error(w, "host auth required: room key or Discord owner", 403)
				return
			}
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
	// A browser that carried a golive_session cookie gets its Discord identity attached;
	// the host table and any future UI can show it without exposing sessions.
	if u := sessionUser(req); u != nil {
		c.user = u
	}
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
		if err := db.saveHostKey(roomID, key); err != nil {
			log.Printf("[%s] host key persist failed: %v", roomID, err)
		}
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
			case "sources":
				r.sources = m.Data
				for h := range r.hosts {
					h.send(map[string]any{"type": "sources", "data": r.sources})
				}
			}
			r.mu.Unlock()
		}

	case "host":
		r.mu.Lock()
		r.hosts[c] = true
		c.send(r.hostStatus())
		if r.sources != nil {
			c.send(map[string]any{"type": "sources", "data": r.sources})
		}
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
	loadEnv()
	addr := flag.String("addr", ":8080", "listen address")
	discordID := flag.String("discord-id", envOr("GOLIVE_DISCORD_ID", ""), "Discord OAuth client id (enables Discord host login)")
	discordSecret := flag.String("discord-secret", envOr("GOLIVE_DISCORD_SECRET", ""), "Discord OAuth client secret")
	publicURL := flag.String("public-url", envOr("GOLIVE_PUBLIC_URL", "https://golive.puhl.dev"), "public base URL for the callback + post-login redirects")
	dbPath := flag.String("db", envOr("GOLIVE_DB", "golive.db"), "SQLite path for rooms/sessions (local store)")
	tursoURL := flag.String("turso-url", envOr("GOLIVE_DB_URL", ""), "Turso/libSQL URL; enables the remote store (token via GOLIVE_TURSO_TOKEN)")
	tursoToken := flag.String("turso-token", envOr("GOLIVE_TURSO_TOKEN", ""), "Turso auth token")
	flag.Parse()

	if (*tursoURL == "") != (*tursoToken == "") {
		log.Fatal("both -turso-url and -turso-token are required together (or neither)")
	}

	var err error
	if db, err = openStore(*dbPath, *tursoURL, *tursoToken); err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer db.close()
	if *tursoURL != "" {
		host := *tursoURL
		if u, perr := url.Parse(*tursoURL); perr == nil && u.Host != "" {
			host = u.Host
		}
		log.Printf("store: turso (%s)", host)
	} else {
		log.Printf("store: sqlite %s", *dbPath)
	}
	oauthCfg = newOAuthConfig(*discordID, *discordSecret, *publicURL)
	if oauthCfg.enabled {
		log.Printf("discord oauth enabled; redirect_uri=%s", oauthCfg.redirectURI)
	} else {
		log.Printf("discord oauth disabled (no -discord-id/-discord-secret); printed-key gate only")
	}

	favicon := func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write(faviconPNG)
	}
	page := func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(indexHTML)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/favicon.ico", favicon)
	mux.HandleFunc("/favicon.png", favicon)
	mux.HandleFunc("/ws", wsHandler)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, "ok") })
	mux.HandleFunc("/auth/config", handleAuthConfig)
	mux.HandleFunc("/auth/me", handleAuthMe)
	mux.HandleFunc("/auth/discord/login", availability(handleDiscordLogin))
	mux.HandleFunc("/auth/discord/callback", availability(handleDiscordCallback))
	mux.HandleFunc("/api/owner", handleOwnerInfo)
	mux.HandleFunc("/watch/", page)
	mux.HandleFunc("/host/", page)
	mux.HandleFunc("/api/helper/latest", handleHelperLatest)
	mux.HandleFunc("/api/helper/download", handleHelperDownload)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.Trim(r.URL.Path, "/") != "" {
			http.NotFound(w, r)
			return
		}
		landingHandler(w, r)
	})
	registerHelperStatic(mux)
	log.Printf("listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
