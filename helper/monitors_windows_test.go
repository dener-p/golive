//go:build windows

package main

import "testing"

func TestEnumMonitors(t *testing.T) {
	ms := enumMonitors()
	t.Logf("monitors: %#v", ms)
	if len(ms) == 0 {
		t.Fatal("no monitors enumerated")
	}
}
