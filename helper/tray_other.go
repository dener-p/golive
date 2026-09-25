//go:build !windows

package main

// Non-Windows stub: no tray. boot() runs inline in the console.

func serveTray(_ *helper, inBackground func()) {
	inBackground()
}
