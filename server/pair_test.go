package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func TestPairStoreMintRedeem(t *testing.T) {
	p := newPairStore()

	code, exp := p.mint("r1", "k1")
	if len(code) != pairCodeLen {
		t.Fatalf("code length = %d", len(code))
	}
	if time.Until(exp) < pairTTL-time.Second {
		t.Fatalf("expiry too short: %v", time.Until(exp))
	}
	for _, c := range code {
		if !bytes.ContainsRune([]byte(pairCodeAlphabet), c) {
			t.Fatalf("code has char outside alphabet: %q", c)
		}
	}

	// wrong room / wrong code / exhausted
	if _, ok := p.redeem(code, "r2"); ok {
		t.Fatal("redeem with wrong room must fail")
	}
	if _, ok := p.redeem("ZZZZZZ", "r1"); ok {
		t.Fatal("redeem with wrong code must fail")
	}
	if key, ok := p.redeem(code, "r1"); !ok || key != "k1" {
		t.Fatalf("redeem = %q %v", key, ok)
	}
	if _, ok := p.redeem(code, "r1"); ok {
		t.Fatal("code must be single-use")
	}

	// mint again for the same room invalidates the previous code
	c1, _ := p.mint("r1", "k1")
	c2, _ := p.mint("r1", "k1")
	if c1 == c2 {
		t.Fatal("expected two distinct codes")
	}
	if _, ok := p.redeem(c1, "r1"); ok {
		t.Fatal("refreshing must invalidate the previous code")
	}
	if key, ok := p.redeem(c2, "r1"); !ok || key != "k1" {
		t.Fatalf("fresh code redeem = %q %v", key, ok)
	}
}

func TestPairHandlersEndToEnd(t *testing.T) {
	st, err := openStore(filepath.Join(t.TempDir(), "t.db"), "", "")
	if err != nil {
		t.Fatal(err)
	}
	defer st.close()
	db = st
	oauthCfg = &oauthConfig{enabled: true, publicURL: "https://golive.puhl.dev"}

	const roomID, roomKey = "pairroom01", "roomkey01"
	if err := db.saveHostKey(roomID, roomKey); err != nil {
		t.Fatal(err)
	}
	rm := getRoom(roomID, true)
	rm.mu.Lock()
	rm.hostKey = roomKey
	rm.mu.Unlock()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/pair/request", handlePairRequest)
	mux.HandleFunc("/api/pair/claim", handlePairClaim)

	post := func(path, body string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", path, bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		for _, c := range cookies {
			req.AddCookie(c)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}

	// helper requests a code with the correct key
	rec := post("/api/pair/request", `{"room":"pairroom01","key":"roomkey01"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("request code: %d (%s)", rec.Code, rec.Body.String())
	}
	var got struct{ Code string }
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || got.Code == "" {
		t.Fatalf("no code in response: %v", rec.Body.String())
	}

	// wrong key cannot mint
	if rec := post("/api/pair/request", `{"room":"pairroom01","key":"nope"}`); rec.Code != http.StatusForbidden {
		t.Fatalf("wrong key must be forbidden, got %d", rec.Code)
	}

	// claim without a session is rejected
	if rec := post("/api/pair/claim", `{"code":"`+got.Code+`","room":"pairroom01"}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("claim without session: got %d", rec.Code)
	}

	// sign in, then claim
	tok, err := newSession(discordUser{ID: "u-pair-1", Username: "PairCase", Avatar: "av"})
	if err != nil {
		t.Fatal(err)
	}
	cookie := &http.Cookie{Name: "golive_session", Value: tok, Path: "/"}
	if rec := post("/api/pair/claim", `{"code":"`+got.Code+`","room":"pairroom01"}`, cookie); rec.Code != http.StatusOK {
		t.Fatalf("claim: got %d (%s)", rec.Code, rec.Body.String())
	}
	if owner := db.owner(roomID); owner != "u-pair-1" {
		t.Fatalf("owner = %q", owner)
	}

	// the code is consumed: second claim fails
	if rec := post("/api/pair/claim", `{"code":"`+got.Code+`","room":"pairroom01"}`, cookie); rec.Code != http.StatusForbidden {
		t.Fatalf("reused code must be forbidden, got %d", rec.Code)
	}

	// a real Discord-authed host connection now owns the room without the key
	if owns := db.owner(roomID) == "u-pair-1"; !owns {
		t.Fatal("owner mismatch after pairing")
	}
}
