package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Store tests exercise the exact queries the app uses, against both backends.
// The Turso test runs only when GOLIVE_DB_URL + GOLIVE_TURSO_TOKEN are in the
// environment (e.g. via server/.env) and cleans up its own rows.

func TestStoreLocalRoundTrip(t *testing.T) {
	db, err := openStore(filepath.Join(t.TempDir(), "t.db"), "", "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.close()

	if err := db.saveHostKey("roomA", "keyA"); err != nil {
		t.Fatal(err)
	}
	if got := db.hostKey("roomA"); got != "keyA" {
		t.Fatalf("hostKey=%q", got)
	}
	if ok, err := db.claim("roomA", "wrong", discordUser{ID: "u1", Username: "Derp"}); err != nil {
		t.Fatal(err)
	} else if ok {
		t.Fatal("claim with wrong key must fail")
	}
	if ok, err := db.claim("roomA", "keyA", discordUser{ID: "u1", Username: "Derp", Avatar: "hash123"}); err != nil {
		t.Fatal(err)
	} else if !ok {
		t.Fatal("claim with right key must succeed")
	}
	if got := db.owner("roomA"); got != "u1" {
		t.Fatalf("owner=%q", got)
	}
	oid, name, avatar, claimed := db.ownerInfo("roomA")
	if !claimed || oid != "u1" || name != "Derp" || avatar != "hash123" {
		t.Fatalf("ownerInfo=%q %q %q %v", oid, name, avatar, claimed)
	}
	if _, _, _, claimed := db.ownerInfo("nope"); claimed {
		t.Fatal("unknown room must not be claimed")
	}

	if err := db.upsertSession("tok1", "u1", "Derp", "av", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	u := db.session("tok1")
	if u == nil || u.ID != "u1" || u.displayName() != "Derp" {
		t.Fatalf("session=%+v", u)
	}
	if db.session("nope") != nil {
		t.Fatal("unknown token must yield nil")
	}
}

func TestStoreTursoRoundTrip(t *testing.T) {
	url, tok := os.Getenv("GOLIVE_DB_URL"), os.Getenv("GOLIVE_TURSO_TOKEN")
	if url == "" || tok == "" {
		t.Skip("GOLIVE_DB_URL/GOLIVE_TURSO_TOKEN not set (server/.env or export them)")
	}
	db, err := openStore("", url, tok)
	if err != nil {
		t.Fatal(err)
	}
	defer db.close()

	id := "selftest-" + time.Now().Format("150405")
	defer func() {
		db.db.Exec("DELETE FROM rooms WHERE id = ?", id)
		db.db.Exec("DELETE FROM sessions WHERE token = ?", "tok-"+id)
	}()

	if err := db.saveHostKey(id, "kt"); err != nil {
		t.Fatal(err)
	}
	if got := db.hostKey(id); got != "kt" {
		t.Fatalf("hostKey=%q", got)
	}
	if ok, err := db.claim(id, "kt", discordUser{ID: "discord-1", Username: "TursoTester", Avatar: "av1"}); err != nil {
		t.Fatal(err)
	} else if !ok {
		t.Fatal("claim must succeed")
	}
	if got := db.owner(id); got != "discord-1" {
		t.Fatalf("owner=%q", got)
	}
	oid, name, avatar, claimed := db.ownerInfo(id)
	if !claimed || oid != "discord-1" || name != "TursoTester" || avatar != "av1" {
		t.Fatalf("ownerInfo=%q %q %q %v", oid, name, avatar, claimed)
	}
	if err := db.upsertSession("tok-"+id, "discord-1", "n", "", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if u := db.session("tok-" + id); u == nil || u.ID != "discord-1" {
		t.Fatalf("session=%+v", u)
	}
}
