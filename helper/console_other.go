//go:build !windows

package main

// Non-Windows builds always run with a console (or no UI at all): no tray, no hidden mode.
func consoleVisible() bool { return true }
