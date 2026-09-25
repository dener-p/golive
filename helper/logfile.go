package main

// Runtime log for the packaged helper. The packaged build is linked as a GUI subsystem
// (no console window at all), so logs land here instead of a terminal. Same directory as
// the identity file: %APPDATA%\golive\helper.log.

import (
	"os"
	"path/filepath"
)

// logPath is where the helper appends its runtime log when no console is visible
// (packaged GUI-subsystem build). It also covers plain console "-tray" runs, so a dev
// running the tray on a console build gets both on-screen output and a persistent file.
func logPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "golive", "helper.log")
}

// openLogFile opens helper.log for appending, creating the golive config dir if needed.
// It returns nil on failure — logging then falls back to the default logger target
// (stderr), which on a GUI-subsystem build is an invalid handle that simply discards.
func openLogFile() *os.File {
	p := logPath()
	if p == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return nil
	}
	f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return nil
	}
	return f
}
