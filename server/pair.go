package main

// Short-code room binding ("pairing").
//
// The helper proves physical access to a room by presenting {room, key} — the same key it
// uses to join /ws. The server mints a short, single-use code. A Discord-authenticated host
// page for the same room can redeem it, claiming ownership without the user ever handling
// the printed key. Codes expire in 5 minutes and a new request for the same room invalidates
// the previous code.

import (
	"crypto/rand"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"
)

const (
	pairCodeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789" // no 0/O/1/I/L
	pairCodeLen      = 6
	pairTTL          = 5 * time.Minute
)

type pair struct {
	room string
	key  string
	exp  time.Time
}

type pairStore struct {
	mu     sync.Mutex
	byCode map[string]*pair
	byRoom map[string]string // room -> active code
}

func newPairStore() *pairStore {
	return &pairStore{byCode: map[string]*pair{}, byRoom: map[string]string{}}
}

// mint issues (or replaces) a code for room, which the caller has already proven possession
// of. Returns the code and its expiry.
func (p *pairStore) mint(room, key string) (string, time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if old := p.byRoom[room]; old != "" {
		delete(p.byCode, old)
	}
	var raw [pairCodeLen]byte
	rand.Read(raw[:])
	code := make([]byte, pairCodeLen)
	for i, b := range raw {
		code[i] = pairCodeAlphabet[int(b)%len(pairCodeAlphabet)]
	}
	exp := time.Now().Add(pairTTL)
	c := string(code)
	p.byCode[c] = &pair{room: room, key: key, exp: exp}
	p.byRoom[room] = c
	return c, exp
}

// redeem returns the pairing entry's key only for an exact code+room match that hasn't
// expired, consuming it (single-use).
func (p *pairStore) redeem(code, room string) (key string, ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	e, found := p.byCode[code]
	if !found || e.room != room || time.Now().After(e.exp) {
		return "", false
	}
	delete(p.byCode, code)
	if p.byRoom[room] == code {
		delete(p.byRoom, room)
	}
	return e.key, true
}

var pairing = newPairStore()

// POST /api/pair/request {room, key} — called by the helper. Key must match the room's
// host key (the same physical-access proof /ws uses). Returns {code, expiresIn}.
func handlePairRequest(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Room string `json:"room"`
		Key  string `json:"key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if in.Key == "" {
		http.Error(w, "room key required", http.StatusForbidden)
		return
	}
	rm := getRoom(in.Room, false)
	ok := false
	if rm != nil {
		rm.mu.Lock()
		ok = rm.hostKey != "" && rm.hostKey == in.Key
		rm.mu.Unlock()
	}
	if !ok {
		http.Error(w, "unknown room or key mismatch", http.StatusForbidden)
		return
	}
	code, exp := pairing.mint(in.Room, in.Key)
	json.NewEncoder(w).Encode(map[string]any{
		"code": code, "expiresIn": int(time.Until(exp).Seconds()),
	})
}

// POST /api/pair/claim {code, room} — called by the host page under a Discord session.
// A valid code claims the room for the signed-in user (same trust as holding the printed
// key: the code is minted by the helper that physically holds the room).
func handlePairClaim(w http.ResponseWriter, r *http.Request) {
	u := sessionUser(r)
	if u == nil {
		http.Error(w, "sign in with Discord first", http.StatusUnauthorized)
		return
	}
	var in struct {
		Code string `json:"code"`
		Room string `json:"room"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	key, ok := pairing.redeem(in.Code, in.Room)
	if !ok {
		http.Error(w, "invalid, expired, or mismatched pairing code", http.StatusForbidden)
		return
	}
	claimed, err := db.claim(in.Room, key, *u)
	if err != nil {
		log.Printf("[%s] pair claim failed: %v", in.Room, err)
		http.Error(w, "claim failed", http.StatusInternalServerError)
		return
	}
	if !claimed {
		http.Error(w, "room key mismatch", http.StatusForbidden)
		return
	}
	log.Printf("[%s] room bound via pairing code by discord user %s", in.Room, u.ID)
	json.NewEncoder(w).Encode(map[string]any{"claimed": true, "room": in.Room})
}
