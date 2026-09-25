//go:build !windows

package main

// Non-Windows: no monitor picker yet (Windows-first per v1 scope). The host UI
// falls back to a plain "Screen" source.

func enumMonitors() []monitorInfo {
	return nil
}
