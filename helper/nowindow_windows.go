//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// noWindow makes a console-subsystem child (gst-launch, gst-inspect, powershell) run
// without allocating a console window. The helper is GUI-subsystem (no console itself),
// so without this flag Windows creates a brand-new console for each console child — the
// "a terminal opens when the stream starts" bug.
func noWindow(cmd *exec.Cmd) {
	// 0x08000000 = CREATE_NO_WINDOW (not exposed by the syscall package).
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000}
}
