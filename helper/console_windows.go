//go:build windows

package main

import "syscall"

// consoleVisible reports whether this process has a console window attached. The dev
// (console-subsystem) build always has one; the packaged build is linked as a GUI
// subsystem (-H=windowsgui) and never does. main() uses this to auto-enable the tray and
// route logs to helper.log — otherwise the packaged helper would run as an invisible,
// un-driveable process.
func consoleVisible() bool {
	kernel32, err := syscall.LoadDLL("kernel32.dll")
	if err != nil {
		return true // be conservative: fall back to console-literate behavior
	}
	proc, err := kernel32.FindProc("GetConsoleWindow")
	if err != nil {
		return true
	}
	hwnd, _, _ := proc.Call()
	return hwnd != 0
}
