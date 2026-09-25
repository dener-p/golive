package main

// Short-code room binding client.
//
// Asks the server for a fresh pairing code (the helper proves physical access by presenting
// the same {room, key} it uses for /ws), refreshes it on a timer so whatever is shown stays
// live, and hands it to the UI (tray label, console line) via onPairCode.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

const pairRefreshEvery = 4 * time.Minute

type pairState struct {
	code string
	exp  time.Time
}

var (
	currentPair atomic.Value // pairState
	onPairCode  = func(string) {}
)

// startPairRefresh kicks off the pairing-code loop. Failures are logged once and retried on
// the next tick; a missing server just means the code stays unavailable.
func (h *helper) startPairRefresh() {
	currentPair.Store(pairState{})
	h.refreshPair()
	go func() {
		t := time.NewTicker(pairRefreshEvery)
		defer t.Stop()
		for range t.C {
			h.refreshPair()
		}
	}()
}

func (h *helper) refreshPair() {
	base := strings.NewReplacer("ws://", "http://", "wss://", "https://").Replace(h.server)
	body, _ := json.Marshal(map[string]string{"room": h.room, "key": h.key})
	resp, err := http.Post(base+"/api/pair/request", "application/json", bytes.NewReader(body))
	if err != nil {
		logf("pairing code unavailable: %v", err)
		onPairCode("")
		return
	}
	defer resp.Body.Close()
	var out struct {
		Code      string `json:"code"`
		ExpiresIn int    `json:"expiresIn"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&out) != nil || out.Code == "" {
		onPairCode("")
		return
	}
	currentPair.Store(pairState{code: out.Code, exp: time.Now().Add(time.Duration(out.ExpiresIn) * time.Second)})
	logf("pairing code: %s — bind this room at %s/host/%s", out.Code, base, h.room)
	onPairCode(out.Code)
}

func (h *helper) currentCode() string {
	s, _ := currentPair.Load().(pairState)
	return s.code
}
