//go:build !windows

package main

import "os/exec"

// Non-Windows builds run in a console; no window suppression needed.
func noWindow(*exec.Cmd) {}
