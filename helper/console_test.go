package main

import (
	"path/filepath"
	"testing"
)

func TestWantTray(t *testing.T) {
	cases := []struct {
		name       string
		flagVal    bool // the -tray flag value
		explicit   bool // whether the user actually passed -tray
		hasConsole bool
		want       bool
	}{
		{"explicit on, console", true, true, true, true},
		{"explicit on, no console", true, true, false, true},
		{"explicit off, console", false, true, true, false},
		{"explicit off wins over hidden", false, true, false, false},
		{"default, console (dev build)", false, false, true, false},
		{"default, no console (packaged build)", false, false, false, true},
	}
	for _, c := range cases {
		if got := wantTray(c.flagVal, c.explicit, c.hasConsole); got != c.want {
			t.Errorf("%s: wantTray(%v,%v,%v) = %v, want %v",
				c.name, c.flagVal, c.explicit, c.hasConsole, got, c.want)
		}
	}
}

func TestLogPathIsGoliveHelperLog(t *testing.T) {
	p := logPath()
	if p == "" {
		t.Fatal("logPath returned empty")
	}
	if filepath.Base(p) != "helper.log" {
		t.Fatalf("logPath = %q, want it to end in helper.log", p)
	}
	if filepath.Base(filepath.Dir(p)) != "golive" {
		t.Fatalf("logPath = %q, want a golive subdirectory", p)
	}
}
