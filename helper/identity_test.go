package main

import (
	"os"
	"path/filepath"
	"testing"
)

// loadIdentity must only persist identities it generated. Explicit -room/-key flags are a
// transient override: writing them back to the file would let a one-off run permanently
// rebrand the user's stored room.
func TestLoadIdentityPersistsOnlyWhenGenerated(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("APPDATA", dir)         // windows os.UserConfigDir
	t.Setenv("XDG_CONFIG_HOME", dir) // unix os.UserConfigDir
	identity := filepath.Join(dir, "golive", "identity")

	// Explicit flags, no file: used as given, NOT persisted.
	room, key := loadIdentity("explicitroom", "explicitkey")
	if room != "explicitroom" || key != "explicitkey" {
		t.Fatalf("flags not honored: %q %q", room, key)
	}
	if _, err := os.Stat(identity); !os.IsNotExist(err) {
		t.Fatal("explicit identity must not be written to disk")
	}

	// No flags, no file: generated and persisted.
	room, key = loadIdentity("", "")
	if room == "" || key == "" {
		t.Fatal("expected a generated identity")
	}
	b, err := os.ReadFile(identity)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != room+" "+key {
		t.Fatalf("identity file = %q, want %q", string(b), room+" "+key)
	}

	// No flags, file present: reused unchanged.
	room2, key2 := loadIdentity("", "")
	if room2 != room || key2 != key {
		t.Fatalf("stored identity not reused: %q %q", room2, key2)
	}

	// Explicit flags, file present: transient override, file untouched.
	room, key = loadIdentity("newroom", "newkey")
	if room != "newroom" || key != "newkey" {
		t.Fatalf("flags not honored over file: %q %q", room, key)
	}
	if b, _ := os.ReadFile(identity); string(b) == "newroom newkey" {
		t.Fatal("explicit identity must not overwrite the stored identity")
	}
}
